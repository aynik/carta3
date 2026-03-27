import { AT5_LNGAIN } from "../tables/decode.js";

import { absI32 } from "./helpers.js";
import {
  AT5_GC_POINT_FIELDS as POINT,
  AT5_GC_POINT_ENTRY_STRIDE_BYTES,
  AT5_GC_POINT_GROUP_ENTRIES,
  readGaincPoint as readPoint,
  readGaincPointFlag as readFlag,
  readGaincPointLink as readLink,
  writeGaincPoint as writePoint,
  writeGaincPointFlag as writeFlag,
  writeGaincPointLink as writeLink,
} from "./point-layout.js";

const AT5_GAINC_TARGET_CURRENT_POINTS = 7;
const AT5_GAINC_REMOVAL_DELTA_COST = 0x88;
const AT5_GAINC_REMOVAL_BASE_COST = 0x2c4;
const AT5_GAINC_MAX_MERGE_SHAPE_BITS = 6;
const AT5_GAINC_MAX_RECORD_POINTS = 16;
const AT5_GAINC_MAX_LEVEL = 9;
const AT5_GAINC_MIN_LEVEL = -6;

function applyMergedRunStepAdjustment(view, startOffset, delta, stepAdjustment, spanCost) {
  for (
    let pointOffset = startOffset;
    pointOffset !== null && (readPoint(view, pointOffset, POINT.DELTA) | 0) === (delta | 0);
    pointOffset = readLink(view, pointOffset, POINT.PREV_BY_INDEX)
  ) {
    writePoint(
      view,
      pointOffset,
      POINT.STEP,
      (stepAdjustment + (readPoint(view, pointOffset, POINT.STEP) | 0)) | 0
    );
    writePoint(view, pointOffset, POINT.SPAN_COST, spanCost | 0);
  }
}

function selectCurrentPointPruneCandidate(view, sentinelOffset, currentDeltaSumByIndex) {
  const firstActiveOffset = readLink(view, sentinelOffset, POINT.NEXT_ACTIVE);
  if (firstActiveOffset === null) {
    return null;
  }

  let bestCandidate = {
    activePreviousOffset: sentinelOffset,
    pointOffset: firstActiveOffset,
    mergePreviousOffset: null,
    mergeNextOffset: null,
  };
  let bestRemovalCost = ((readPoint(view, firstActiveOffset, POINT.STEP) | 0) << 2) >>> 0;

  let activePreviousOffset = sentinelOffset;
  for (
    let pointOffset = firstActiveOffset;
    pointOffset !== null;
    pointOffset = readLink(view, pointOffset, POINT.NEXT_ACTIVE)
  ) {
    const pointIndex = readPoint(view, pointOffset, POINT.INDEX) | 0;
    const pointDelta = readPoint(view, pointOffset, POINT.DELTA) | 0;
    const remainingIndexDelta = ((currentDeltaSumByIndex[pointIndex] | 0) - pointDelta) | 0;

    if (remainingIndexDelta !== 0) {
      const currentRemovalCost =
        (((readPoint(view, pointOffset, POINT.STEP) | 0) << 2) +
          absI32(remainingIndexDelta) * AT5_GAINC_REMOVAL_DELTA_COST +
          AT5_GAINC_REMOVAL_BASE_COST) >>>
        0;
      if (currentRemovalCost < bestRemovalCost) {
        bestRemovalCost = currentRemovalCost;
        bestCandidate = {
          activePreviousOffset,
          pointOffset,
          mergePreviousOffset: null,
          mergeNextOffset: null,
        };
      }

      const mergePreviousOffset = readLink(view, pointOffset, POINT.PREV_BY_INDEX);
      const mergeNextOffset = readLink(view, pointOffset, POINT.NEXT_BY_INDEX);
      const spansSameIndexTriplet =
        mergePreviousOffset !== null &&
        mergeNextOffset !== null &&
        (readPoint(view, mergePreviousOffset, POINT.INDEX) | 0) === pointIndex &&
        (readPoint(view, mergeNextOffset, POINT.INDEX) | 0) === pointIndex;
      if (spansSameIndexTriplet) {
        const mergedRemovalCost =
          (currentRemovalCost + (readPoint(view, pointOffset, POINT.SPAN_COST) | 0)) >>> 0;
        if (mergedRemovalCost < bestRemovalCost) {
          bestRemovalCost = mergedRemovalCost;
          bestCandidate = {
            activePreviousOffset,
            pointOffset,
            mergePreviousOffset,
            mergeNextOffset,
          };
        }
      }
    }

    activePreviousOffset = pointOffset;
  }

  return bestCandidate;
}

