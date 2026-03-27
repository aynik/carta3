import { fGt } from "./fp.js";
import { at5GaincSpikeCount } from "./passes.js";
import {
  ANALYSIS_DERIV_END,
  ANALYSIS_DERIV_OFFSET,
  ANALYSIS_MAXABS_OFFSET,
  PAIR_WORDS,
  SLOTS,
  TABLE0_WORDS,
  TABLE1_WORDS,
  maxAbsFloor4,
} from "./set-helpers.js";

const PRIMARY_WINDOW_CURRENT_OFFSET = SLOTS;
const PRIMARY_WINDOW_TAIL_INDEX = PRIMARY_WINDOW_CURRENT_OFFSET + SLOTS;
const DERIV_WINDOW_HISTORY_OFFSET = PAIR_WORDS;
const DERIV_WINDOW_CURRENT_OFFSET = DERIV_WINDOW_HISTORY_OFFSET + TABLE1_WORDS;
const DERIV_RELEASE_PEAK_PAIR_LIMIT = SLOTS - 3;
const SPIKE_HISTORY_LIMIT = 3;

function summarizePairPeaks(window, sourceOffset, output, releasePairLimit) {
  let peakIndex = 0;
  let releasePeakIndex = 0;
  let bestPeak = 0;
  let bestReleasePeak = 0;

  for (let pairStart = 0; pairStart < PAIR_WORDS; pairStart += 2) {
    const firstValue = window[sourceOffset + pairStart] ?? 0;
    const secondValue = window[sourceOffset + pairStart + 1] ?? 0;
    const useSecondValue = fGt(secondValue, firstValue);
    const pairPeak = useSecondValue ? secondValue : firstValue;
    const pairPeakIndex = pairStart + (useSecondValue ? 1 : 0);

    output[pairStart] = pairPeak;
    output[pairStart + 1] = pairPeak;

    if (fGt(pairPeak, bestPeak)) {
      bestPeak = pairPeak;
      peakIndex = pairPeakIndex;
    }
    if ((pairStart | 0) <= (releasePairLimit | 0) && fGt(pairPeak, bestReleasePeak)) {
      bestReleasePeak = pairPeak;
      releasePeakIndex = pairPeakIndex;
    }
  }

  return {
    peakIndex,
    releasePeakIndex,
  };
}

function writeSlotPeaks(window, windowOffset, values, valueOffset) {
  let sum = 0;

  for (let slot = 0; slot < SLOTS; slot += 1) {
    const slotPeak = maxAbsFloor4(values, valueOffset + slot * 4, 4);
    window[windowOffset + slot] = slotPeak;
    sum += slotPeak;
  }

  return sum;
}

export function analyzeGainWindows(
  block,
  analysis,
  bandIndex,
  withFrac,
  prev,
  cur,
  ampWindow,
  derivVals,
  derivWindow,
  ampPairs
) {
  const table0Base = (bandIndex | 0) * TABLE0_WORDS;
  ampWindow.set(block.table0.subarray(table0Base, table0Base + TABLE0_WORDS));

  const sumAmp = writeSlotPeaks(
    ampWindow,
    PRIMARY_WINDOW_CURRENT_OFFSET,
    analysis,
    ANALYSIS_MAXABS_OFFSET
  );
  ampWindow[PRIMARY_WINDOW_TAIL_INDEX] = 0;
  block.table0.set(
    ampWindow.subarray(PRIMARY_WINDOW_CURRENT_OFFSET, PRIMARY_WINDOW_CURRENT_OFFSET + TABLE0_WORDS),
    table0Base
  );

  cur.minTail = fGt(ampWindow[SLOTS - 1], ampWindow[SLOTS - 2])
    ? ampWindow[SLOTS - 1]
    : ampWindow[SLOTS - 2];

  const spikeCount = at5GaincSpikeCount(ampWindow);
  const noisyHist =
    (prev.histA | 0) > SPIKE_HISTORY_LIMIT ||
    (prev.histB | 0) > SPIKE_HISTORY_LIMIT ||
    spikeCount > SPIKE_HISTORY_LIMIT;
  const primaryPairs = summarizePairPeaks(ampWindow, 0, ampPairs, SLOTS - 2);

  let prevSumAmp = 0;
  let prevSumDeriv = 0;
  let sumDeriv = 0;
  let derivPeakIdx = 0;

  if (withFrac) {
    for (let i = ANALYSIS_DERIV_OFFSET; i < ANALYSIS_DERIV_END; i += 1) {
      derivVals[i] = (analysis[i - 1] - analysis[i]) * 0.5;
    }

    const table1Base = (bandIndex | 0) * TABLE1_WORDS;
    derivWindow.set(
      block.table1.subarray(table1Base, table1Base + TABLE1_WORDS),
      DERIV_WINDOW_HISTORY_OFFSET
    );
    sumDeriv = writeSlotPeaks(
      derivWindow,
      DERIV_WINDOW_CURRENT_OFFSET,
      derivVals,
      ANALYSIS_DERIV_OFFSET
    );
    block.table1.set(
      derivWindow.subarray(DERIV_WINDOW_CURRENT_OFFSET, DERIV_WINDOW_CURRENT_OFFSET + TABLE1_WORDS),
      table1Base
    );

    cur.ampSlotMaxSum = sumAmp;
    cur.derivSlotMaxSum = sumDeriv;
    prevSumAmp = prev.ampSlotMaxSum ?? 0;
    prevSumDeriv = prev.derivSlotMaxSum ?? 0;
    derivPeakIdx = summarizePairPeaks(
      derivWindow,
      DERIV_WINDOW_HISTORY_OFFSET,
      derivWindow,
      DERIV_RELEASE_PEAK_PAIR_LIMIT
    ).releasePeakIndex;
  }

  return {
    noisyHist,
    prevHistB: prev.histB | 0,
    prevSumAmp,
    prevSumDeriv,
    spikeCount,
    sumAmp,
    sumDeriv,
    ampPeakIdx: primaryPairs.peakIndex,
    releasePeakIdx: primaryPairs.releasePeakIndex,
    derivPeakIdx,
  };
}
