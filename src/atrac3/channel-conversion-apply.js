import { AT3ENC_PROC_SCALE_TABLE } from "./encode-tables.js";
import {
  AT3_CHCONV_DOMINANCE_RATIO_LIMIT,
  AT3_CHCONV_DOMINANCE_RATIO_MAX,
  AT3_CHCONV_MODE_LEGACY_OPEN_PASSTHROUGH,
  AT3_CHCONV_MIX_LEVEL_FALLBACK,
  AT3_CHCONV_MIX_LEVEL_SCALE,
  AT3_CHCONV_MIX_LEVEL_STEP,
  AT3_CHCONV_MODE_BALANCED,
  AT3_CHCONV_MODE_PRIMARY_DOMINANT,
  AT3_CHCONV_MODE_SECONDARY_DOMINANT,
  AT3_CHCONV_OPEN_MIX_DIRECTION_BIT,
  AT3_CHCONV_OPEN_MIX_MAGNITUDE_MASK,
  AT3_CHCONV_RAMP_BANDS,
  AT3_CHCONV_RAMP_STEP,
  AT3_CHCONV_SLOT_COUNT,
  AT3_CHCONV_SLOT_SAMPLES,
  AT3_CHCONV_SLOT_STRIDE,
  clampChannelConversionSlotLimit,
} from "./channel-conversion-analysis.js";

function resolveLimitedMatrixMidScale(mode) {
  if (mode === AT3_CHCONV_MODE_SECONDARY_DOMINANT) {
    return 0;
  }
  if (mode === AT3_CHCONV_MODE_PRIMARY_DOMINANT) {
    return 2;
  }
  return 1;
}

function resolveLimitedMatrixSideScale(mode) {
  return mode === AT3_CHCONV_MODE_BALANCED ? 1 : 2;
}

function resolveOpenMixTableIndex(mode, mixCode) {
  if (mode === AT3_CHCONV_MODE_BALANCED) {
    return mixCode & AT3_CHCONV_OPEN_MIX_MAGNITUDE_MASK;
  }
  if (mode === AT3_CHCONV_MODE_PRIMARY_DOMINANT) {
    return mixCode + AT3_CHCONV_OPEN_MIX_DIRECTION_BIT;
  }
  if (mode === AT3_CHCONV_MODE_SECONDARY_DOMINANT) {
    return (mixCode ^ AT3_CHCONV_OPEN_MIX_DIRECTION_BIT) + AT3_CHCONV_OPEN_MIX_DIRECTION_BIT;
  }
  if (mode === AT3_CHCONV_MODE_LEGACY_OPEN_PASSTHROUGH) {
    return mixCode;
  }

  // Preserve the compatibility path for stale or older open-slot mode values.
  return mixCode;
}

function resolveLimitedTargetMixLevel(currentMode, primaryMagnitude, secondaryMagnitude) {
  if (
    currentMode !== AT3_CHCONV_MODE_BALANCED ||
    primaryMagnitude === 0 ||
    secondaryMagnitude === 0 ||
    Number.isNaN(primaryMagnitude) ||
    Number.isNaN(secondaryMagnitude)
  ) {
    return 1;
  }

  const totalEnergy = primaryMagnitude + secondaryMagnitude;
  const dominantEnergy = Math.max(primaryMagnitude, secondaryMagnitude);
  const quieterEnergy = Math.min(primaryMagnitude, secondaryMagnitude);
  const dominanceRatio = dominantEnergy / quieterEnergy;

  if (dominanceRatio >= AT3_CHCONV_DOMINANCE_RATIO_MAX) {
    return AT3_CHCONV_MIX_LEVEL_FALLBACK;
  }
  if (dominanceRatio > AT3_CHCONV_DOMINANCE_RATIO_LIMIT) {
    return ((dominantEnergy - quieterEnergy) * AT3_CHCONV_MIX_LEVEL_SCALE) / totalEnergy;
  }

  return 1;
}

function stepLimitedMixLevel(previousMixLevel, targetMixLevel) {
  const mixLevelDelta = targetMixLevel - previousMixLevel;
  return Number.isNaN(mixLevelDelta) || Math.abs(mixLevelDelta) < AT3_CHCONV_MIX_LEVEL_STEP
    ? targetMixLevel
    : previousMixLevel + Math.sign(mixLevelDelta) * AT3_CHCONV_MIX_LEVEL_STEP;
}

