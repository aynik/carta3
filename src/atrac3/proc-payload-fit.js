import { AT3ENC_PROC_ACTIVE_BANDS_WORD } from "./proc-layout.js";
import { LOW_BUDGET_BAND_HEADER_BITS } from "./proc-low-budget-scan.js";
import { LOW_BUDGET_SELECTOR_MAX } from "./proc-payload-correction.js";
import { at3ClassScaleByMode } from "./proc-quant-modes.js";
import { countbitsNontoneSpecsGeneric } from "./proc-payload-plan.js";

/**
 * ATRAC3 final non-tone payload fitting.
 *
 * This owner takes the measurable band plans from the correction pass and
 * forces them under the remaining budget: reclaiming tail headers, widening
 * selectors for overflow bands, and restoring mode detail with spare slack.
 */

const MONO_TONE_PROTECTED_BAND_COUNT = 5;
const MONO_TONE_PRIORITY_FLOOR = 0x40;

function createPendingPlansByBand(bandPlans, activeBands) {
  const pendingPlansByBand = Array(activeBands).fill(null);

  for (const plan of bandPlans) {
    if (plan.band < activeBands) {
      pendingPlansByBand[plan.band] = plan;
    }
  }

  return pendingPlansByBand;
}

function applyMonoTonePriorityFloor(pendingPlansByBand, activeBands) {
  const protectedBandCount = Math.min(activeBands, MONO_TONE_PROTECTED_BAND_COUNT);
  for (let band = 0; band < protectedBandCount; band += 1) {
    const plan = pendingPlansByBand[band];
    if (plan !== null && plan.priority < MONO_TONE_PRIORITY_FLOOR) {
      plan.priority = MONO_TONE_PRIORITY_FLOOR;
    }
  }
}

function reclaimTrailingBandHeaders(bandModes, pendingPlansByBand, band, fitState) {
  while (fitState.activeBandCount > band + 1) {
    const tailBand = fitState.activeBandCount - 1;
    const tailBandIsLocked = pendingPlansByBand[tailBand] === null && bandModes[tailBand] !== 0;
    if (tailBandIsLocked) {
      break;
    }

    fitState.activeBandCount = tailBand;
    fitState.availableBits += LOW_BUDGET_BAND_HEADER_BITS;
    bandModes[tailBand] = 0;
    pendingPlansByBand[tailBand] = null;
  }
}

function widenBandSelectorToFit(plan, spectrum, fitState) {
  let scaleSel = plan.scaleSel + 1;
  let bandBits = plan.bits;

  while (scaleSel <= LOW_BUDGET_SELECTOR_MAX && bandBits > plan.modeFloorBits) {
    bandBits = countbitsNontoneSpecsGeneric(
      plan.mode,
      scaleSel,
      plan.bandWidth,
      spectrum,
      plan.spectrumStart
    );
    if (
      fitState.committedBits + bandBits <= fitState.availableBits ||
      bandBits <= plan.modeFloorBits
    ) {
      break;
    }

    scaleSel += 1;
  }

  plan.scaleSel = scaleSel;
  plan.bits = bandBits;
}

function promoteBandModeWithinSlack(plan, spectrum, fitState) {
  if (plan.mode >= 7) {
    return;
  }

  const promotionRoom = fitState.availableBits - fitState.committedBits - 7;
  const nextStepCost = (plan.bandWidth >> 1) * at3ClassScaleByMode(plan.mode + 1);
  if (nextStepCost >= promotionRoom) {
    return;
  }

  let promotedMode = plan.mode + 1;
  if (promotedMode < 7 && fitState.upgradeSlack > plan.bandWidth * 4) {
    promotedMode += 1;
  }

  const promotedBits = countbitsNontoneSpecsGeneric(
    promotedMode,
    plan.scaleSel,
    plan.bandWidth,
    spectrum,
    plan.spectrumStart
  );
  const delta = promotedBits - plan.bits;
  if (delta > (fitState.upgradeSlack < 0 ? 0 : fitState.upgradeSlack)) {
    return;
  }

  fitState.upgradeSlack -= delta;
  plan.mode = promotedMode;
  plan.bits = promotedBits;
}

/**
 * Fits low-budget non-tone bands by reclaiming tail headers first, widening
 * selectors only when necessary, and then spending any leftover slack on mode
 * restoration in selector-priority order.
 */
export function finalizeLowBudgetBandPayload({
  procWords,
  bandModes,
  bandSelectors,
  bandPlans,
  plannedBits,
  activeBands,
  totalAvailable,
  spectrum,
  usesIndependentCoding,
  previousBlock0ToneCount,
  block0ToneCount,
  bitBudget,
}) {
  const fitState = {
    upgradeSlack: totalAvailable - plannedBits,
    committedBits: 0,
    availableBits: totalAvailable,
    activeBandCount: activeBands,
  };
  // Once one band is committed or abandoned, later tail reclaim must treat it
  // as fixed state instead of a still-pending candidate.
  const pendingPlansByBand = createPendingPlansByBand(bandPlans, activeBands);

  if (usesIndependentCoding && (previousBlock0ToneCount !== 0 || block0ToneCount !== 0)) {
    applyMonoTonePriorityFloor(pendingPlansByBand, activeBands);
  }

  const plansByPriority = [...bandPlans].sort(
    (left, right) => right.priority - left.priority || left.band - right.band
  );

  for (const plan of plansByPriority) {
    const band = plan.band;
    if (band >= fitState.activeBandCount || pendingPlansByBand[band] !== plan) {
      continue;
    }

    const startedWithinBudget = fitState.committedBits + plan.bits <= fitState.availableBits;

    if (!startedWithinBudget) {
      reclaimTrailingBandHeaders(bandModes, pendingPlansByBand, band, fitState);
      procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = fitState.activeBandCount;

      if (fitState.committedBits + plan.bits > fitState.availableBits) {
        widenBandSelectorToFit(plan, spectrum, fitState);
        bandSelectors[band] = plan.scaleSel;
      }
    }

    if (fitState.committedBits + plan.bits > fitState.availableBits) {
      fitState.upgradeSlack += plan.bits;
      bandModes[band] = 0;
      pendingPlansByBand[band] = null;
      continue;
    }

    if (startedWithinBudget && plan.mode < 7) {
      promoteBandModeWithinSlack(plan, spectrum, fitState);
    }

    bandModes[band] = plan.mode;
    fitState.committedBits += plan.bits;
    pendingPlansByBand[band] = null;
  }

  return bitBudget - (fitState.availableBits - fitState.committedBits);
}
