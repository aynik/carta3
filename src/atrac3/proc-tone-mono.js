import { AT3_SPCODE_SCALE_TABLE } from "./decode-tables.js";
import {
  AT3_DBA_LEVEL_TABLE,
  AT3_SFB_OFFSETS,
  AT3_SFB_WIDTHS,
  AT3ENC_PROC_TABLE_1,
} from "./encode-tables.js";
import {
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_TONE_START_WORD,
  AT3ENC_PROC_TONE_WORD_STRIDE,
  AT3ENC_PROC_UNIT_COUNT_WORD,
  at3encAppendToneRegionRowTone,
  at3encClearToneRegionScratch,
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
  at3encProcToneRegionFlagWord,
  at3encProcToneRegionModeWord,
  at3encProcToneRegionRowCountWord,
  at3encProcToneRegionSymMaxWord,
  at3encProcToneWord,
} from "./proc-layout.js";
import { finalizeMonoLowBudgetToneCoding } from "./proc-tone-mono-layout.js";
import {
  AT3_TONE_PASS_SINGLE_LAYOUT,
  AT3_TONE_REGION_COUNT_NONE,
  AT3_TONE_REGION_PRIMARY,
  quantizeToneWord,
  restoreToneContribution,
} from "./proc-tone-common.js";

const AT3_SPCODE_SCALE_TABLE_U32 = new Uint32Array(
  AT3_SPCODE_SCALE_TABLE.buffer,
  AT3_SPCODE_SCALE_TABLE.byteOffset,
  AT3_SPCODE_SCALE_TABLE.length
);
const F32_CANONICAL_NAN_BITS = 0x7fc00000;
const AT3_MONO_LOW_BUDGET_BASE_HEADER_BITS = 8;
const AT3_MONO_LOW_BUDGET_FIRST_FULL_SCAN_BAND = 8;
const AT3_MONO_LOW_BUDGET_HEADER_BUDGET_RESERVE = 600;
const AT3_MONO_LOW_BUDGET_METRIC_GATE = 0x4ff;
export const AT3_MONO_LOW_BUDGET_MIN_FULL_SCAN_BITS = 0x44c;
export const AT3_MONO_LOW_BUDGET_MAX_TONES = 0x40;
const AT3_MONO_LOW_BUDGET_PRESENCE_BITS = 0x0c;
const AT3_MONO_LOW_BUDGET_REGION_MODE = 3;
const AT3_MONO_LOW_BUDGET_REGION_SYMBOL_LIMIT = 3;

function initializeMonoLowBudgetToneLayout(procWords) {
  procWords[at3encProcToneRegionModeWord(AT3_TONE_REGION_PRIMARY)] =
    AT3_MONO_LOW_BUDGET_REGION_MODE;
  procWords[at3encProcToneRegionSymMaxWord(AT3_TONE_REGION_PRIMARY)] =
    AT3_MONO_LOW_BUDGET_REGION_SYMBOL_LIMIT;
  procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = AT3_TONE_PASS_SINGLE_LAYOUT;
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = AT3_TONE_REGION_COUNT_NONE;
}

function resolveMonoLowBudgetThresholdKey(width, bandStart, bandMode, bandSelector, bandMetric) {
  const blockClass = width === 0x20 ? 1 : bandStart >> 8;
  const modeForThreshold = bandMetric > AT3_MONO_LOW_BUDGET_METRIC_GATE ? bandMode : 0;
  const thresholdIndex = Math.max(
    0,
    bandSelector - AT3_DBA_LEVEL_TABLE[modeForThreshold + blockClass * 8]
  );
  return ((AT3_SPCODE_SCALE_TABLE_U32[thresholdIndex] ?? F32_CANONICAL_NAN_BITS) << 1) >>> 0;
}

function claimMonoLowBudgetBandOverlap(
  procWords,
  bandModes,
  toneClaimSelectors,
  toneClaimWidths,
  toneCount,
  band,
  bandStart,
  bandSelector
) {
  if (toneCount === 0) {
    return bandStart;
  }

  const prevToneWord = at3encProcToneWord(toneCount - 1);
  const prevStart = procWords[prevToneWord + AT3ENC_PROC_TONE_START_WORD];
  if (bandStart >= prevStart + 4) {
    return bandStart;
  }

  const overlapWidth = prevStart - bandStart + 4;
  toneClaimSelectors[band] = bandSelector;
  toneClaimWidths[band] = overlapWidth;
  toneClaimWidths[band - 1] += overlapWidth - 4;
  bandModes[band] = 0;
  return prevStart + 4;
}