function applyMergedPruneAdjustment(view, pruneCandidate, currentDeltaSumByIndex) {
  if (pruneCandidate.mergePreviousOffset === null || pruneCandidate.mergeNextOffset === null) {
    return;
  }

  const removedPointIndex = readPoint(view, pruneCandidate.pointOffset, POINT.INDEX) | 0;
  const removedDelta = readPoint(view, pruneCandidate.pointOffset, POINT.DELTA) | 0;
  const previousDelta = readPoint(view, pruneCandidate.mergePreviousOffset, POINT.DELTA) | 0;
  const nextDelta = readPoint(view, pruneCandidate.mergeNextOffset, POINT.DELTA) | 0;
  const mergedPreviousDelta = (previousDelta + removedDelta) | 0;
  const mergedNextDelta = (nextDelta + removedDelta) | 0;
  const remainingIndexDelta = ((currentDeltaSumByIndex[removedPointIndex] | 0) - removedDelta) | 0;
  const remainingPreviousDelta = (remainingIndexDelta - mergedPreviousDelta) | 0;
  const remainingNextDelta = (remainingIndexDelta - mergedNextDelta) | 0;
  const mergeGap = absI32(previousDelta - nextDelta) | 0;
  const mergeShapeBits =
    mergeGap < AT5_GAINC_MAX_MERGE_SHAPE_BITS ? mergeGap : AT5_GAINC_MAX_MERGE_SHAPE_BITS;
  const previousRemovalBits =
    (absI32(remainingPreviousDelta) * AT5_GAINC_REMOVAL_DELTA_COST + mergeShapeBits) | 0;
  const nextRemovalBits =
    (absI32(remainingNextDelta) * AT5_GAINC_REMOVAL_DELTA_COST + mergeShapeBits) | 0;
  const stepAdjustment =
    (previousRemovalBits -
      nextRemovalBits +
      ((previousDelta - nextDelta) | 0) * AT5_GAINC_REMOVAL_DELTA_COST) |
    0;
  const spanCost = (mergeGap + mergeShapeBits) | 0;

  applyMergedRunStepAdjustment(
    view,
    pruneCandidate.mergePreviousOffset,
    previousDelta,
    stepAdjustment,
    spanCost
  );
  applyMergedRunStepAdjustment(
    view,
    pruneCandidate.mergeNextOffset,
    nextDelta,
    stepAdjustment,
    spanCost
  );
}

function countLinkedPrunedPoint(pruningState, view, pointOffset) {
  if (!readFlag(view, pointOffset, POINT.HAS_LINK)) {
    return;
  }

  const linkedPointIndex = readPoint(view, pointOffset, POINT.LINK_INDEX) | 0;
  if (linkedPointIndex >>> 0 >= AT5_GC_POINT_GROUP_ENTRIES) {
    return;
  }

  const linkedGroupDelta = readPoint(view, pointOffset, POINT.LINK_GROUP_DELTA) | 0;
  if (linkedGroupDelta === 0) {
    pruningState.currentDisabledCount = (pruningState.currentDisabledCount + 1) | 0;
  } else if (linkedGroupDelta === 1) {
    pruningState.nextDisabledCount = (pruningState.nextDisabledCount + 1) | 0;
  }
}

function unlinkPrunedPoint(view, sentinelOffset, activePreviousOffset, pointOffset) {
  const previousIndexOffset = readLink(view, pointOffset, POINT.PREV_BY_INDEX);
  const nextIndexOffset = readLink(view, pointOffset, POINT.NEXT_BY_INDEX);
  const nextActiveOffset = readLink(view, pointOffset, POINT.NEXT_ACTIVE);

  if (nextIndexOffset !== null) {
    writeLink(view, nextIndexOffset, POINT.PREV_BY_INDEX, previousIndexOffset);
  }
  writeLink(view, previousIndexOffset ?? sentinelOffset, POINT.NEXT_BY_INDEX, nextIndexOffset);
  writeLink(view, activePreviousOffset, POINT.NEXT_ACTIVE, nextActiveOffset);
}

