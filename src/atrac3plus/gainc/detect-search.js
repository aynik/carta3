import { AT5_GAINC_WINDOW_BLOCKS } from "./helpers.js";
import {
  AT5_GC_POINT_FIELDS as POINT,
  gaincPointEntryOffset,
  writeGaincPoint as writePoint,
  writeGaincPointFlag as writeFlag,
  wrapGaincIndexTo32SlotWindow,
} from "./point-layout.js";

const AT5_GAINC_START_EDGE_BIT_LIMIT = 6;
const AT5_GAINC_END_EDGE_BIT_LIMIT = 9;
export const AT5_GAINC_CANDIDATE_STATE_COUNT = 64;
const AT5_GAINC_LOG2E = 1.4426950216293335;
const AT5_GAINC_WINDOW_OFFSET = AT5_GAINC_WINDOW_BLOCKS;
const AT5_GAINC_PREVIOUS_WINDOW_LAST_INDEX = AT5_GAINC_WINDOW_BLOCKS - 1;
const AT5_GAINC_POINT_GROUP_SPLIT_INDEX = 0x1f;
const AT5_GAINC_OPEN_START_BIT_BIAS = 0.41503751277923584;
const AT5_GAINC_OPEN_END_BIT_BIAS = 0.19264507293701172;
const AT5_GAINC_LONG_SPAN_BIT_BIAS = 0.32192808389663696;
const AT5_GAINC_MEDIUM_SPAN_BIT_BIAS = 0.19264507293701172;
const AT5_GAINC_SHORT_SPAN_BIT_BIAS = 0.07400058209896088;

export function createGaincCandidateState() {
  return {
    curveValue: 0.0,
    stepStride: 0,
    endBitsByGroup: [0, 0],
    startBitsByGroup: [0, 0],
    spanStart: 0,
    spanEnd: 0,
    canSplitTowardStart: 0,
    canSplitTowardEnd: 0,
    peakOrderIndex: -1,
    emittedPointCount: 0,
  };
}

function resetGaincCandidateStates(candidateStates) {
  for (const candidateState of candidateStates) {
    candidateState.curveValue = 0.0;
    candidateState.stepStride = candidateState.spanStart = candidateState.spanEnd = 0;
    candidateState.endBitsByGroup.fill(0);
    candidateState.startBitsByGroup.fill(0);
    candidateState.canSplitTowardStart = candidateState.canSplitTowardEnd = 0;
    candidateState.peakOrderIndex = -1;
    candidateState.emittedPointCount = 0;
  }
}

function gaincPeakRiseBits(peakValue, surroundingPeak, bitLimit) {
  if (!(peakValue > 0.0) || !(surroundingPeak > peakValue)) {
    return 0;
  }

  const riseBits = ((Math.log(surroundingPeak / peakValue) * AT5_GAINC_LOG2E) | 0) + 1;
  return (riseBits > (bitLimit | 0) ? bitLimit : riseBits) | 0;
}

function buildOrderedPeakIndicesAt5(orderedPeakIndices, vals, anchorIndex, startIncl, endExcl) {
  orderedPeakIndices[0] = anchorIndex | 0;
  let count = 1;

  for (let i = startIncl | 0; i < (endExcl | 0); i += 1) {
    const candidateIndex = i | 0;
    const candidateValue = vals[candidateIndex] ?? 0;
    let insertIndex = count;

    while (insertIndex > 1) {
      const previousValue = vals[orderedPeakIndices[insertIndex - 1]] ?? 0;
      if (candidateValue <= previousValue) {
        break;
      }
      orderedPeakIndices[insertIndex] = orderedPeakIndices[insertIndex - 1];
      insertIndex -= 1;
    }

    orderedPeakIndices[insertIndex] = candidateIndex;
    count += 1;
  }

  return count | 0;
}

function emitGaincPointEntryAt5(
  view,
  groupBaseOffset,
  pointWindowCounts,
  group,
  pointIndex,
  delta,
  step,
  pointCount
) {
  const pointSlot = group === 0 ? pointWindowCounts.current | 0 : pointWindowCounts.next | 0;
  if (group === 0) {
    pointWindowCounts.current = (pointSlot + 1) | 0;
  } else {
    pointWindowCounts.next = (pointSlot + 1) | 0;
  }
  const entryOffset = gaincPointEntryOffset(groupBaseOffset, group, pointSlot);

  writeFlag(view, entryOffset, POINT.DISABLED, false);
  writePoint(view, entryOffset, POINT.SPAN_COST, 0);
  writePoint(view, entryOffset, POINT.POINT_COUNT, pointCount);
  writePoint(view, entryOffset, POINT.INDEX, wrapGaincIndexTo32SlotWindow(pointIndex));
  writePoint(view, entryOffset, POINT.STEP, step);
  writePoint(view, entryOffset, POINT.DELTA, delta);
  writeFlag(view, entryOffset, POINT.HAS_LINK, false);

  return {
    entryOffset,
    pointSlot,
  };
}

