import { AT5_GAINC_WINDOW_BLOCKS } from "./helpers.js";
import {
  AT5_GC_POINT_FIELDS as POINT,
  AT5_GC_POINT_ENTRY_STRIDE_BYTES,
  AT5_GC_POINT_GROUP_STRIDE_BYTES,
  clearGaincEntryLinks,
  insertGaincEntryByIndex,
  readGaincPoint as readPoint,
  readGaincPointFlag as readFlag,
  readGaincPointLink as readLink,
  writeGaincPointLink as writeLink,
} from "./point-layout.js";

import { AT5_GAINC_CANDIDATE_STATE_COUNT, createGaincCandidateState } from "./detect-search.js";

const GAINC_SCRATCH_SENTINEL_COUNT = 3;
const GAINC_SCRATCH_SENTINEL_BYTES = GAINC_SCRATCH_SENTINEL_COUNT * AT5_GC_POINT_ENTRY_STRIDE_BYTES;

export const PREVIOUS_SCRATCH_SENTINEL_OFFSET = 0;
export const PREVIOUS_SCRATCH_GROUP_OFFSET = GAINC_SCRATCH_SENTINEL_BYTES;
export const CURRENT_SCRATCH_SENTINEL_OFFSET = AT5_GC_POINT_ENTRY_STRIDE_BYTES;
export const CURRENT_SCRATCH_GROUP_OFFSET =
  PREVIOUS_SCRATCH_GROUP_OFFSET + AT5_GC_POINT_GROUP_STRIDE_BYTES;
export const NEXT_SCRATCH_SENTINEL_OFFSET = AT5_GC_POINT_ENTRY_STRIDE_BYTES * 2;
export const NEXT_SCRATCH_GROUP_OFFSET =
  CURRENT_SCRATCH_GROUP_OFFSET + AT5_GC_POINT_GROUP_STRIDE_BYTES;
export const GAINC_SCRATCH_BYTES = NEXT_SCRATCH_GROUP_OFFSET + AT5_GC_POINT_GROUP_STRIDE_BYTES;

const GAINC_HISTORY_PAGE_BYTES = AT5_GC_POINT_GROUP_STRIDE_BYTES;
const AT5_GAIN_POINT_HISTORY_CURRENT_OFFSET = GAINC_HISTORY_PAGE_BYTES;
const AT5_GAIN_POINT_HISTORY_BAND_BYTES = GAINC_HISTORY_PAGE_BYTES * 2;
const GAINC_HISTORY_TO_SCRATCH_PAGES = [
  [0, PREVIOUS_SCRATCH_GROUP_OFFSET],
  [AT5_GAIN_POINT_HISTORY_CURRENT_OFFSET, CURRENT_SCRATCH_GROUP_OFFSET],
];
const GAINC_SCRATCH_TO_HISTORY_PAGES = [
  [0, CURRENT_SCRATCH_GROUP_OFFSET],
  [AT5_GAIN_POINT_HISTORY_CURRENT_OFFSET, NEXT_SCRATCH_GROUP_OFFSET],
];

function gaincPointHistoryBandOffset(band) {
  return band * AT5_GAIN_POINT_HISTORY_BAND_BYTES;
}

export function restoreGaincPointHistoryForBand(scratchBytes, gainPointHistoryBytes, band) {
  const bandOffset = gaincPointHistoryBandOffset(band);
  for (const [historyOffset, groupOffset] of GAINC_HISTORY_TO_SCRATCH_PAGES) {
    scratchBytes.set(
      gainPointHistoryBytes.subarray(
        bandOffset + historyOffset,
        bandOffset + historyOffset + GAINC_HISTORY_PAGE_BYTES
      ),
      groupOffset
    );
  }
}

function clearGaincScratchSentinels(view) {
  new Uint8Array(view.buffer, view.byteOffset, GAINC_SCRATCH_SENTINEL_BYTES).fill(0);
}

function gaincScratchPointOffset(groupOffset, pointIndex) {
  return (groupOffset + pointIndex * AT5_GC_POINT_ENTRY_STRIDE_BYTES) | 0;
}

function buildGaincSortedScratchCurve(view, sentinelOffset, groupOffset, pointCount) {
  let tailOffset = null;
  for (let i = 0; i < (pointCount | 0); i += 1) {
    const pointOffset = gaincScratchPointOffset(groupOffset, i);
    if (readFlag(view, pointOffset, POINT.DISABLED)) {
      continue;
    }
    tailOffset = insertGaincEntryByIndex(view, sentinelOffset, tailOffset, pointOffset);
  }
  return tailOffset;
}