export function pruneCurrentGaincPoints(
  view,
  sentinelOffset,
  pointWindowCounts,
  pruningState,
  currentDeltaSumByIndex
) {
  while (
    AT5_GAINC_TARGET_CURRENT_POINTS <
    pointWindowCounts.current -
      pruningState.currentDuplicateIndexCount -
      pruningState.currentDisabledCount
  ) {
    const pruneCandidate = selectCurrentPointPruneCandidate(
      view,
      sentinelOffset,
      currentDeltaSumByIndex
    );
    if (pruneCandidate === null) {
      break;
    }

    applyMergedPruneAdjustment(view, pruneCandidate, currentDeltaSumByIndex);
    countLinkedPrunedPoint(pruningState, view, pruneCandidate.pointOffset);
    writeFlag(view, pruneCandidate.pointOffset, POINT.DISABLED, true);
    pruningState.currentDisabledCount = (pruningState.currentDisabledCount + 1) | 0;
    unlinkPrunedPoint(
      view,
      sentinelOffset,
      pruneCandidate.activePreviousOffset,
      pruneCandidate.pointOffset
    );
  }
}

export function finalizePreviousGaincCurve(view, sentinelOffset, groupOffset, previousPointCount) {
  for (let i = 0; i < (previousPointCount | 0); i += 1) {
    const pointOffset = (groupOffset + i * AT5_GC_POINT_ENTRY_STRIDE_BYTES) | 0;
    if (readFlag(view, pointOffset, POINT.DISABLED)) {
      writeLink(view, pointOffset, POINT.NEXT_BY_INDEX, null);
    }
  }

  let minGain = 0;
  let maxGain = 0;
  let cumulativeGain = 0;
  let previousRetainedOffset = sentinelOffset;

  for (
    let pointOffset = readLink(view, sentinelOffset, POINT.NEXT_BY_INDEX);
    pointOffset !== null;
  ) {
    const nextOffset = readLink(view, pointOffset, POINT.NEXT_BY_INDEX);
    cumulativeGain = (cumulativeGain + (readPoint(view, pointOffset, POINT.DELTA) | 0)) | 0;
    writePoint(view, pointOffset, POINT.DELTA, cumulativeGain);

    minGain = Math.min(minGain, cumulativeGain);
    maxGain = Math.max(maxGain, cumulativeGain);

    const pointIndex = readPoint(view, pointOffset, POINT.INDEX);
    const dropsDuplicatePoint =
      nextOffset !== null && readPoint(view, nextOffset, POINT.INDEX) === pointIndex;
    if (dropsDuplicatePoint) {
      writeLink(view, previousRetainedOffset, POINT.NEXT_BY_INDEX, nextOffset);
      writeLink(view, pointOffset, POINT.NEXT_BY_INDEX, null);
    } else {
      previousRetainedOffset = pointOffset;
    }

    pointOffset = nextOffset;
  }

  return {
    headOffset: readLink(view, sentinelOffset, POINT.NEXT_BY_INDEX),
    minGain: Math.max(minGain, AT5_GAINC_MIN_LEVEL) | 0,
    maxGain: Math.min(maxGain, AT5_GAINC_MAX_LEVEL) | 0,
  };
}

function gaincLevelIndexAtOrBelow(gainLevel) {
  let levelIndex = -1;
  for (let i = 0; i < AT5_LNGAIN.length; i += 1) {
    if ((AT5_LNGAIN[i] | 0) <= (gainLevel | 0)) {
      levelIndex = i;
    }
  }
  return levelIndex | 0;
}

export function encodeGaincCurveToRecordEntries(view, headOffset, minGain, maxGain, locs, gains) {
  let entryCount = 0;
  let previousGain = 0;
  for (
    let pointOffset = headOffset;
    pointOffset !== null;
    pointOffset = readLink(view, pointOffset, POINT.NEXT_BY_INDEX)
  ) {
    let clampedGain = readPoint(view, pointOffset, POINT.DELTA) | 0;
    if (clampedGain > (maxGain | 0)) {
      clampedGain = maxGain | 0;
    }
    if (clampedGain < (minGain | 0)) {
      clampedGain = minGain | 0;
    }

    if (clampedGain === previousGain || entryCount >= AT5_GAINC_MAX_RECORD_POINTS) {
      continue;
    }

    locs[entryCount] = readPoint(view, pointOffset, POINT.INDEX) | 0;
    gains[entryCount] = gaincLevelIndexAtOrBelow(clampedGain);
    entryCount += 1;
    previousGain = clampedGain;
  }

  return entryCount | 0;
}

export function writeGaincOutputRecord(record, locs, gains, entryCount) {
  record.entries = entryCount >>> 0;
  for (let i = 0; i < (entryCount | 0); i += 1) {
    const sourceIndex = (entryCount - 1 - i) | 0;
    record.locations[i] = locs[sourceIndex] >>> 0;
    record.levels[i] = gains[sourceIndex] >>> 0;
  }
}