export function expandGaincSplitCandidateAt5(split, context) {
  const {
    parentCandidateState,
    childCandidateState,
    parentPeakIndex,
    boundaryIndex,
    childPeakOrderIndex,
    childPeakIndex,
    towardStart,
  } = split;
  const {
    windowAbs,
    windowScale,
    searchStartBoundary,
    searchEndBoundary,
    groupBaseOffset,
    pointWindowCounts,
    view,
  } = context;

  const spanStart = towardStart ? boundaryIndex : parentPeakIndex;
  const spanEnd = towardStart ? parentPeakIndex : boundaryIndex;
  const isOpenStart = spanStart === searchStartBoundary;
  const isOpenEnd = spanEnd === searchEndBoundary;
  const closedStepStride = (spanEnd - spanStart) * 2 - 2;

  childCandidateState.peakOrderIndex = childPeakOrderIndex;
  childCandidateState.spanStart = spanStart;
  childCandidateState.spanEnd = spanEnd;
  childCandidateState.stepStride =
    towardStart && isOpenStart
      ? parentPeakIndex * 2 - AT5_GAINC_WINDOW_OFFSET
      : !towardStart && isOpenEnd
        ? (AT5_GAINC_PREVIOUS_WINDOW_LAST_INDEX - parentPeakIndex) * 2 + AT5_GAINC_WINDOW_OFFSET
        : closedStepStride;

  const startGroup = spanStart + 1 > AT5_GAINC_POINT_GROUP_SPLIT_INDEX ? 1 : 0;
  const endGroup = spanEnd - 1 > AT5_GAINC_POINT_GROUP_SPLIT_INDEX ? 1 : 0;
  const parentStartBitsByGroup = parentCandidateState.startBitsByGroup;
  const parentEndBitsByGroup = parentCandidateState.endBitsByGroup;
  const startBitsByGroup = childCandidateState.startBitsByGroup;
  const endBitsByGroup = childCandidateState.endBitsByGroup;

  startBitsByGroup[0] = parentStartBitsByGroup[0];
  startBitsByGroup[1] = parentStartBitsByGroup[1];
  endBitsByGroup[0] = parentEndBitsByGroup[0];
  endBitsByGroup[1] = parentEndBitsByGroup[1];

  const leftInteriorCount = childPeakIndex - spanStart - 1;
  const rightInteriorCount = spanEnd - childPeakIndex - 1;
  const allowStartChildSplit = isOpenStart || leftInteriorCount >= 4;
  const allowEndChildSplit = isOpenEnd || rightInteriorCount >= 4;
  childCandidateState.canSplitTowardStart = allowStartChildSplit && leftInteriorCount > 0 ? 1 : 0;
  childCandidateState.canSplitTowardEnd = allowEndChildSplit && rightInteriorCount > 0 ? 1 : 0;
  const blockedInteriorPeakCount =
    (allowStartChildSplit ? 0 : leftInteriorCount) + (allowEndChildSplit ? 0 : rightInteriorCount);

  const childPeakValue = windowAbs[childPeakIndex] ?? 0;
  const parentPeakValue = windowAbs[parentPeakIndex] ?? 0;
  const parentCurveValue = parentCandidateState.curveValue ?? 0;
  const boundaryScale = Math.max(
    isOpenStart ? 1.0 : (windowScale[spanStart + 1] ?? 1.0),
    isOpenEnd ? 1.0 : (windowScale[spanEnd] ?? 0)
  );
  const interiorWidth = spanEnd - spanStart - 1;
  let bitBias = 0.0;
  if (isOpenStart) {
    bitBias = AT5_GAINC_OPEN_START_BIT_BIAS;
  } else if (isOpenEnd) {
    bitBias = AT5_GAINC_OPEN_END_BIT_BIAS;
  } else if (interiorWidth >= 32) {
    bitBias = AT5_GAINC_LONG_SPAN_BIT_BIAS;
  } else if (interiorWidth >= 16) {
    bitBias = AT5_GAINC_MEDIUM_SPAN_BIT_BIAS;
  } else if (interiorWidth >= 8) {
    bitBias = AT5_GAINC_SHORT_SPAN_BIT_BIAS;
  }

  const minimumBitCount =
    isOpenStart || isOpenEnd || interiorWidth >= 12
      ? 1
      : interiorWidth >= 8
        ? 2
        : interiorWidth >= 6
          ? 3
          : 4;
  let bitCount = 0;
  let saturated = 0;

  if (parentPeakValue > 0 && childPeakValue > 0) {
    const scaledChildPeakValue = childPeakValue * boundaryScale;
    if (scaledChildPeakValue <= parentCurveValue) {
      bitCount =
        (Math.log(parentCurveValue / scaledChildPeakValue) * AT5_GAINC_LOG2E + bitBias) | 0;
    }
  }

  let tightestEdgeBudget = Infinity;
  if (!isOpenEnd) {
    tightestEdgeBudget = AT5_GAINC_END_EDGE_BIT_LIMIT - endBitsByGroup[endGroup];
  }
  if (!isOpenStart) {
    const startBitBudget = AT5_GAINC_START_EDGE_BIT_LIMIT - startBitsByGroup[startGroup];
    tightestEdgeBudget = Math.min(tightestEdgeBudget, startBitBudget);
  }
  if (bitCount > tightestEdgeBudget) {
    bitCount = tightestEdgeBudget;
    saturated = 1;
  }

  if (bitCount < minimumBitCount) {
    childCandidateState.emittedPointCount = parentCandidateState.emittedPointCount;
    childCandidateState.curveValue = saturated
      ? childPeakValue
      : childPeakValue + (parentCurveValue - childPeakValue) / boundaryScale;
    return blockedInteriorPeakCount;
  }

  const step = bitCount * childCandidateState.stepStride;
  childCandidateState.emittedPointCount = parentCandidateState.emittedPointCount + 1;

  let endPoint = null;
  if (!isOpenEnd) {
    endPoint = emitGaincPointEntryAt5(
      view,
      groupBaseOffset,
      pointWindowCounts,
      endGroup,
      spanEnd - 1,
      bitCount,
      step,
      childCandidateState.emittedPointCount
    );
    endBitsByGroup[endGroup] += bitCount;
  }

  if (!isOpenStart) {
    const startPoint = emitGaincPointEntryAt5(
      view,
      groupBaseOffset,
      pointWindowCounts,
      startGroup,
      spanStart + 1,
      -bitCount,
      step,
      childCandidateState.emittedPointCount
    );
    startBitsByGroup[startGroup] += bitCount;

    if (endPoint !== null) {
      writeFlag(view, endPoint.entryOffset, POINT.HAS_LINK, true);
      writePoint(view, endPoint.entryOffset, POINT.LINK_GROUP_DELTA, startGroup - endGroup);
      writePoint(view, endPoint.entryOffset, POINT.LINK_INDEX, startPoint.pointSlot);

      writeFlag(view, startPoint.entryOffset, POINT.HAS_LINK, true);
      writePoint(view, startPoint.entryOffset, POINT.LINK_GROUP_DELTA, endGroup - startGroup);
      writePoint(view, startPoint.entryOffset, POINT.LINK_INDEX, endPoint.pointSlot);
    }
  }

  childCandidateState.curveValue = childPeakValue;
  return blockedInteriorPeakCount;
}

