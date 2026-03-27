import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_GC_POINT_FIELDS as POINT,
  AT5_GC_POINT_GROUP_STRIDE_BYTES,
  gaincPointEntryOffset,
  readGaincPoint as readPoint,
  readGaincPointFlag as readFlag,
} from "../../../src/atrac3plus/gainc/point-layout.js";
import {
  createGaincCandidateState,
  expandGaincSplitCandidateAt5,
} from "../../../src/atrac3plus/gainc/detect-search.js";

function createCandidateState(overrides = {}) {
  return { ...createGaincCandidateState(), ...overrides };
}

test("expandGaincSplitCandidateAt5 emits linked span points across gain groups", () => {
  const buffer = new ArrayBuffer(AT5_GC_POINT_GROUP_STRIDE_BYTES * 2);
  const view = new DataView(buffer);
  const windowAbs = new Float32Array(64);
  const windowScale = new Float32Array(64).fill(1.0);
  const pointWindowCounts = { current: 0, next: 0 };
  const sourceCandidateState = createCandidateState({
    curveValue: 8.0,
    peakOrderIndex: 0,
    emittedPointCount: 1,
  });
  const splitCandidateState = createCandidateState();

  windowAbs[20] = 8.0;
  windowAbs[30] = 1.0;

  const skippedCandidates = expandGaincSplitCandidateAt5(
    {
      parentCandidateState: sourceCandidateState,
      childCandidateState: splitCandidateState,
      parentPeakIndex: 20,
      boundaryIndex: 40,
      childPeakOrderIndex: 1,
      childPeakIndex: 30,
      towardStart: false,
    },
    {
      windowAbs,
      windowScale,
      searchStartBoundary: 10,
      searchEndBoundary: 50,
      groupBaseOffset: 0,
      pointWindowCounts,
      view,
    }
  );

  const startEntryOffset = gaincPointEntryOffset(0, 0, 0);
  const endEntryOffset = gaincPointEntryOffset(0, 1, 0);

  assert.equal(skippedCandidates, 0);
  assert.equal(splitCandidateState.canSplitTowardStart, 1);
  assert.equal(splitCandidateState.canSplitTowardEnd, 1);
  assert.equal(splitCandidateState.curveValue, 1.0);
  assert.equal(splitCandidateState.stepStride, 38);
  assert.equal(splitCandidateState.spanStart, 20);
  assert.equal(splitCandidateState.spanEnd, 40);
  assert.equal(splitCandidateState.emittedPointCount, 2);
  assert.deepEqual(splitCandidateState.startBitsByGroup, [3, 0]);
  assert.deepEqual(splitCandidateState.endBitsByGroup, [0, 3]);
  assert.deepEqual(pointWindowCounts, { current: 1, next: 1 });

  assert.equal(readPoint(view, startEntryOffset, POINT.INDEX), 21);
  assert.equal(readPoint(view, startEntryOffset, POINT.DELTA), -3);
  assert.equal(readPoint(view, startEntryOffset, POINT.STEP), 114);
  assert.equal(readPoint(view, startEntryOffset, POINT.POINT_COUNT), 2);
  assert.equal(readFlag(view, startEntryOffset, POINT.HAS_LINK), true);
  assert.equal(readPoint(view, startEntryOffset, POINT.LINK_GROUP_DELTA), 1);
  assert.equal(readPoint(view, startEntryOffset, POINT.LINK_INDEX), 0);

  assert.equal(readPoint(view, endEntryOffset, POINT.INDEX), 7);
  assert.equal(readPoint(view, endEntryOffset, POINT.DELTA), 3);
  assert.equal(readPoint(view, endEntryOffset, POINT.STEP), 114);
  assert.equal(readPoint(view, endEntryOffset, POINT.POINT_COUNT), 2);
  assert.equal(readFlag(view, endEntryOffset, POINT.HAS_LINK), true);
  assert.equal(readPoint(view, endEntryOffset, POINT.LINK_GROUP_DELTA), -1);
  assert.equal(readPoint(view, endEntryOffset, POINT.LINK_INDEX), 0);
});