function applyLimitedSlotConversion(slotState, slotIndex, primaryBands, secondaryBands) {
  const currentMode = slotState.mode;
  const previousMode = slotState.modeHint;
  const previousMixLevel = slotState.mixLevel;
  const { primary, secondary } = slotState.magnitudeSums;
  const currentMixLevel = stepLimitedMixLevel(
    previousMixLevel,
    resolveLimitedTargetMixLevel(currentMode, primary, secondary)
  );
  const previousMidScale = resolveLimitedMatrixMidScale(previousMode);
  const currentMidScale = resolveLimitedMatrixMidScale(currentMode);
  const previousSideScale = previousMixLevel * resolveLimitedMatrixSideScale(previousMode);
  const currentSideScale = currentMixLevel * resolveLimitedMatrixSideScale(currentMode);
  const midScaleStep = (currentMidScale - previousMidScale) * AT3_CHCONV_RAMP_STEP;
  const sideScaleStep = (currentSideScale - previousSideScale) * AT3_CHCONV_RAMP_STEP;
  const invCurrentSideScale = 1 / currentSideScale;

  slotState.mixLevel = currentMixLevel;
  for (
    let bandIndex = slotIndex, bandOffset = 0;
    bandOffset < AT3_CHCONV_SLOT_SAMPLES;
    bandIndex += AT3_CHCONV_SLOT_STRIDE, bandOffset += 1
  ) {
    const primary = primaryBands[bandIndex];
    const secondary = secondaryBands[bandIndex];
    const mid = (primary + secondary) * 0.5;

    if (bandOffset < AT3_CHCONV_RAMP_BANDS) {
      const midScale = previousMidScale + bandOffset * midScaleStep;
      const sideScale = previousSideScale + bandOffset * sideScaleStep;
      secondaryBands[bandIndex] = (primary - midScale * mid) / sideScale;
    } else {
      secondaryBands[bandIndex] = (primary - currentMidScale * mid) * invCurrentSideScale;
    }

    primaryBands[bandIndex] = mid;
  }
}

function applyOpenSlotConversion(
  mode,
  slotIndex,
  previousMixCode,
  currentMixCode,
  primaryBands,
  secondaryBands
) {
  const previousTableIndex = resolveOpenMixTableIndex(mode, previousMixCode);
  const currentTableIndex = resolveOpenMixTableIndex(mode, currentMixCode);
  const previousWeight = AT3ENC_PROC_SCALE_TABLE[previousTableIndex] ?? 0;
  const currentWeight = AT3ENC_PROC_SCALE_TABLE[currentTableIndex] ?? 0;
  const weightStep = (currentWeight - previousWeight) * AT3_CHCONV_RAMP_STEP;
  const invCurrentWeight = 1 / currentWeight;

  for (
    let bandIndex = slotIndex, bandOffset = 0;
    bandOffset < AT3_CHCONV_SLOT_SAMPLES;
    bandIndex += AT3_CHCONV_SLOT_STRIDE, bandOffset += 1
  ) {
    const sum = primaryBands[bandIndex] + secondaryBands[bandIndex];
    primaryBands[bandIndex] =
      bandOffset < AT3_CHCONV_RAMP_BANDS
        ? sum / (previousWeight + bandOffset * weightStep)
        : sum * invCurrentWeight;
  }
}

/**
 * Applies the selected ATRAC3 low-bitrate stereo conversion to the two QMF
 * spectra. Limited slots ramp matrix weights, while open slots ramp the
 * packed mix-code weight used by the secondary transport path.
 */
export function at3encApplyChannelConversion(state) {
  const { channelConversion, primaryLayer, secondaryLayer } = state;
  const primaryBands = primaryLayer.spectrum;
  const secondaryBands = secondaryLayer.spectrum;
  const limitedSlotCount = clampChannelConversionSlotLimit(channelConversion.slotLimit);
  const { previous: previousMixCode, current: currentMixCode } = channelConversion.mixCode;

  for (let slotIndex = 0; slotIndex < limitedSlotCount; slotIndex += 1) {
    applyLimitedSlotConversion(
      channelConversion.slots[slotIndex],
      slotIndex,
      primaryBands,
      secondaryBands
    );
  }

  for (let slotIndex = limitedSlotCount; slotIndex < AT3_CHCONV_SLOT_COUNT; slotIndex += 1) {
    applyOpenSlotConversion(
      channelConversion.slots[slotIndex].mode,
      slotIndex,
      previousMixCode,
      currentMixCode,
      primaryBands,
      secondaryBands
    );
  }
}