export function createGaincSearchPlanAt5(
  previousPeakIndex,
  previousPeakValue,
  currentPeakIndex,
  currentPeakValue
) {
  const currentWindowPeakIndex = (currentPeakIndex + AT5_GAINC_WINDOW_OFFSET) | 0;
  const anchorIsPreviousPeak = previousPeakValue >= currentPeakValue;
  const anchorPeakIndex = anchorIsPreviousPeak ? previousPeakIndex | 0 : currentWindowPeakIndex;

  return {
    anchorPeakIndex,
    searchStartBoundary: ((previousPeakIndex | 0) - 1) | 0,
    searchEndBoundary: (currentWindowPeakIndex + 1) | 0,
    candidateScanStart: anchorIsPreviousPeak ? (anchorPeakIndex + 1) | 0 : previousPeakIndex | 0,
    candidateScanEnd: anchorIsPreviousPeak ? (currentWindowPeakIndex + 1) | 0 : anchorPeakIndex | 0,
    canSplitTowardStart: anchorIsPreviousPeak ? 0 : 1,
    canSplitTowardEnd: anchorIsPreviousPeak ? 1 : 0,
    rootCurveValue: anchorIsPreviousPeak ? previousPeakValue : currentPeakValue,
  };
}

export function initializeGaincCandidateSearchAt5(
  orderedPeakIndices,
  candidateStates,
  windowAbs,
  previousPeakIndex,
  previousPeakValue,
  previousTrailingWindowPeak,
  currentPeakIndex,
  currentPeakValue,
  currentLeadingWindowPeak
) {
  const searchPlan = createGaincSearchPlanAt5(
    previousPeakIndex,
    previousPeakValue,
    currentPeakIndex,
    currentPeakValue
  );

  const candidateCount = buildOrderedPeakIndicesAt5(
    orderedPeakIndices,
    windowAbs,
    searchPlan.anchorPeakIndex,
    searchPlan.candidateScanStart,
    searchPlan.candidateScanEnd
  );

  resetGaincCandidateStates(candidateStates);
  const rootCandidateState = candidateStates[0];
  rootCandidateState.curveValue = Math.max(0.0, searchPlan.rootCurveValue);
  rootCandidateState.startBitsByGroup[0] = gaincPeakRiseBits(
    previousPeakValue,
    previousTrailingWindowPeak,
    AT5_GAINC_START_EDGE_BIT_LIMIT
  );
  rootCandidateState.endBitsByGroup[1] = gaincPeakRiseBits(
    currentPeakValue,
    currentLeadingWindowPeak,
    AT5_GAINC_END_EDGE_BIT_LIMIT
  );
  rootCandidateState.spanStart = searchPlan.searchStartBoundary | 0;
  rootCandidateState.spanEnd = searchPlan.searchEndBoundary | 0;
  rootCandidateState.canSplitTowardStart = searchPlan.canSplitTowardStart | 0;
  rootCandidateState.canSplitTowardEnd = searchPlan.canSplitTowardEnd | 0;
  rootCandidateState.peakOrderIndex = 0;

  return {
    ...searchPlan,
    candidateCount: candidateCount | 0,
  };
}

