import { AT3_SFB_OFFSETS } from "./encode-tables.js";
import {
  AT3ENC_PROC_ACTIVE_BANDS_WORD,
  AT3ENC_PROC_BAND_COUNT,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_UNIT_COUNT_WORD,
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
  at3encProcToneRegionFlagWord,
} from "./proc-layout.js";
import {
  scanLowBudgetBandPeaks,
  LOW_BUDGET_DEFAULT_MODE_SHIFT,
  LOW_BUDGET_TIGHT_MODE_SHIFT,
  LOW_BUDGET_TIGHT_MODE_SHIFT_BUDGET,
} from "./proc-low-budget-scan.js";

/**
 * One mutable scratch pack reused only while building one layer's proc words.
 *
 * @typedef {object} Atrac3LowBudgetScratch
 * @property {Uint32Array} groupIdsf One coarse IDSF estimate per 4-coefficient group.
 * @property {Uint32Array} bandSum Sum of coarse group IDSF values per scale-factor band.
 * @property {Int32Array} bandMetrics Guarded metric trail indexed as `band + 1`.
 * @property {Int32Array} toneClaimSelectors Original selector borrowed by mono tone extraction.
 * @property {Int32Array} toneClaimWidths Coefficient widths borrowed from the non-tone path.
 */

function createLowBudgetScratch() {
  return {
    groupIdsf: new Uint32Array(256),
    bandSum: new Uint32Array(AT3ENC_PROC_BAND_COUNT),
    // One guard slot on each side lets adjacent-band penalties touch
    // `band - 1`, `band`, and `band + 1` without extra bounds branches.
    bandMetrics: new Int32Array(34),
    toneClaimSelectors: new Int32Array(AT3ENC_PROC_BAND_COUNT),
    toneClaimWidths: new Int32Array(AT3ENC_PROC_BAND_COUNT),
  };
}

function isLowBudgetScratch(scratch) {
  return (
    scratch &&
    typeof scratch === "object" &&
    scratch.groupIdsf instanceof Uint32Array &&
    scratch.groupIdsf.length >= 256 &&
    scratch.bandSum instanceof Uint32Array &&
    scratch.bandSum.length >= AT3ENC_PROC_BAND_COUNT &&
    scratch.bandMetrics instanceof Int32Array &&
    scratch.bandMetrics.length >= 34 &&
    scratch.toneClaimSelectors instanceof Int32Array &&
    scratch.toneClaimSelectors.length >= AT3ENC_PROC_BAND_COUNT &&
    scratch.toneClaimWidths instanceof Int32Array &&
    scratch.toneClaimWidths.length >= AT3ENC_PROC_BAND_COUNT
  );
}

function resetLowBudgetScratch(scratch) {
  scratch.bandMetrics.fill(0);
  scratch.toneClaimSelectors.fill(-1);
  scratch.toneClaimWidths.fill(0);
}

/**
 * Builds the entry context for one low-budget proc-word pass before tone and
 * payload planning mutate the shared scratch.
 */
export function beginLowBudgetProcWordPass(layer, procWords) {
  let bandLimit = Math.max(1, Math.min(layer.sfbLimit, AT3ENC_PROC_BAND_COUNT));
  const bitBudget = layer.shift;
  const usesIndependentCoding = layer.referencesPrimaryShift !== true;
  /** @type {Atrac3LowBudgetScratch} */
  let scratch = layer.lowBudgetScratch;
  if (!isLowBudgetScratch(scratch)) {
    scratch = createLowBudgetScratch();
    layer.lowBudgetScratch = scratch;
  }
  resetLowBudgetScratch(scratch);
  const toneState = layer.tones;
  const toneBlocks = toneState?.blocks;
  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);
  const {
    bandLimit: scannedBandLimit,
    sumTotal,
    over7TotalWithinLimit,
  } = scanLowBudgetBandPeaks(layer, {
    bandLimit,
    bitBudget,
    usesIndependentCoding,
    groupIdsf: scratch.groupIdsf,
    bandSum: scratch.bandSum,
    bandSelectors,
  });
  bandLimit = scannedBandLimit;

  const modeShift =
    bitBudget < over7TotalWithinLimit * LOW_BUDGET_TIGHT_MODE_SHIFT_BUDGET
      ? LOW_BUDGET_TIGHT_MODE_SHIFT
      : LOW_BUDGET_DEFAULT_MODE_SHIFT;
  const blockCount = Math.max(1, Math.ceil(AT3_SFB_OFFSETS[bandLimit] / 256));
  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = blockCount;

  const toneEntryCount = Array.isArray(toneBlocks)
    ? toneBlocks.slice(0, blockCount).reduce((sum, block) => sum + (block?.entryCount ?? 0), 0)
    : 0;

  // Reserve fixed unit headers, pre-existing gain-pair payload, and one
  // 3-bit header per active scale-factor band before the tone path claims
  // any extra space.
  const blockHeaderBits = blockCount * 3;
  const toneEntryBits = toneEntryCount * 9;
  const bandHeaderBits = bandLimit * 3;
  const availableBits = bitBudget - blockHeaderBits - toneEntryBits - bandHeaderBits;
  procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = bandLimit >>> 0;

  return {
    scratch,
    toneState,
    toneBlocks,
    bandModes,
    bandSelectors,
    bandLimit,
    bitBudget,
    usesIndependentCoding,
    modeShift,
    availableBits,
    sumTotal,
    over7TotalWithinLimit,
  };
}