test("expandGaincSplitCandidateAt5 preserves saturated no-point fallback near both span edges", () => {
  const buffer = new ArrayBuffer(AT5_GC_POINT_GROUP_STRIDE_BYTES * 2);
  const view = new DataView(buffer);
  const windowAbs = new Float32Array(64);
  const windowScale = new Float32Array(64).fill(1.0);
  const pointWindowCounts = { current: 0, next: 0 };
  const sourceCandidateState = createCandidateState({
    curveValue: 8.0,
    peakOrderIndex: 0,
    emittedPointCount: 2,
    startBitsByGroup: [6, 0],
  });
  const splitCandidateState = createCandidateState();

  windowAbs[10] = 4.0;
  windowAbs[12] = 1.0;

  const skippedCandidates = expandGaincSplitCandidateAt5(
    {
      parentCandidateState: sourceCandidateState,
      childCandidateState: splitCandidateState,
      parentPeakIndex: 10,
      boundaryIndex: 15,
      childPeakOrderIndex: 1,
      childPeakIndex: 12,
      towardStart: false,
    },
    {
      windowAbs,
      windowScale,
      searchStartBoundary: 0,
      searchEndBoundary: 20,
      groupBaseOffset: 0,
      pointWindowCounts,
      view,
    }
  );

  assert.equal(skippedCandidates, 3);
  assert.equal(splitCandidateState.canSplitTowardStart, 0);
  assert.equal(splitCandidateState.canSplitTowardEnd, 0);
  assert.equal(splitCandidateState.curveValue, 1.0);
  assert.equal(splitCandidateState.emittedPointCount, 2);
  assert.deepEqual(splitCandidateState.startBitsByGroup, [6, 0]);
  assert.deepEqual(splitCandidateState.endBitsByGroup, [0, 0]);
  assert.deepEqual(pointWindowCounts, { current: 0, next: 0 });
});

test("expandGaincSplitCandidateAt5 preserves interpolated no-point fallback when the span stays under the minimum step", () => {
  const buffer = new ArrayBuffer(AT5_GC_POINT_GROUP_STRIDE_BYTES * 2);
  const view = new DataView(buffer);
  const windowAbs = new Float32Array(64);
  const windowScale = new Float32Array(64).fill(1.0);
  const pointWindowCounts = { current: 0, next: 0 };
  const sourceCandidateState = createCandidateState({
    curveValue: 9.0,
    peakOrderIndex: 0,
    emittedPointCount: 2,
  });
  const splitCandidateState = createCandidateState();

  windowAbs[10] = 4.0;
  windowAbs[12] = 1.0;
  windowScale[11] = 1.5;
  windowScale[15] = 2.0;

  const skippedCandidates = expandGaincSplitCandidateAt5(
    {
      parentCandidateState: sourceCandidateState,
      childCandidateState: splitCandidateState,
      parentPeakIndex: 10,
      boundaryIndex: 15,
      childPeakOrderIndex: 1,
      childPeakIndex: 12,
      towardStart: false,
    },
    {
      windowAbs,
      windowScale,
      searchStartBoundary: 0,
      searchEndBoundary: 20,
      groupBaseOffset: 0,
      pointWindowCounts,
      view,
    }
  );

  assert.equal(skippedCandidates, 3);
  assert.equal(splitCandidateState.canSplitTowardStart, 0);
  assert.equal(splitCandidateState.canSplitTowardEnd, 0);
  assert.equal(splitCandidateState.curveValue, 5.0);
  assert.equal(splitCandidateState.emittedPointCount, 2);
  assert.deepEqual(splitCandidateState.startBitsByGroup, [0, 0]);
  assert.deepEqual(splitCandidateState.endBitsByGroup, [0, 0]);
  assert.deepEqual(pointWindowCounts, { current: 0, next: 0 });
});