export function expandGaincSplitCandidatesAt5(
  candidateCount,
  candidateStates,
  orderedPeakIndices,
  searchStartBoundary,
  searchEndBoundary,
  windowAbs,
  windowScale,
  groupBaseOffset,
  pointWindowCounts,
  view
) {
  let liveCandidateCount = candidateCount;
  if (liveCandidateCount <= 1) {
    return;
  }

  const splitContext = {
    windowAbs,
    windowScale,
    searchStartBoundary,
    searchEndBoundary,
    groupBaseOffset,
    pointWindowCounts,
    view,
  };
  let nextCandidateIndex = 1;
  for (
    let sourceCandidateIndex = 0;
    sourceCandidateIndex < nextCandidateIndex && nextCandidateIndex < liveCandidateCount;
    sourceCandidateIndex += 1
  ) {
    const parentCandidateState = candidateStates[sourceCandidateIndex];
    const parentPeakOrderIndex = parentCandidateState.peakOrderIndex;
    const parentPeakIndex =
      parentPeakOrderIndex >= 0 ? orderedPeakIndices[parentPeakOrderIndex] : 0;
    const spanStart = parentCandidateState.spanStart;
    const spanEnd = parentCandidateState.spanEnd;
    const allowStartSplit = parentCandidateState.canSplitTowardStart === 1;
    const allowEndSplit = parentCandidateState.canSplitTowardEnd === 1;

    let startChildPeakOrderIndex = -1;
    let endChildPeakOrderIndex = -1;
    for (
      let childPeakOrderIndex = parentPeakOrderIndex + 1;
      childPeakOrderIndex < candidateCount &&
      ((allowStartSplit && startChildPeakOrderIndex === -1) ||
        (allowEndSplit && endChildPeakOrderIndex === -1));
      childPeakOrderIndex += 1
    ) {
      const childPeakIndex = orderedPeakIndices[childPeakOrderIndex];
      if (!(spanStart < childPeakIndex && childPeakIndex < spanEnd)) {
        continue;
      }

      if (childPeakIndex < parentPeakIndex) {
        if (allowStartSplit && startChildPeakOrderIndex === -1) {
          startChildPeakOrderIndex = childPeakOrderIndex;
        }
        continue;
      }
      if (parentPeakIndex < childPeakIndex && allowEndSplit && endChildPeakOrderIndex === -1) {
        endChildPeakOrderIndex = childPeakOrderIndex;
      }
    }

    if (
      allowStartSplit &&
      startChildPeakOrderIndex !== -1 &&
      nextCandidateIndex < liveCandidateCount
    ) {
      liveCandidateCount -= expandGaincSplitCandidateAt5(
        {
          parentCandidateState,
          childCandidateState: candidateStates[nextCandidateIndex],
          parentPeakIndex,
          boundaryIndex: spanStart,
          childPeakOrderIndex: startChildPeakOrderIndex,
          childPeakIndex: orderedPeakIndices[startChildPeakOrderIndex],
          towardStart: true,
        },
        splitContext
      );
      nextCandidateIndex += 1;
    }

    if (allowEndSplit && endChildPeakOrderIndex !== -1 && nextCandidateIndex < liveCandidateCount) {
      liveCandidateCount -= expandGaincSplitCandidateAt5(
        {
          parentCandidateState,
          childCandidateState: candidateStates[nextCandidateIndex],
          parentPeakIndex,
          boundaryIndex: spanEnd,
          childPeakOrderIndex: endChildPeakOrderIndex,
          childPeakIndex: orderedPeakIndices[endChildPeakOrderIndex],
          towardStart: false,
        },
        splitContext
      );
      nextCandidateIndex += 1;
    }
  }
}
