import {
  AT3_DBA_BAND_THRESHOLDS,
  AT3_DBA_OFFSET_TABLE_A,
  AT3_SFB_WIDTHS,
} from "./encode-tables.js";
import { AT3ENC_PROC_BAND_COUNT } from "./proc-layout.js";
import { clampMode } from "./proc-quant-modes.js";
import { LOW_BUDGET_DEFAULT_MODE_SHIFT, measureLowBudgetBandIdsf } from "./proc-low-budget-scan.js";

/**
 * Shared ATRAC3 low-budget non-tone planning helpers.
 *
 * The first-pass coarse scan and dominated-band prune now live in a neighboring
 * module. This file stays focused on the harder post-tone refresh path that
 * remeasures claimed bands, perturbs neighbor metrics, and recomputes the
 * surviving selector/mode trail.
 */
const LOW_BUDGET_METRIC_BONUS = 0x100;
const LOW_BUDGET_CLAIMED_BAND_BONUS = 0x100;
const LOW_BUDGET_CLAIMED_DOUBLE_SPEND_BITS = 0x44c;
const LOW_BUDGET_CLAIMED_NARROW_WIDTH_LIMIT = 0x11;
const LOW_BUDGET_CLAIMED_NARROW_METRIC_GATE = 0x1800;
const LOW_BUDGET_CLAIMED_NARROW_METRIC_RESERVE = 0x400;
const LOW_BUDGET_CLAIMED_MUTED_METRIC_GATE = 0x3ff;
const LOW_BUDGET_CLAIMED_MUTED_BIT_BUDGET = 0x708;
const LOW_BUDGET_CLAIM_WEIGHT_INDEX_MAX = 4;
const LOW_BUDGET_SELECTOR_WIDEN_FREEZE = 0x3e;

function resolveClaimedBandSpend(adjust, bandWidth, bandMetric, bitBudget) {
  if (bitBudget < LOW_BUDGET_CLAIMED_DOUBLE_SPEND_BITS) {
    return adjust * 2;
  }

  if (
    bandWidth < LOW_BUDGET_CLAIMED_NARROW_WIDTH_LIMIT &&
    bandMetric > LOW_BUDGET_CLAIMED_NARROW_METRIC_GATE
  ) {
    return Math.min(bandMetric - LOW_BUDGET_CLAIMED_NARROW_METRIC_RESERVE, adjust * 2);
  }

  return adjust;
}

function resolveLowBudgetSelectorWidenSteps(peak, bandWidth, bandTotal) {
  if (peak >= LOW_BUDGET_SELECTOR_WIDEN_FREEZE) {
    return 0;
  }

  return peak * bandWidth < bandTotal * 5 ? 2 : 1;
}

function refreshUntouchedLowBudgetBand(band, bandSelectors, bandSum, bandMetrics, modeShift) {
  const peak = bandSelectors[band];
  const bandWidth = AT3_SFB_WIDTHS[band];
  const metricIndex = band + 1;

  if (modeShift === LOW_BUDGET_DEFAULT_MODE_SHIFT) {
    if (bandSum[band] * 8 < peak * bandWidth) {
      bandMetrics[metricIndex] += LOW_BUDGET_METRIC_BONUS;
    }
    return;
  }

  bandSelectors[band] = peak + resolveLowBudgetSelectorWidenSteps(peak, bandWidth, bandSum[band]);
}

function bleedClaimedBandSpendIntoNeighbors(band, spend, bandMetrics) {
  if (band > 1) {
    bandMetrics[band] -= spend >> 3;
  }
  if (band < AT3ENC_PROC_BAND_COUNT - 1) {
    bandMetrics[band + 2] -= spend >> 2;
  }
}

function resolveClaimedLowBudgetBandMetric(
  band,
  claimedSelector,
  claimedWidth,
  bandPeak,
  bandMetrics,
  bitBudget
) {
  const metricIndex = band + 1;
  let bandMetric = bandMetrics[metricIndex];
  if (claimedWidth === 0) {
    return bandMetric + LOW_BUDGET_CLAIMED_BAND_BONUS;
  }

  const bandWidth = AT3_SFB_WIDTHS[band];
  const weightIndex = Math.min((claimedWidth - 1) >> 1, LOW_BUDGET_CLAIM_WEIGHT_INDEX_MAX);
  const selectorDelta = bandPeak - claimedSelector;
  // This table stores signed penalties in a Uint32Array, so keep the
  // int32 coercion at the read site.
  const adjust = selectorDelta * (AT3_DBA_OFFSET_TABLE_A[weightIndex] | 0);
  const spend = resolveClaimedBandSpend(adjust, bandWidth, bandMetric, bitBudget);

  // Once a tone claim gives selector ownership back to the non-tone path, the
  // recovered spend also perturbs the adjacent band metrics.
  bleedClaimedBandSpendIntoNeighbors(band, spend, bandMetrics);
  bandMetric -= spend;
  return bandMetric;
}

function resolveClaimedLowBudgetBandMode(
  band,
  bandPeak,
  bandTotal,
  bandMetric,
  bitBudget,
  modeShift
) {
  const modeIsMuted =
    bandPeak <= 7 ||
    AT3_DBA_BAND_THRESHOLDS[band] >= bandTotal ||
    (bandMetric <= LOW_BUDGET_CLAIMED_MUTED_METRIC_GATE &&
      bitBudget <= LOW_BUDGET_CLAIMED_MUTED_BIT_BUDGET);
  return modeIsMuted ? 0 : clampMode(bandMetric >> modeShift);
}

/** Refreshes one band's selector and mode after mono tone claims perturb the budget trail. */
export function refreshLowBudgetBand(
  band,
  bandModes,
  bandSelectors,
  toneClaimSelectors,
  toneClaimWidths,
  bandSum,
  bandMetrics,
  groupIdsf,
  spectrumU32,
  bitBudget,
  modeShift
) {
  const claimedSelector = toneClaimSelectors[band];
  const metricIndex = band + 1;
  if (claimedSelector < 0) {
    refreshUntouchedLowBudgetBand(band, bandSelectors, bandSum, bandMetrics, modeShift);
    return;
  }

  const { bandPeak, bandTotal } = measureLowBudgetBandIdsf(band, groupIdsf, spectrumU32);
  bandSelectors[band] = bandPeak;
  const bandMetric = resolveClaimedLowBudgetBandMetric(
    band,
    claimedSelector,
    toneClaimWidths[band],
    bandPeak,
    bandMetrics,
    bitBudget
  );

  bandMetrics[metricIndex] = bandMetric;
  bandModes[band] = resolveClaimedLowBudgetBandMode(
    band,
    bandPeak,
    bandTotal,
    bandMetric,
    bitBudget,
    modeShift
  );
  toneClaimSelectors[band] = -1;
  toneClaimWidths[band] = 0;
}
