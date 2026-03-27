import { AT3ENC_PROC_TABLE_1, AT3ENC_PROC_TABLE_2 } from "./encode-tables.js";
import {
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_TONE_REGION_WORD_STRIDE,
  AT3ENC_PROC_TONE_SCALE_WORD,
  AT3ENC_PROC_TONE_START_WORD,
  AT3ENC_PROC_TONE_WORD_STRIDE,
  at3encProcToneRegionFlagWord,
  at3encProcToneRegionRowCountWord,
  at3encProcToneRegionRowPtrWord,
  at3encProcToneRegionSymMaxWord,
  at3encProcToneWord,
} from "./proc-layout.js";
import { tableBitlen } from "./proc-quant-scale.js";
import {
  AT3_TONE_PASS_SINGLE_LAYOUT,
  AT3_TONE_PASS_SPLIT_LAYOUT,
  AT3_TONE_REGION_COUNT_DUAL,
  AT3_TONE_REGION_COUNT_SINGLE,
  AT3_TONE_REGION_PRIMARY,
  AT3_TONE_REGION_SECONDARY,
  AT3_TONE_ROW_GROUP_COUNT,
} from "./proc-tone-common.js";

const AT3_MONO_LOW_BUDGET_INITIAL_TAIL_WIDTH = 3;
const AT3_MONO_LOW_BUDGET_MAX_TONES = 0x40;
const AT3_MONO_LOW_BUDGET_TAIL_SPLIT_OFFSET = 2;
const AT3_MONO_LOW_BUDGET_TAIL_FIRST_COEFF_WORD = 2;
const AT3_MONO_LOW_BUDGET_TAIL_LAST_COEFF_WORD = 3;
const AT3_MONO_LOW_BUDGET_GROUP_MASK = 0x3f;
const AT3_MONO_LOW_BUDGET_ROW_CAPACITY = 7;
const AT3_MONO_LOW_BUDGET_TWO_REGION_BASE_BITS = 0x18;
const AT3_MONO_LOW_BUDGET_SPLIT_ZERO_RATIO = 6;
const AT3_MONO_LOW_BUDGET_SPLIT_COSTA_NONZERO_BIAS = 14;
const AT3_MONO_LOW_BUDGET_SPLIT_COSTB_SCALE = 3;

function shrinkMonoLowBudgetSingleRegionTail(procWords, toneCount, primarySymMaxWord) {
  let tailWidth = procWords[primarySymMaxWord];

  while (tailWidth > 0) {
    let requiresRemainingTailCoeff = false;

    for (let toneIndex = toneCount - 1; toneIndex >= 0; toneIndex -= 1) {
      const toneWord = at3encProcToneWord(toneIndex);
      const trimmedCoeffWord = toneWord + tailWidth;
      if (procWords[trimmedCoeffWord] !== 0) {
        procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] += 1;
        procWords.copyWithin(toneWord, toneWord + 1, trimmedCoeffWord + 1);
      }

      const toneStart = procWords[toneWord + AT3ENC_PROC_TONE_START_WORD];
      if (
        procWords[toneWord + tailWidth - 1] !== 0 &&
        (procWords[toneWord] !== 0 ||
          (toneStart & AT3_MONO_LOW_BUDGET_GROUP_MASK) === AT3_MONO_LOW_BUDGET_GROUP_MASK)
      ) {
        requiresRemainingTailCoeff = true;
      }
    }

    tailWidth -= 1;
    procWords[primarySymMaxWord] = tailWidth;
    if (requiresRemainingTailCoeff) {
      break;
    }
  }

  return (AT3_MONO_LOW_BUDGET_INITIAL_TAIL_WIDTH - procWords[primarySymMaxWord]) * toneCount;
}

function retuneMonoLowBudgetSplitCosts(
  toneCount,
  zeroLastCount,
  singleRegionCost,
  splitRegionCost
) {
  const nonzeroTailCount = toneCount - zeroLastCount;
  if (zeroLastCount <= nonzeroTailCount * AT3_MONO_LOW_BUDGET_SPLIT_ZERO_RATIO) {
    return null;
  }

  const retunedSingleRegionCost =
    singleRegionCost +
    nonzeroTailCount * AT3_MONO_LOW_BUDGET_SPLIT_COSTA_NONZERO_BIAS -
    zeroLastCount;
  const retunedSplitRegionCost =
    splitRegionCost +
    (nonzeroTailCount * AT3_MONO_LOW_BUDGET_SPLIT_ZERO_RATIO - zeroLastCount) *
      AT3_MONO_LOW_BUDGET_SPLIT_COSTB_SCALE;

  return Math.min(retunedSingleRegionCost, retunedSplitRegionCost) <
    Math.min(singleRegionCost, splitRegionCost)
    ? {
        singleRegionCost: retunedSingleRegionCost,
        splitRegionCost: retunedSplitRegionCost,
      }
    : null;
}

function mirrorMonoLowBudgetPrimaryRegion(procWords) {
  procWords.copyWithin(
    at3encProcToneRegionFlagWord(AT3_TONE_REGION_SECONDARY, 0),
    at3encProcToneRegionFlagWord(AT3_TONE_REGION_PRIMARY, 0),
    at3encProcToneRegionFlagWord(AT3_TONE_REGION_PRIMARY, 0) + AT3ENC_PROC_TONE_REGION_WORD_STRIDE
  );
}

