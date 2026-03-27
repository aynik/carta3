import {
  AT3_DBA_ACC_BASE,
  AT3_DBA_ADJUST_MULT1,
  AT3_DBA_ADJUST_MULT2,
  AT3_DBA_LIMIT_ALT,
  AT3_DBA_LIMIT_MAIN,
  AT3_DBA_SCALE_ADJUST,
  AT3_DBA_SCALE_EDGE,
  AT3_DBA_SCALE_MID,
  AT3_DBA_SCALE_PRIMARY,
  AT3_DBA_SCALE_SECONDARY,
  AT3_SFB_OFFSETS,
  AT3_SFB_WIDTHS,
} from "./encode-tables.js";
import { AT3_CHCONV_MODE_BALANCED } from "./channel-conversion-analysis.js";

const AT3_DBA_BALANCED_SECONDARY_SCALE = 2;
const AT3_DBA_PRIMARY_SCAN_LAST_BAND = 18;
const AT3_DBA_UNBALANCED_SECONDARY_SCALE = 4;

function quantizeShiftDelta(delta) {
  return Math.trunc(delta) & ~7;
}

/**
 * ATRAC3 DBA stereo rebalance.
 *
 * This stage runs after low-bitrate channel conversion and before frame
 * packing. It scans the converted spectra, estimates whether the primary
 * layer still has headroom, and adjusts the primary shift toward the codec's
 * target packing budget.
 */

function measureSfbPeak(spectrum, band) {
  let bandPeak = AT3_DBA_ACC_BASE;
  const bandStart = AT3_SFB_OFFSETS[band];
  const bandEnd = AT3_SFB_OFFSETS[band + 1];
  for (let sampleIndex = bandStart; sampleIndex < bandEnd; sampleIndex += 1) {
    const magnitude = Math.abs(spectrum[sampleIndex]);
    if (Number.isNaN(magnitude) || bandPeak < magnitude) {
      bandPeak = magnitude;
    }
  }
  return bandPeak;
}

function measureBandPeakEnergy(spectrum, startBand, stopBand, step) {
  let energy = AT3_DBA_ACC_BASE;
  for (let band = startBand; band !== stopBand; band += step) {
    energy += measureSfbPeak(spectrum, band) * AT3_SFB_WIDTHS[band];
  }
  return energy;
}

function measurePrimaryLayerEnergy(layer) {
  const lastPrimaryBand = Math.min(Math.trunc(layer.sfbLimit) - 1, AT3_DBA_PRIMARY_SCAN_LAST_BAND);
  return lastPrimaryBand >= 0
    ? measureBandPeakEnergy(layer.spectrum, lastPrimaryBand, -1, -1)
    : AT3_DBA_ACC_BASE;
}

function measureSecondaryLayerEnergy(layer) {
  return measureBandPeakEnergy(layer.spectrum, 0, Math.max(0, Math.trunc(layer.sfbLimit)), 1);
}

function usesBalancedDbaMix(channelConversion) {
  return channelConversion.slots[0]?.modeHint === AT3_CHCONV_MODE_BALANCED;
}

function scaleSecondaryDbaEnergy(secondaryEnergy, usesBalancedMix) {
  return (
    secondaryEnergy *
    (usesBalancedMix ? AT3_DBA_BALANCED_SECONDARY_SCALE : AT3_DBA_UNBALANCED_SECONDARY_SCALE)
  );
}

/**
 * Measured ATRAC3 DBA rebalance inputs for one converted frame.
 *
 * @typedef {object} Atrac3DbaEnergyProfile
 * @property {number} targetShift
 * @property {number} currentShift
 * @property {number} shiftGap
 * @property {number} primaryEnergy
 * @property {boolean} primaryEnergyIsInvalid
 * @property {number} scaledSecondaryEnergy
 * @property {boolean} usesBalancedMix
 */

function measureDbaEnergyProfile(state) {
  const { basePrimaryShift, primaryShiftTarget, channelConversion, primaryLayer, secondaryLayer } =
    state;
  const currentShift = Math.trunc(basePrimaryShift);
  const targetShift = primaryShiftTarget;
  const primaryEnergy = measurePrimaryLayerEnergy(primaryLayer);
  const usesBalancedMix = usesBalancedDbaMix(channelConversion);
  const scaledSecondaryEnergy = scaleSecondaryDbaEnergy(
    measureSecondaryLayerEnergy(secondaryLayer),
    usesBalancedMix
  );

  return {
    targetShift,
    currentShift,
    shiftGap: targetShift - currentShift,
    primaryEnergy,
    primaryEnergyIsInvalid: Number.isNaN(primaryEnergy),
    scaledSecondaryEnergy,
    usesBalancedMix,
  };
}