export function initializeGaincScratchCurves(
  view,
  previousPointCount,
  pointWindowCounts,
  currentDeltaSumByIndex
) {
  const retainedPointCount = previousPointCount | 0;
  const currentPointCount = pointWindowCounts.current | 0;
  const nextPointCount = pointWindowCounts.next | 0;

  clearGaincScratchSentinels(view);
  buildGaincSortedScratchCurve(
    view,
    PREVIOUS_SCRATCH_SENTINEL_OFFSET,
    PREVIOUS_SCRATCH_GROUP_OFFSET,
    retainedPointCount
  );
  const currentTailOffset = buildGaincSortedScratchCurve(
    view,
    CURRENT_SCRATCH_SENTINEL_OFFSET,
    CURRENT_SCRATCH_GROUP_OFFSET,
    currentPointCount
  );
  buildGaincSortedScratchCurve(
    view,
    NEXT_SCRATCH_SENTINEL_OFFSET,
    NEXT_SCRATCH_GROUP_OFFSET,
    nextPointCount
  );

  // Only the current page's copied history entries begin on the active prune list.
  // Freshly emitted current-page points join the sorted curve immediately but stay
  // out of the active list until a later frame carries them forward.
  let retainedActiveHead = null;
  for (let pointIndex = 0; pointIndex < retainedPointCount; pointIndex += 1) {
    const pointOffset = gaincScratchPointOffset(CURRENT_SCRATCH_GROUP_OFFSET, pointIndex);
    if (readLink(view, pointOffset, POINT.PREV_BY_INDEX) !== null) {
      continue;
    }
    writeLink(view, pointOffset, POINT.NEXT_ACTIVE, retainedActiveHead);
    retainedActiveHead = pointOffset;
  }
  writeLink(view, CURRENT_SCRATCH_SENTINEL_OFFSET, POINT.NEXT_ACTIVE, retainedActiveHead);

  currentDeltaSumByIndex.fill(0);
  let duplicateIndexCount = 0;
  let lastPointIndex = -1;
  for (
    let pointOffset = currentTailOffset;
    pointOffset !== null;
    pointOffset = readLink(view, pointOffset, POINT.PREV_BY_INDEX)
  ) {
    const pointIndex = readPoint(view, pointOffset, POINT.INDEX) | 0;
    if (pointIndex === lastPointIndex) {
      duplicateIndexCount += 1;
    }
    if (pointIndex >>> 0 < AT5_GAINC_WINDOW_BLOCKS) {
      currentDeltaSumByIndex[pointIndex] =
        (currentDeltaSumByIndex[pointIndex] + (readPoint(view, pointOffset, POINT.DELTA) | 0)) | 0;
    }
    lastPointIndex = pointIndex;
  }

  return duplicateIndexCount | 0;
}

export function storeGaincPointHistoryForNextFrame(
  view,
  scratchBytes,
  gainPointHistoryBytes,
  band
) {
  // Legacy behavior: omitting `entryCount` preserves link-offset bytes in history.
  // Do not "fix" this without updating baselines.
  clearGaincEntryLinks(view, CURRENT_SCRATCH_GROUP_OFFSET);
  clearGaincEntryLinks(view, NEXT_SCRATCH_GROUP_OFFSET);

  const bandOffset = gaincPointHistoryBandOffset(band);
  for (const [historyOffset, groupOffset] of GAINC_SCRATCH_TO_HISTORY_PAGES) {
    gainPointHistoryBytes.set(
      scratchBytes.subarray(groupOffset, groupOffset + GAINC_HISTORY_PAGE_BYTES),
      bandOffset + historyOffset
    );
  }
}

export function createGaincDetectScratch() {
  const scratchBuf = new ArrayBuffer(GAINC_SCRATCH_BYTES);
  return {
    scratchBytes: new Uint8Array(scratchBuf),
    view: new DataView(scratchBuf),
    orderedPeakIndices: new Int32Array(AT5_GAINC_CANDIDATE_STATE_COUNT),
    candidateStates: Array.from(
      { length: AT5_GAINC_CANDIDATE_STATE_COUNT },
      createGaincCandidateState
    ),
    windowAbsValues: new Float32Array(64),
    windowScaleValues: new Float32Array(64),
    newAbs: new Float32Array(AT5_GAINC_WINDOW_BLOCKS),
    scaleFactors: new Float32Array(33),
    currentDeltaSumByIndex: new Int32Array(AT5_GAINC_WINDOW_BLOCKS),
    locs: new Int32Array(16),
    gains: new Int32Array(16),
  };
}