function collectMonoLowBudgetBandCandidates(
  spectrumU32,
  scanStart,
  bandEnd,
  thresholdKey,
  maxCandidates
) {
  const candidates = [];

  for (let cursor = scanStart; cursor < bandEnd; cursor += 1) {
    if ((spectrumU32[cursor] << 1) >>> 0 < thresholdKey) {
      continue;
    }

    if (candidates.length === maxCandidates) {
      return null;
    }

    candidates.push(cursor);
    cursor += 3;
  }

  return candidates;
}

function realignAdjacentMonoToneStart(spectrum, procWords, toneCount, toneStart) {
  let toneLen = 4;
  if (toneCount === 0) {
    return { toneStart, toneLen };
  }

  const prevToneWord = at3encProcToneWord(toneCount - 1);
  const prevStart = procWords[prevToneWord + AT3ENC_PROC_TONE_START_WORD];
  if (prevStart + 4 !== toneStart) {
    return { toneStart, toneLen };
  }

  do {
    if (Math.abs(spectrum[toneStart - 1]) < Math.abs(spectrum[toneStart + 3])) {
      break;
    }
    toneStart -= 1;
    toneLen -= 1;
  } while (toneLen > 1);

  return { toneStart, toneLen };
}

function shiftMonoLowBudgetLeadingZeros(spectrum, procWords, toneWord, toneStart, bandEnd) {
  if (procWords[toneWord] !== 0) {
    return toneStart;
  }

  let firstNonzero = 1;
  while (firstNonzero < 4 && procWords[toneWord + firstNonzero] === 0) {
    firstNonzero += 1;
  }

  const shiftedStart = toneStart + firstNonzero;
  if (shiftedStart >= bandEnd || shiftedStart >= 0x3fd) {
    restoreToneContribution(spectrum, procWords, toneWord, 3, 3);
    return -1;
  }

  procWords.copyWithin(toneWord, toneWord + firstNonzero, toneWord + 4);
  procWords.fill(0, toneWord + 4 - firstNonzero, toneWord + 4);
  procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] = shiftedStart >>> 0;
  return shiftedStart;
}

/**
 * Scans eligible mono low-budget bands for tone candidates, claims selector
 * ownership for bands that hand energy to the tone path, and writes the
 * provisional primary tone region before the later acceptance/layout pass.
 */
