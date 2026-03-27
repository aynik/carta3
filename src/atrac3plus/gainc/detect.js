import {
  AT5_GAINC_ANALYSIS_ABS_OFFSET_F32,
  AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32,
  AT5_GAINC_ANALYSIS_TIMEWIN_OFFSET_F32,
  AT5_GAINC_BANDS_MAX,
  AT5_GAINC_SPECTRUM_F32_COUNT,
  AT5_GAINC_WINDOW_BLOCKS,
  AT5_GAINC_WINDOW_F32_PER_BLOCK,
  applyStereoCorrelationAdjustmentAt5,
  prepareGaincScaleWindowsAt5,
} from "./helpers.js";
import { getGaincBandHistory, sharedAuxU32View } from "./history.js";

import {
  expandGaincSplitCandidatesAt5,
  initializeGaincCandidateSearchAt5,
} from "./detect-search.js";

import {
  encodeGaincCurveToRecordEntries,
  finalizePreviousGaincCurve,
  pruneCurrentGaincPoints,
  writeGaincOutputRecord,
} from "./detect-prune.js";
import { AT5_GC_POINT_GROUP_ENTRIES, clearGaincEntryLinks } from "./point-layout.js";

import {
  createGaincDetectScratch,
  CURRENT_SCRATCH_GROUP_OFFSET,
  CURRENT_SCRATCH_SENTINEL_OFFSET,
  initializeGaincScratchCurves,
  NEXT_SCRATCH_GROUP_OFFSET,
  PREVIOUS_SCRATCH_GROUP_OFFSET,
  PREVIOUS_SCRATCH_SENTINEL_OFFSET,
  restoreGaincPointHistoryForBand,
  storeGaincPointHistoryForNextFrame,
} from "./detect-state.js";

const GAINC_DETECT_MAX_CHANNELS = 2;
const GAINC_DETECT_DEFAULT_CORR_START_BAND = 6;
const GAINC_WINDOW_HISTORY_LAST_INDEX = AT5_GAINC_WINDOW_BLOCKS * 2 - 1;
const GAINC_SCRATCH_GROUP_OFFSETS = [
  PREVIOUS_SCRATCH_GROUP_OFFSET,
  CURRENT_SCRATCH_GROUP_OFFSET,
  NEXT_SCRATCH_GROUP_OFFSET,
];

