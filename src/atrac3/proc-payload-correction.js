import { AT3ENC_PROC_BAND_COUNT } from "./proc-layout.js";
import { clampMode } from "./proc-quant-modes.js";
import { estimateBandBits } from "./proc-low-budget-scan.js";

const LOW_BUDGET_CORRECTION_FP_SCALE = 0x400;
const LOW_BUDGET_CORRECTION_TARGET_SCALE = 10;
const LOW_BUDGET_CORRECTION_GUARD_SCALE = 9;
const LOW_BUDGET_CORRECTION_GUARD_THRESHOLD = 599;
const LOW_BUDGET_BAND_TRAIL_SLOTS = AT3ENC_PROC_BAND_COUNT + 2;
const LOW_BUDGET_NEGATIVE_CORRECTION_WEIGHT_SHIFT = 8;
const LOW_BUDGET_SECOND_BAND_CORRECTION_WEIGHT = 0xbc;
const LOW_BUDGET_LOW_BAND_CORRECTION_WEIGHT = 0x61;
const LOW_BUDGET_HIGH_BAND_CORRECTION_WEIGHT = 0x4a;
const LOW_BUDGET_LOW_CORRECTION_BAND_LIMIT = 8;
const LOW_BUDGET_SELECTOR_SPLIT_BAND = 18;

export const LOW_BUDGET_SELECTOR_MAX = 0x3f;

function scaleNegativeCorrection(value, weight) {
  return (value * weight) >> LOW_BUDGET_NEGATIVE_CORRECTION_WEIGHT_SHIFT;
}

/**
 * Rebuilds the measurable low-budget correction trail that turns the coarse
 * post-tone band metrics into corrected non-tone modes plus one running
 * remaining-bit trail for the later candidate planner.
 *
 * @param {{
 *   bandModes: Uint32Array,
 *   bandSelectors: Uint32Array,
 *   bandMetrics: Int32Array,
 *   groupIdsf: Uint32Array,
 *   estimatedBits: number,
 *   activeWidth: number,
 *   mode7Width: number,
 *   activeBands: number,
 *   totalAvailable: number,
 *   modeShift: number,
 * }} state
 */
export function buildLowBudgetCorrectionTrail({
  bandModes,
  bandSelectors,
  bandMetrics,
  groupIdsf,
  estimatedBits,
  activeWidth,
  mode7Width,
  activeBands,
  totalAvailable,
  modeShift,
}) {
  const hardTarget10 = totalAvailable * LOW_BUDGET_CORRECTION_TARGET_SCALE;
  const protectedMode7Width = estimatedBits < hardTarget10 ? mode7Width : 0;
  const correctionWidth = activeWidth - protectedMode7Width;
  const keepMode7AsIs = protectedMode7Width === activeWidth;
  const target10 =
    totalAvailable > LOW_BUDGET_CORRECTION_GUARD_THRESHOLD
      ? totalAvailable * LOW_BUDGET_CORRECTION_GUARD_SCALE
      : hardTarget10;
  let correction = 0;

  if (!keepMode7AsIs && correctionWidth !== 0) {
    correction = Math.trunc(
      ((target10 - estimatedBits) * LOW_BUDGET_CORRECTION_FP_SCALE) /
        (correctionWidth * LOW_BUDGET_CORRECTION_TARGET_SCALE)
    );
  }

  if (!keepMode7AsIs && modeShift === 10 && estimatedBits > target10) {
    correction += correction >> 3;

    const lowBandPenalty = scaleNegativeCorrection(
      correction,
      LOW_BUDGET_LOW_BAND_CORRECTION_WEIGHT
    );
    const highBandPenalty = scaleNegativeCorrection(
      correction,
      LOW_BUDGET_HIGH_BAND_CORRECTION_WEIGHT
    );

    bandMetrics[1] -= correction;
    bandMetrics[2] -= scaleNegativeCorrection(correction, LOW_BUDGET_SECOND_BAND_CORRECTION_WEIGHT);
    for (let band = 2; band < LOW_BUDGET_SELECTOR_SPLIT_BAND; band += 1) {
      bandMetrics[band + 1] -=
        band < LOW_BUDGET_LOW_CORRECTION_BAND_LIMIT ? lowBandPenalty : highBandPenalty;
    }

    for (let band = 0; band < LOW_BUDGET_SELECTOR_SPLIT_BAND; band += 1) {
      const adjustedMetric = correction + bandMetrics[band + 1];
      if (adjustedMetric < 0 && bandSelectors[band] < LOW_BUDGET_SELECTOR_MAX) {
        bandSelectors[band] += 1;
      }
    }
    for (let band = LOW_BUDGET_SELECTOR_SPLIT_BAND; band < activeBands; band += 1) {
      const adjustedMetric = correction + bandMetrics[band + 1];
      if (adjustedMetric < LOW_BUDGET_CORRECTION_FP_SCALE) {
        const widenedSelector =
          bandSelectors[band] - ((adjustedMetric - LOW_BUDGET_CORRECTION_FP_SCALE) >> 10);
        bandSelectors[band] = Math.min(widenedSelector, LOW_BUDGET_SELECTOR_MAX);
      }
    }
  }

  const bandBudgetTrail = new Int32Array(LOW_BUDGET_BAND_TRAIL_SLOTS);
  let remaining10 = hardTarget10;

  for (let band = activeBands - 1; band >= 0; band -= 1) {
    if (bandModes[band] === 0) {
      continue;
    }

    const correctedMode = clampMode((correction + bandMetrics[band + 1]) >> modeShift);
    bandModes[band] = correctedMode;
    remaining10 -= estimateBandBits(correctedMode, bandSelectors[band], band, groupIdsf);
    bandBudgetTrail[band + 1] = remaining10;
  }

  return { remaining10, bandBudgetTrail };
}