function captureProcWordsBandSnapshot(bandModes, bandSelectors, bandState) {
  return {
    bands: Array.from(bandModes),
    selectors: Array.from(bandSelectors),
    bandWork: Array.from(bandState.slice(0, 33)),
  };
}

export function saveProcWordsEntryDebug(
  debug,
  bandModes,
  bandSelectors,
  bandState,
  { bandLimit, bitBudget, modeShift, availableBits }
) {
  if (!debug || typeof debug !== "object") {
    return;
  }

  const { bands, selectors, bandWork } = captureProcWordsBandSnapshot(
    bandModes,
    bandSelectors,
    bandState
  );
  debug.commonEntry = {
    bandLimit,
    bitBudget,
    modeShift,
    availableBits,
    bands,
    selectors,
    bandWork,
  };
}

export function saveProcWordsCorrectionDebug(
  debug,
  bandModes,
  bandSelectors,
  bandBudgetTrail,
  remaining10
) {
  if (!debug || typeof debug !== "object") {
    return;
  }

  const { bands, selectors, bandWork } = captureProcWordsBandSnapshot(
    bandModes,
    bandSelectors,
    bandBudgetTrail
  );
  debug.afterRemaining = {
    remaining10,
    bands,
    selectors,
    bandWork,
  };
}

export function saveProcWordsPlanDebug(
  debug,
  bandModes,
  bandSelectors,
  bitCountSnapshot,
  { bitsUsed, totalAvailable, bandPriority }
) {
  if (!debug || typeof debug !== "object") {
    return;
  }

  const { bands, selectors, bandWork } = captureProcWordsBandSnapshot(
    bandModes,
    bandSelectors,
    bitCountSnapshot
  );
  debug.afterCountbits = {
    bitsUsed,
    totalAvailable,
    bands,
    selectors,
    bandWork,
    selectKey: Array.from(bandPriority),
  };
}

/**
 * Reclaims trailing proc units when tone layout and channel-conversion state
 * allow the tail headers to disappear without changing the authored tone
 * regions that still carry data.
 */
export function trimUnusedTrailingProcUnits(
  procWords,
  toneBlocks,
  availableBits,
  shouldTrimTrailingUnits
) {
  if (!shouldTrimTrailingUnits) {
    return availableBits;
  }

  const toneRegionCount = procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD];
  const initialUnitCount = procWords[AT3ENC_PROC_UNIT_COUNT_WORD];
  let activeUnitCount = initialUnitCount;

  while (activeUnitCount > 1) {
    const tailUnit = activeUnitCount - 1;
    if ((toneBlocks?.[tailUnit]?.entryCount ?? 0) !== 0) {
      break;
    }

    let unitHasToneRegion = false;
    for (let region = 0; region < toneRegionCount; region += 1) {
      if (procWords[at3encProcToneRegionFlagWord(region, tailUnit)] !== 0) {
        unitHasToneRegion = true;
        break;
      }
    }
    if (unitHasToneRegion) {
      break;
    }

    activeUnitCount -= 1;
  }

  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = activeUnitCount >>> 0;
  return availableBits + (initialUnitCount - activeUnitCount) * (toneRegionCount + 3);
}
