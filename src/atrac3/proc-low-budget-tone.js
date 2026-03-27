import { refreshLowBudgetBand } from "./proc-low-budget.js";
import {
  LOW_BUDGET_DEFAULT_MODE_SHIFT,
  LOW_BUDGET_HIGH_BUDGET_TONE_COST,
} from "./proc-low-budget-scan.js";
import {
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
} from "./proc-layout.js";
import { clampMode } from "./proc-quant-modes.js";
import { extractHighBudgetTones } from "./proc-tone-high-budget.js";
import { extractMonoLowBudgetTones } from "./proc-tone-mono.js";

/**
 * ATRAC3 tone-branch orchestration.
 *
 * The neighboring tone owners keep shared tone quantization, high-budget
 * extraction, and mono low-budget extraction/layout separate. This file stays
 * focused on the branch decision and the low-budget selector refresh handoff
 * back into the non-tone proc pipeline.
 */

function seedLowBudgetBandState(
  bandLimit,
  bandSelectors,
  bandModes,
  bandMetrics,
  sumTotal,
  modeShift
) {
  for (let band = 0; band < bandLimit; band += 1) {
    const peak = bandSelectors[band];
    const metric = peak > 2 ? peak * 0x100 - sumTotal : peak;
    bandMetrics[band + 1] = metric;
    bandModes[band] = (peak > 2 ? clampMode(metric >> modeShift) : 0) >>> 0;
  }
}

/**
 * Runs the ATRAC3 tone branch that precedes concrete non-tone payload fitting.
 *
 * High-budget mode extracts tones directly when enough bit budget remains.
 * Otherwise the mono low-budget branch claims selectors from the non-tone
 * planner, rewrites the tone regions, and then hands the refreshed band state
 * back to the proc-word orchestration for concrete payload fitting.
 */
export function runLowBudgetTonePath(
  layer,
  procWords,
  {
    bandLimit,
    availableBits,
    bitBudget,
    modeShift = LOW_BUDGET_DEFAULT_MODE_SHIFT,
    usesIndependentCoding,
    sumTotal,
    over7TotalWithinLimit,
    bandSum,
    bandModes,
    bandSelectors,
    bandMetrics,
    groupIdsf,
    spectrumU32,
    toneClaimSelectors,
    toneClaimWidths,
    debug = null,
  }
) {
  if (over7TotalWithinLimit * LOW_BUDGET_HIGH_BUDGET_TONE_COST < availableBits) {
    return extractHighBudgetTones(
      layer,
      procWords,
      bandLimit,
      availableBits,
      groupIdsf,
      bandMetrics
    );
  }

  seedLowBudgetBandState(bandLimit, bandSelectors, bandModes, bandMetrics, sumTotal, modeShift);
  procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = 0;
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 0;

  if (usesIndependentCoding) {
    availableBits = extractMonoLowBudgetTones(
      layer,
      procWords,
      bandLimit,
      bandMetrics,
      availableBits,
      toneClaimSelectors,
      toneClaimWidths,
      debug
    );
  }

  for (let band = 0; band < bandLimit; band += 1) {
    refreshLowBudgetBand(
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
    );
  }

  return availableBits;
}