export function detectGaincDataNewAt5(
  channelBlocks,
  analysisPtrs,
  prevBufs, // unused (kept for signature parity with at3re callsite)
  curBufs,
  channelCount,
  bandCount,
  coreMode = 0
) {
  void prevBufs;
  void coreMode;
  if (!Array.isArray(channelBlocks) || !Array.isArray(analysisPtrs) || !Array.isArray(curBufs)) {
    return;
  }

  const channels = Math.max(0, Math.min(channelCount | 0, GAINC_DETECT_MAX_CHANNELS));
  const bands = Math.min(bandCount >>> 0, AT5_GAINC_BANDS_MAX);
  const auxU32 = sharedAuxU32View(channelBlocks[0]?.sharedAux ?? null);
  const corrStartBand = Math.max(
    auxU32 !== null ? auxU32[0] >>> 0 : GAINC_DETECT_DEFAULT_CORR_START_BAND,
    GAINC_DETECT_DEFAULT_CORR_START_BAND
  );
  const scratch = createGaincDetectScratch();
  const {
    candidateStates,
    currentDeltaSumByIndex,
    gains: scratchGains,
    locs: scratchLocs,
    newAbs: nextWindowAbs,
    orderedPeakIndices,
    scaleFactors: nextWindowScaleFactors,
    scratchBytes,
    view,
    windowAbsValues: scratchWindowAbs,
    windowScaleValues: scratchWindowScale,
  } = scratch;

  for (let band = 0; band < bands; band += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const block = channelBlocks[channel] ?? null;
      const outputBuffer = curBufs[channel] ?? null;
      const analysis = analysisPtrs[channel * AT5_GAINC_BANDS_MAX + band] ?? null;
      if (!block || !outputBuffer || !(analysis instanceof Float32Array)) {
        continue;
      }

      const runtimeHistory = getGaincBandHistory(block, band);
      if (!runtimeHistory) {
        continue;
      }

      const {
        pointGroupCounts,
        disabledPointCounts,
        gainLevelBounds,
        peakIndices,
        peakValues,
        windowAbs,
        windowScale,
        gainPointHistoryBytes,
      } = runtimeHistory;
      const previousPointCount = pointGroupCounts[0] >>> 0;
      const pointCounts = {
        current: pointGroupCounts[1] | 0,
        next: 0,
      };
      const pruneState = {
        currentDisabledCount: disabledPointCounts[1] | 0,
        nextDisabledCount: 0,
        currentDuplicateIndexCount: 0,
      };
      const previousPeakIndex = peakIndices[0] >>> 0;
      const carriedPeakIndex = peakIndices[1] | 0;
      const previousPeakValue = peakValues[0];
      const carriedPeakValue = peakValues[1];
      const previousTrailingWindowPeak = runtimeHistory.trailingWindowPeak;
      const record = outputBuffer.records?.[band] ?? null;

      // Phase 1: refresh the rolling window analysis and seed the split search.
      scratchWindowAbs.set(windowAbs);
      scratchWindowScale.set(windowScale);
      const { maxAbsIdx: nextPeakIndex, maxAbsVal: nextPeakValue } = prepareGaincScaleWindowsAt5({
        analysis,
        newAbs: nextWindowAbs,
        scaleFactors: nextWindowScaleFactors,
        windowBlocks: AT5_GAINC_WINDOW_BLOCKS,
        analysisAbsOffsetF32: AT5_GAINC_ANALYSIS_ABS_OFFSET_F32,
        analysisTimewinOffsetF32: AT5_GAINC_ANALYSIS_TIMEWIN_OFFSET_F32,
        windowF32PerBlock: AT5_GAINC_WINDOW_F32_PER_BLOCK,
      });

      scratchWindowScale[GAINC_WINDOW_HISTORY_LAST_INDEX] = nextWindowScaleFactors[1];
      const { candidateCount, searchStartBoundary, searchEndBoundary } =
        initializeGaincCandidateSearchAt5(
          orderedPeakIndices,
          candidateStates,
          scratchWindowAbs,
          previousPeakIndex,
          previousPeakValue,
          previousTrailingWindowPeak,
          carriedPeakIndex,
          carriedPeakValue,
          nextWindowAbs[0]
        );

      // Phase 2: rebuild the scratch curve pages, prune, and encode the retained curve.
      scratchBytes.fill(0);
      restoreGaincPointHistoryForBand(scratchBytes, gainPointHistoryBytes, band);
      for (const groupOffset of GAINC_SCRATCH_GROUP_OFFSETS) {
        clearGaincEntryLinks(view, groupOffset, AT5_GC_POINT_GROUP_ENTRIES);
      }

      expandGaincSplitCandidatesAt5(
        candidateCount,
        candidateStates,
        orderedPeakIndices,
        searchStartBoundary,
        searchEndBoundary,
        scratchWindowAbs,
        scratchWindowScale,
        CURRENT_SCRATCH_GROUP_OFFSET,
        pointCounts,
        view
      );
      pruneState.currentDuplicateIndexCount = initializeGaincScratchCurves(
        view,
        previousPointCount,
        pointCounts,
        currentDeltaSumByIndex
      );

      pruneCurrentGaincPoints(
        view,
        CURRENT_SCRATCH_SENTINEL_OFFSET,
        pointCounts,
        pruneState,
        currentDeltaSumByIndex
      );

      const { headOffset, minGain, maxGain } = finalizePreviousGaincCurve(
        view,
        PREVIOUS_SCRATCH_SENTINEL_OFFSET,
        PREVIOUS_SCRATCH_GROUP_OFFSET,
        previousPointCount
      );

      scratchLocs.fill(0);
      scratchGains.fill(0);
      const entryCount = encodeGaincCurveToRecordEntries(
        view,
        headOffset,
        minGain,
        maxGain,
        scratchLocs,
        scratchGains
      );

      if (record) {
        writeGaincOutputRecord(record, scratchLocs, scratchGains, entryCount);
      }

      // Phase 3: rotate the runtime history forward for the next frame.
      windowAbs.copyWithin(0, AT5_GAINC_WINDOW_BLOCKS);
      windowAbs.set(nextWindowAbs, AT5_GAINC_WINDOW_BLOCKS);

      windowScale.copyWithin(0, AT5_GAINC_WINDOW_BLOCKS, GAINC_WINDOW_HISTORY_LAST_INDEX);
      windowScale.set(nextWindowScaleFactors.subarray(1), AT5_GAINC_WINDOW_BLOCKS - 1);
      windowScale[GAINC_WINDOW_HISTORY_LAST_INDEX] = 0.0;

      runtimeHistory.trailingWindowPeak = scratchWindowAbs[AT5_GAINC_WINDOW_BLOCKS - 1];
      peakIndices[0] = carriedPeakIndex >>> 0;
      peakIndices[1] = nextPeakIndex >>> 0;
      peakValues[0] = carriedPeakValue;
      peakValues[1] = nextPeakValue;
      pointGroupCounts[0] = pointCounts.current >>> 0;
      pointGroupCounts[1] = pointCounts.next >>> 0;
      disabledPointCounts[0] = pruneState.currentDisabledCount >>> 0;
      disabledPointCounts[1] = pruneState.nextDisabledCount >>> 0;
      runtimeHistory.duplicatePointCount = pruneState.currentDuplicateIndexCount >>> 0;
      gainLevelBounds[0] = minGain >>> 0;
      gainLevelBounds[1] = maxGain >>> 0;
      storeGaincPointHistoryForNextFrame(view, scratchBytes, gainPointHistoryBytes, band);
    }

    applyStereoCorrelationAdjustmentAt5({
      band,
      channels,
      corrStartBand,
      channelBlocks,
      analysisPtrs,
      curBufs,
      auxU32,
      spectrumCount: AT5_GAINC_SPECTRUM_F32_COUNT,
      analysisFreqOffsetF32: AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32,
      bandsMax: AT5_GAINC_BANDS_MAX,
    });
  }
}