function collapseDbaShiftToTarget(profile) {
  return (
    Number.isNaN(profile.scaledSecondaryEnergy) ||
    profile.scaledSecondaryEnergy < AT3_DBA_LIMIT_MAIN ||
    (!profile.usesBalancedMix && profile.scaledSecondaryEnergy < AT3_DBA_LIMIT_ALT)
  );
}

function preinterpolateBalancedDbaShift(profile) {
  if (
    !profile.usesBalancedMix ||
    (!profile.primaryEnergyIsInvalid && profile.scaledSecondaryEnergy >= profile.primaryEnergy)
  ) {
    return profile.currentShift;
  }

  return (
    profile.currentShift +
    quantizeShiftDelta(
      (profile.primaryEnergy - profile.scaledSecondaryEnergy) *
        (AT3_DBA_LIMIT_MAIN / (profile.primaryEnergy * AT3_DBA_SCALE_ADJUST)) *
        profile.shiftGap
    )
  );
}

function primaryHasDbaHeadroom(profile) {
  const headroomScale = profile.usesBalancedMix ? AT3_DBA_SCALE_PRIMARY : AT3_DBA_SCALE_SECONDARY;
  const scaledHeadroomEnergy = profile.scaledSecondaryEnergy * headroomScale;
  return (
    profile.primaryEnergyIsInvalid ||
    Number.isNaN(scaledHeadroomEnergy) ||
    scaledHeadroomEnergy < profile.primaryEnergy
  );
}

function resolveDbaAdjustedGap(profile) {
  const adjustEnergy = profile.scaledSecondaryEnergy * AT3_DBA_SCALE_ADJUST;
  if (
    profile.primaryEnergyIsInvalid ||
    Number.isNaN(adjustEnergy) ||
    adjustEnergy < profile.primaryEnergy
  ) {
    return Math.trunc(profile.shiftGap * AT3_DBA_ADJUST_MULT1);
  }

  const midEnergy = profile.scaledSecondaryEnergy * AT3_DBA_SCALE_MID;
  if (Number.isNaN(midEnergy) || midEnergy < profile.primaryEnergy) {
    return Math.trunc(profile.shiftGap * AT3_DBA_ADJUST_MULT2);
  }

  return profile.shiftGap;
}

function resolveDbaHeadroomShift(profile) {
  const edgeEnergy = profile.scaledSecondaryEnergy * AT3_DBA_SCALE_EDGE;
  if (
    profile.primaryEnergyIsInvalid ||
    Number.isNaN(edgeEnergy) ||
    edgeEnergy <= profile.primaryEnergy
  ) {
    return profile.currentShift + quantizeShiftDelta(profile.shiftGap);
  }

  const adjustedGap = resolveDbaAdjustedGap(profile);
  return (
    profile.currentShift +
    quantizeShiftDelta(
      (profile.primaryEnergy - profile.scaledSecondaryEnergy) *
        (AT3_DBA_LIMIT_MAIN / (profile.primaryEnergy + profile.primaryEnergy)) *
        adjustedGap
    )
  );
}

/**
 * Recomputes the primary-layer shift from the converted secondary-layer
 * energy. This is the optional DBA stereo-rebalance phase that runs after
 * channel conversion and before frame packing.
 */
export function dbaMainSub(state, { interpolationOnly = false } = {}) {
  const { primaryLayer } = state;
  const profile = measureDbaEnergyProfile(state);

  // Phase 1: a very quiet secondary layer collapses straight to the target
  // shift regardless of later interpolation and headroom rules.
  if (collapseDbaShiftToTarget(profile)) {
    primaryLayer.shift = profile.targetShift;
    return profile.targetShift;
  }

  // Phase 2: balanced stereo can pre-interpolate toward the target before
  // the headroom classifier decides whether to keep, clamp, or soften that
  // move.
  let nextShift = preinterpolateBalancedDbaShift(profile);

  if (!interpolationOnly && primaryHasDbaHeadroom(profile)) {
    nextShift = resolveDbaHeadroomShift(profile);
  }

  primaryLayer.shift = nextShift;
  return nextShift;
}
