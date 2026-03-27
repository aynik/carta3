import { roundToEvenI32 } from "../common/math.js";
import {
  AT3_CHCONV_ACC_BIAS,
  AT3_CHCONV_ACC_DECAY,
  AT3_CHCONV_SCALE_A,
  AT3_CHCONV_SCALE_B,
  AT3_CHCONV_SUM_BIAS,
  AT3_CHCONV_SUM_THRESHOLD,
  AT3_CHCONV_OUT_SCALE,
  AT3_CHCONV_RATIO_SCALE,
} from "./encode-tables.js";

export const AT3_CHCONV_SLOT_COUNT = 4;
export const AT3_CHCONV_SLOT_STRIDE = 4;
export const AT3_CHCONV_SLOT_SAMPLES = 0x100;
export const AT3_CHCONV_MIX_LEVEL_STEP = 0.05;
export const AT3_CHCONV_MIX_LEVEL_FALLBACK = 1.6666666269302368;
export const AT3_CHCONV_DOMINANCE_RATIO_LIMIT = 3.94;
export const AT3_CHCONV_DOMINANCE_RATIO_MAX = 256;
export const AT3_CHCONV_MIX_LEVEL_SCALE = 1.680272102355957;
export const AT3_CHCONV_RAMP_BANDS = 8;
export const AT3_CHCONV_RAMP_STEP = 1 / AT3_CHCONV_RAMP_BANDS;
export const AT3_CHCONV_MODE_SECONDARY_DOMINANT = 0;
export const AT3_CHCONV_MODE_PRIMARY_DOMINANT = 1;
export const AT3_CHCONV_MODE_LEGACY_OPEN_PASSTHROUGH = 2;
export const AT3_CHCONV_MODE_BALANCED = 3;
export const AT3_CHCONV_OPEN_MIX_DIRECTION_BIT = 0x8;
export const AT3_CHCONV_OPEN_MIX_MAGNITUDE_MASK = 0x7;
export const AT3_CHCONV_INITIAL_OPEN_MIX_CODE = 0x0f;

/**
 * Per-slot ATRAC3 stereo conversion state.
 *
 * @typedef {object} Atrac3ChannelConversionSlotState
 * @property {number} modeHint Previous slot mode reused during transition ramps.
 * @property {number} mode Current slot coding mode chosen for this frame. The
 *   legacy open-slot passthrough mode may still survive on resumed state even
 *   though new analysis does not emit it.
 * @property {number} mixLevel Current limited-slot side gain.
 * @property {{ primary: number, secondary: number }} magnitudeSums Measured
 *   per-slot magnitudes for the current frame.
 */

/**
 * ATRAC3 stereo conversion state shared across frame analysis and packing.
 *
 * @typedef {object} Atrac3ChannelConversionState
 * @property {number} slotLimit Slot boundary between limited and open mixing.
 * @property {Atrac3ChannelConversionSlotState[]} slots Per-slot mode history.
 * @property {{ previous: number, current: number }} mixCode Open-slot mix code
 *   carried across frames.
 */

export function clampChannelConversionSlotLimit(slotLimit) {
  return Math.max(0, Math.min(Math.trunc(slotLimit), AT3_CHCONV_SLOT_COUNT));
}

function resolveChannelConversionSlotMode(
  previousMode,
  usesLimitedMix,
  primaryMagnitude,
  secondaryMagnitude
) {
  const primaryLimit =
    usesLimitedMix && previousMode === AT3_CHCONV_MODE_SECONDARY_DOMINANT
      ? AT3_CHCONV_SCALE_B
      : AT3_CHCONV_SCALE_A;
  const secondaryLimit =
    usesLimitedMix && previousMode === AT3_CHCONV_MODE_PRIMARY_DOMINANT
      ? AT3_CHCONV_SCALE_B
      : AT3_CHCONV_SCALE_A;
  const prefersSecondary =
    Number.isNaN(primaryLimit * primaryMagnitude) ||
    Number.isNaN(secondaryMagnitude) ||
    primaryLimit * primaryMagnitude < secondaryMagnitude;
  if (prefersSecondary) {
    return AT3_CHCONV_MODE_SECONDARY_DOMINANT;
  }

  const prefersPrimary =
    Number.isNaN(secondaryLimit * secondaryMagnitude) ||
    Number.isNaN(primaryMagnitude) ||
    secondaryLimit * secondaryMagnitude < primaryMagnitude;
  return prefersPrimary ? AT3_CHCONV_MODE_PRIMARY_DOMINANT : AT3_CHCONV_MODE_BALANCED;
}

function measureChannelConversionSlotMagnitudes(slotIndex, primaryBands, secondaryBands) {
  let primaryMagnitude = AT3_CHCONV_SUM_BIAS;
  let secondaryMagnitude = AT3_CHCONV_SUM_BIAS;

  for (
    let bandIndex = slotIndex, bandOffset = 0;
    bandOffset < AT3_CHCONV_SLOT_SAMPLES;
    bandIndex += AT3_CHCONV_SLOT_STRIDE, bandOffset += 1
  ) {
    primaryMagnitude += Math.abs(primaryBands[bandIndex]);
    secondaryMagnitude += Math.abs(secondaryBands[bandIndex]);
  }

  return {
    primary: primaryMagnitude,
    secondary: secondaryMagnitude,
  };
}