function collectMonoLowBudgetTailSplitPlans(procWords, toneCount) {
  const reservedRowCounts = new Uint8Array(AT3_TONE_ROW_GROUP_COUNT);
  const splitPlans = [];

  for (let toneIndex = 0; toneIndex < toneCount; toneIndex += 1) {
    const sourceToneWord = at3encProcToneWord(toneIndex);
    if (procWords[sourceToneWord + AT3_MONO_LOW_BUDGET_TAIL_LAST_COEFF_WORD] === 0) {
      continue;
    }

    const splitStart =
      procWords[sourceToneWord + AT3ENC_PROC_TONE_START_WORD] +
      AT3_MONO_LOW_BUDGET_TAIL_SPLIT_OFFSET;
    const block = splitStart >> 8;
    const group = splitStart >> 6;
    const rowCountWord = at3encProcToneRegionRowCountWord(AT3_TONE_REGION_SECONDARY, group);
    const reservedCount = reservedRowCounts[group];

    if (
      splitStart >= 0x3fe ||
      procWords[at3encProcToneRegionFlagWord(AT3_TONE_REGION_SECONDARY, block)] === 0 ||
      toneCount + splitPlans.length >= AT3_MONO_LOW_BUDGET_MAX_TONES ||
      procWords[rowCountWord] + reservedCount >= AT3_MONO_LOW_BUDGET_ROW_CAPACITY
    ) {
      return null;
    }

    reservedRowCounts[group] = reservedCount + 1;
    splitPlans.push({ sourceToneWord, splitStart, group });
  }

  return splitPlans;
}

function applyMonoLowBudgetTailSplitPlans(procWords, toneCount, splitPlans) {
  let splitToneWord = at3encProcToneWord(toneCount);

  for (const { sourceToneWord, splitStart, group } of splitPlans) {
    const rowCountWord = at3encProcToneRegionRowCountWord(AT3_TONE_REGION_SECONDARY, group);
    const slot = procWords[rowCountWord];
    procWords[rowCountWord] = slot + 1;

    procWords[splitToneWord + AT3ENC_PROC_TONE_SCALE_WORD] =
      procWords[sourceToneWord + AT3ENC_PROC_TONE_SCALE_WORD];
    procWords[splitToneWord + 0] =
      procWords[sourceToneWord + AT3_MONO_LOW_BUDGET_TAIL_FIRST_COEFF_WORD];
    procWords[splitToneWord + 1] =
      procWords[sourceToneWord + AT3_MONO_LOW_BUDGET_TAIL_LAST_COEFF_WORD];
    procWords[splitToneWord + 2] = 0;
    procWords[splitToneWord + 3] = 0;
    procWords[splitToneWord + AT3ENC_PROC_TONE_START_WORD] = splitStart;

    procWords[sourceToneWord + AT3_MONO_LOW_BUDGET_TAIL_FIRST_COEFF_WORD] = 0;
    procWords[sourceToneWord + AT3_MONO_LOW_BUDGET_TAIL_LAST_COEFF_WORD] = 0;

    const region1SlotsWord = at3encProcToneRegionRowPtrWord(AT3_TONE_REGION_SECONDARY, group, 0);
    procWords[region1SlotsWord + slot] = splitToneWord;
    splitToneWord += AT3ENC_PROC_TONE_WORD_STRIDE;
  }

  return toneCount + splitPlans.length;
}

/**
 * Chooses the final mono low-budget tone layout after extraction.
 *
 * This stage keeps the provisional tone pool but decides whether the final
 * authored layout is one trimmed primary region or a two-region split where
 * nonzero tails move into the secondary region.
 */
export function finalizeMonoLowBudgetToneCoding(procWords, toneCount, toneBitsCost, zeroLastCount) {
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = AT3_TONE_REGION_COUNT_SINGLE;

  let singleRegionCost = toneBitsCost;
  let splitRegionCost = toneCount * AT3_MONO_LOW_BUDGET_TWO_REGION_BASE_BITS;
  const primarySymMaxWord = at3encProcToneRegionSymMaxWord(AT3_TONE_REGION_PRIMARY);
  const region0SymbolBits = tableBitlen(AT3ENC_PROC_TABLE_1, 0);
  const region1SymbolBits = tableBitlen(AT3ENC_PROC_TABLE_2, 0);

  if (zeroLastCount === toneCount) {
    const droppedSymbolCount = shrinkMonoLowBudgetSingleRegionTail(
      procWords,
      toneCount,
      primarySymMaxWord
    );
    singleRegionCost -= region0SymbolBits * droppedSymbolCount;
    splitRegionCost -= region1SymbolBits * droppedSymbolCount;
  } else {
    const retunedCosts = retuneMonoLowBudgetSplitCosts(
      toneCount,
      zeroLastCount,
      singleRegionCost,
      splitRegionCost
    );
    if (retunedCosts !== null) {
      mirrorMonoLowBudgetPrimaryRegion(procWords);
      const splitPlans = collectMonoLowBudgetTailSplitPlans(procWords, toneCount);
      if (splitPlans !== null) {
        toneCount = applyMonoLowBudgetTailSplitPlans(procWords, toneCount, splitPlans);
        singleRegionCost = retunedCosts.singleRegionCost;
        splitRegionCost = retunedCosts.splitRegionCost;
        procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = AT3_TONE_REGION_COUNT_DUAL;
      }
    }
  }

  const usesSplitLayout = splitRegionCost < singleRegionCost;
  procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = usesSplitLayout
    ? AT3_TONE_PASS_SPLIT_LAYOUT
    : AT3_TONE_PASS_SINGLE_LAYOUT;
  const chosen = usesSplitLayout ? splitRegionCost : singleRegionCost;
  return { toneCount, costA: singleRegionCost, costB: splitRegionCost, chosen };
}