export function scanMonoLowBudgetTones(
  layer,
  procWords,
  bandLimit,
  bandWork,
  availableBits,
  toneClaimSelectors,
  toneClaimWidths
) {
  const spectrum = layer.spectrum;
  const spectrumU32 = new Uint32Array(spectrum.buffer, spectrum.byteOffset, spectrum.length);
  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);
  let headerBits = AT3_MONO_LOW_BUDGET_BASE_HEADER_BITS;
  let toneCount = 0;
  let toneBitsCost = 0;
  let zeroLastCount = 0;
  const firstEligibleBand =
    availableBits < AT3_MONO_LOW_BUDGET_MIN_FULL_SCAN_BITS
      ? AT3_MONO_LOW_BUDGET_FIRST_FULL_SCAN_BAND
      : 0;

  at3encClearToneRegionScratch(procWords);
  initializeMonoLowBudgetToneLayout(procWords);

  for (let band = firstEligibleBand; band < bandLimit; band += 1) {
    const width = AT3_SFB_WIDTHS[band];
    const tonePoolCost = toneCount * AT3ENC_PROC_TONE_WORD_STRIDE * Uint32Array.BYTES_PER_ELEMENT;
    if (
      AT3_MONO_LOW_BUDGET_MAX_TONES - (width >> 4) < toneCount ||
      availableBits - AT3_MONO_LOW_BUDGET_HEADER_BUDGET_RESERVE < headerBits + tonePoolCost
    ) {
      break;
    }

    const bandMode = bandModes[band];
    if (bandMode === 0) {
      continue;
    }

    const bandStart = AT3_SFB_OFFSETS[band];
    const bandEnd = AT3_SFB_OFFSETS[band + 1];
    const bandSelector = bandSelectors[band];
    const thresholdKey = resolveMonoLowBudgetThresholdKey(
      width,
      bandStart,
      bandMode,
      bandSelector,
      bandWork[band + 1]
    );
    const scanStart = claimMonoLowBudgetBandOverlap(
      procWords,
      bandModes,
      toneClaimSelectors,
      toneClaimWidths,
      toneCount,
      band,
      bandStart,
      bandSelector
    );
    const candidates = collectMonoLowBudgetBandCandidates(
      spectrumU32,
      scanStart,
      bandEnd,
      thresholdKey,
      (width + 8) >> 4
    );

    if (candidates === null || candidates.length === 0) {
      continue;
    }

    if (toneClaimSelectors[band] < 0) {
      toneClaimSelectors[band] = bandSelector;
      toneClaimWidths[band] = 0;
      bandModes[band] = 0;
    }

    for (const candidate of candidates) {
      if (toneCount >= AT3_MONO_LOW_BUDGET_MAX_TONES) {
        break;
      }

      const toneWord = at3encProcToneWord(toneCount);
      let { toneStart, toneLen } = realignAdjacentMonoToneStart(
        spectrum,
        procWords,
        toneCount,
        Math.min(candidate, 0x3fc)
      );
      const toneRow = toneStart >> 6;
      const countWord = at3encProcToneRegionRowCountWord(AT3_TONE_REGION_PRIMARY, toneRow);
      if (procWords[countWord] > 6) {
        continue;
      }

      const toneBits = quantizeToneWord(
        spectrum,
        spectrumU32,
        procWords,
        toneWord,
        toneStart,
        3,
        7,
        AT3ENC_PROC_TABLE_1,
        0x0c
      );
      if (toneBits < 0) {
        continue;
      }

      toneStart = shiftMonoLowBudgetLeadingZeros(spectrum, procWords, toneWord, toneStart, bandEnd);
      if (toneStart < 0) {
        break;
      }

      toneBitsCost += toneBits;
      toneClaimWidths[band] += toneLen;

      const presenceWord = at3encProcToneRegionFlagWord(AT3_TONE_REGION_PRIMARY, toneStart >> 8);
      if (procWords[presenceWord] === 0) {
        procWords[presenceWord] = 1;
        headerBits += AT3_MONO_LOW_BUDGET_PRESENCE_BITS;
      }

      at3encAppendToneRegionRowTone(procWords, AT3_TONE_REGION_PRIMARY, toneRow, toneWord);
      zeroLastCount += procWords[toneWord + 3] === 0 ? 1 : 0;
      toneCount += 1;
    }
  }

  return {
    headerBits,
    toneCount,
    toneBitsCost,
    zeroLastCount,
  };
}

/**
 * Extracts mono low-budget tones, tracks which non-tone bands lose ownership
 * of their selectors, and picks the final tone region layout when tones were
 * accepted.
 */
export function extractMonoLowBudgetTones(
  layer,
  procWords,
  bandLimit,
  bandWork,
  availableBits,
  toneClaimSelectors,
  toneClaimWidths,
  debug = null
) {
  const initialBlockCount = procWords[AT3ENC_PROC_UNIT_COUNT_WORD];
  let { headerBits, toneCount, toneBitsCost, zeroLastCount } = scanMonoLowBudgetTones(
    layer,
    procWords,
    bandLimit,
    bandWork,
    availableBits,
    toneClaimSelectors,
    toneClaimWidths
  );

  const firstToneWord = at3encProcToneWord(0);
  const firstToneStart = procWords[firstToneWord + AT3ENC_PROC_TONE_START_WORD];
  if (
    toneCount === 1 &&
    (availableBits < AT3_MONO_LOW_BUDGET_MIN_FULL_SCAN_BITS || firstToneStart < 0x80)
  ) {
    restoreToneContribution(
      layer.spectrum,
      procWords,
      firstToneWord,
      procWords[at3encProcToneRegionModeWord(AT3_TONE_REGION_PRIMARY)],
      3
    );
    toneCount = 0;
  }

  if (toneCount > 0) {
    const decision = finalizeMonoLowBudgetToneCoding(
      procWords,
      toneCount,
      toneBitsCost,
      zeroLastCount
    );
    toneCount = decision.toneCount;
    if (debug && typeof debug === "object") {
      debug.toneDecision = {
        toneCount,
        zeroLastCount,
        headerBits,
        initialBlockCount,
        costA: decision.costA,
        costB: decision.costB,
        chosen: decision.chosen,
        toneFlag: procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD],
        toneRegionCount: procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD],
      };
    }
    const toneTotalBits = headerBits + initialBlockCount + decision.chosen;
    return availableBits - toneTotalBits;
  }

  return availableBits;
}