function resolveOpenMixCode(openPrimaryMagnitude, openSecondaryMagnitude) {
  const primaryDominatesOpenMix =
    !Number.isNaN(openPrimaryMagnitude) &&
    !Number.isNaN(openSecondaryMagnitude) &&
    openPrimaryMagnitude > openSecondaryMagnitude;
  const mixCodeHighBits = primaryDominatesOpenMix ? AT3_CHCONV_OPEN_MIX_DIRECTION_BIT : 0;
  const quieterOpenEnergy = primaryDominatesOpenMix ? openSecondaryMagnitude : openPrimaryMagnitude;
  const openMixRatio =
    quieterOpenEnergy * (AT3_CHCONV_RATIO_SCALE / (openPrimaryMagnitude + openSecondaryMagnitude));
  let openMixCode =
    mixCodeHighBits |
    (roundToEvenI32(openMixRatio * AT3_CHCONV_OUT_SCALE) & AT3_CHCONV_OPEN_MIX_MAGNITUDE_MASK);

  if ((openMixCode & AT3_CHCONV_OPEN_MIX_MAGNITUDE_MASK) === 0) {
    openMixCode += 1;
  }

  return openMixCode;
}

/**
 * Creates the ATRAC3 stereo channel-conversion runtime state.
 *
 * `slotLimit` splits the four interleaved QMF slots into limited mixed slots
 * (`slot < slotLimit`) and open-coded slots (`slot >= slotLimit`).
 *
 * @returns {Atrac3ChannelConversionState}
 */
export function createChannelConversionState(slotLimit = -1, { enabled = false } = {}) {
  const initialMode = enabled ? AT3_CHCONV_MODE_BALANCED : AT3_CHCONV_MODE_SECONDARY_DOMINANT;
  const initialMixLevel = enabled ? 1 : 0;

  return {
    slotLimit: Math.trunc(slotLimit),
    slots: Array.from({ length: AT3_CHCONV_SLOT_COUNT }, () => ({
      modeHint: 0,
      mode: initialMode,
      mixLevel: initialMixLevel,
      magnitudeSums: {
        primary: 0,
        secondary: 0,
      },
    })),
    mixCode: {
      previous: 0,
      current: enabled ? AT3_CHCONV_INITIAL_OPEN_MIX_CODE : 0,
    },
  };
}

/**
 * Balanced slots keep the wider tone-planning window while their combined
 * magnitude stays below the legacy low-energy threshold.
 */
export function slotUsesTransitionWindow(slotState) {
  const { primary = 0, secondary = 0 } = slotState?.magnitudeSums ?? {};
  const totalMagnitude = primary + secondary;
  return (
    slotState?.mode === AT3_CHCONV_MODE_BALANCED &&
    (Number.isNaN(totalMagnitude) || totalMagnitude < AT3_CHCONV_SUM_THRESHOLD)
  );
}

/**
 * Measures the four ATRAC3 QMF slots and chooses whether each slot should
 * stay balanced, bias toward the primary channel, or bias toward the
 * secondary channel before packing.
 */
export function selectChannelConversion(state, primaryBands, secondaryBands) {
  const limitedSlotCount = clampChannelConversionSlotLimit(state.slotLimit);
  state.mixCode.previous = state.mixCode.current;
  let openPrimary = AT3_CHCONV_ACC_BIAS;
  let openSecondary = AT3_CHCONV_ACC_BIAS;

  for (let slotIndex = 0; slotIndex < AT3_CHCONV_SLOT_COUNT; slotIndex += 1) {
    const slotState = state.slots[slotIndex];
    const previousMode = slotState.mode;
    const usesLimitedMix = slotIndex < limitedSlotCount;
    const magnitudeSums = measureChannelConversionSlotMagnitudes(
      slotIndex,
      primaryBands,
      secondaryBands
    );
    const mode = resolveChannelConversionSlotMode(
      previousMode,
      usesLimitedMix,
      magnitudeSums.primary,
      magnitudeSums.secondary
    );

    slotState.modeHint = previousMode;
    slotState.mode = mode;
    slotState.magnitudeSums.primary = magnitudeSums.primary;
    slotState.magnitudeSums.secondary = magnitudeSums.secondary;
    if (!usesLimitedMix && mode === AT3_CHCONV_MODE_BALANCED) {
      openPrimary = openPrimary * AT3_CHCONV_ACC_DECAY + magnitudeSums.primary;
      openSecondary = openSecondary * AT3_CHCONV_ACC_DECAY + magnitudeSums.secondary;
    }
  }

  state.mixCode.current = resolveOpenMixCode(openPrimary, openSecondary);
}
