import assert from "node:assert/strict";
import test from "node:test";

import {
  createGaincSearchPlanAt5,
  expandGaincSplitCandidatesAt5,
  initializeGaincCandidateSearchAt5,
} from "../../../src/atrac3plus/gainc/detect-search.js";
import { AT5_GC_POINT_GROUP_STRIDE_BYTES } from "../../../src/atrac3plus/gainc/point-layout.js";

test("createGaincSearchPlanAt5 anchors the search on the stronger previous-window peak", () => {
  const searchPlan = createGaincSearchPlanAt5(6, 4.0, 3, 2.5);

  assert.deepEqual(searchPlan, {
    anchorPeakIndex: 6,
    searchStartBoundary: 5,
    searchEndBoundary: 36,
    candidateScanStart: 7,
    candidateScanEnd: 36,
    canSplitTowardStart: 0,
    canSplitTowardEnd: 1,
    rootCurveValue: 4.0,
  });
});

test("createGaincSearchPlanAt5 anchors the search on the stronger current-window peak", () => {
  const searchPlan = createGaincSearchPlanAt5(6, 2.5, 3, 4.0);

  assert.deepEqual(searchPlan, {
    anchorPeakIndex: 35,
    searchStartBoundary: 5,
    searchEndBoundary: 36,
    candidateScanStart: 6,
    candidateScanEnd: 35,
    canSplitTowardStart: 1,
    canSplitTowardEnd: 0,
    rootCurveValue: 4.0,
  });
});

function createCandidateState() {
  return {
    curveValue: 99.0,
    stepStride: 99,
    endBitsByGroup: [9, 9],
    startBitsByGroup: [9, 9],
    spanStart: 99,
    spanEnd: 99,
    canSplitTowardStart: 9,
    canSplitTowardEnd: 9,
    peakOrderIndex: 9,
    emittedPointCount: 9,
  };
}

function createBlankCandidateState() {
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

test("initializeGaincCandidateSearchAt5 resets candidate state and seeds the root edge budgets", () => {
  const orderedPeakIndices = new Int32Array(64);
  const candidateStates = Array.from({ length: 64 }, createCandidateState);

  const searchPlan = initializeGaincCandidateSearchAt5(
    orderedPeakIndices,
    candidateStates,
    new Float32Array(64),
    6,
    4.0,
    12.0,
    3,
    2.0,
    16.0
  );

  assert.equal(searchPlan.candidateCount, 30);
  assert.equal(orderedPeakIndices[0], 6);
  assert.equal(candidateStates[0].curveValue, 4.0);
  assert.equal(candidateStates[0].stepStride, 0);
  assert.deepEqual(candidateStates[0].startBitsByGroup, [2, 0]);
  assert.deepEqual(candidateStates[0].endBitsByGroup, [0, 3]);
  assert.equal(candidateStates[0].spanStart, 5);
  assert.equal(candidateStates[0].spanEnd, 36);
  assert.equal(candidateStates[0].canSplitTowardStart, 0);
  assert.equal(candidateStates[0].canSplitTowardEnd, 1);
  assert.equal(candidateStates[0].peakOrderIndex, 0);
  assert.equal(candidateStates[0].emittedPointCount, 0);
  assert.equal(candidateStates[1].curveValue, 0.0);
  assert.equal(candidateStates[1].peakOrderIndex, -1);
});

test("initializeGaincCandidateSearchAt5 keeps the anchor peak first and orders remaining peaks by descending strength", () => {
  const orderedPeakIndices = new Int32Array(64);
  const candidateStates = Array.from({ length: 64 }, createBlankCandidateState);
  const windowAbs = new Float32Array(64);

  windowAbs[10] = 6.0;
  windowAbs[11] = 6.0;
  windowAbs[15] = 8.0;
  windowAbs[22] = 5.0;

  const searchPlan = initializeGaincCandidateSearchAt5(
    orderedPeakIndices,
    candidateStates,
    windowAbs,
    6,
    4.0,
    4.0,
    3,
    2.0,
    2.0
  );

  assert.equal(searchPlan.candidateCount, 30);
  assert.deepEqual(Array.from(orderedPeakIndices.subarray(0, 5)), [6, 15, 10, 11, 22]);
});

test("expandGaincSplitCandidatesAt5 expands the root candidate into left and right spans in place", () => {
  const view = new DataView(new ArrayBuffer(AT5_GC_POINT_GROUP_STRIDE_BYTES * 2));
  const candidateStates = Array.from({ length: 4 }, () => createBlankCandidateState());
  const orderedPeakIndices = new Int32Array([20, 28, 12]);
  const windowAbs = new Float32Array(64);
  const windowScale = new Float32Array(64).fill(1.0);

  candidateStates[0].curveValue = 64.0;
  candidateStates[0].spanStart = 10;
  candidateStates[0].spanEnd = 34;
  candidateStates[0].canSplitTowardStart = 1;
  candidateStates[0].canSplitTowardEnd = 1;
  candidateStates[0].peakOrderIndex = 0;

  windowAbs[20] = 64.0;
  windowAbs[28] = 8.0;
  windowAbs[12] = 8.0;

  const pointWindowCounts = { current: 0, next: 0 };
  expandGaincSplitCandidatesAt5(
    3,
    candidateStates,
    orderedPeakIndices,
    10,
    34,
    windowAbs,
    windowScale,
    0,
    pointWindowCounts,
    view
  );

  assert.equal(candidateStates[1].peakOrderIndex, 2);
  assert.equal(candidateStates[1].spanStart, 10);
  assert.equal(candidateStates[1].spanEnd, 20);
  assert.equal(candidateStates[1].stepStride, 8);
  assert.equal(candidateStates[1].canSplitTowardStart, 1);
  assert.equal(candidateStates[1].canSplitTowardEnd, 1);
  assert.deepEqual(candidateStates[1].endBitsByGroup, [3, 0]);
  assert.equal(candidateStates[1].emittedPointCount, 1);

  assert.equal(candidateStates[2].peakOrderIndex, 1);
  assert.equal(candidateStates[2].spanStart, 20);
  assert.equal(candidateStates[2].spanEnd, 34);
  assert.equal(candidateStates[2].stepStride, 54);
  assert.equal(candidateStates[2].canSplitTowardStart, 1);
  assert.equal(candidateStates[2].canSplitTowardEnd, 1);
  assert.deepEqual(candidateStates[2].startBitsByGroup, [3, 0]);
  assert.equal(candidateStates[2].emittedPointCount, 1);
  assert.deepEqual(pointWindowCounts, { current: 2, next: 0 });
});

test("expandGaincSplitCandidatesAt5 skips stronger out-of-span peaks while finding both child pivots", () => {
  const view = new DataView(new ArrayBuffer(AT5_GC_POINT_GROUP_STRIDE_BYTES * 2));
  const candidateStates = Array.from({ length: 5 }, () => createBlankCandidateState());
  const orderedPeakIndices = new Int32Array([20, 40, 28, 12]);
  const windowAbs = new Float32Array(64);
  const windowScale = new Float32Array(64).fill(1.0);

  candidateStates[0].curveValue = 64.0;
  candidateStates[0].spanStart = 10;
  candidateStates[0].spanEnd = 34;
  candidateStates[0].canSplitTowardStart = 1;
  candidateStates[0].canSplitTowardEnd = 1;
  candidateStates[0].peakOrderIndex = 0;

  windowAbs[20] = 64.0;
  windowAbs[40] = 32.0;
  windowAbs[28] = 8.0;
  windowAbs[12] = 8.0;

  expandGaincSplitCandidatesAt5(
    4,
    candidateStates,
    orderedPeakIndices,
    10,
    34,
    windowAbs,
    windowScale,
    0,
    { current: 0, next: 0 },
    view
  );

  assert.equal(candidateStates[1].peakOrderIndex, 3);
  assert.equal(candidateStates[2].peakOrderIndex, 2);
});

test("expandGaincSplitCandidatesAt5 only expands the enabled child direction", () => {
  const view = new DataView(new ArrayBuffer(AT5_GC_POINT_GROUP_STRIDE_BYTES * 2));
  const candidateStates = Array.from({ length: 3 }, () => createBlankCandidateState());
  const orderedPeakIndices = new Int32Array([20, 28, 12]);
  const windowAbs = new Float32Array(64);
  const windowScale = new Float32Array(64).fill(1.0);

  candidateStates[0].curveValue = 64.0;
  candidateStates[0].spanStart = 10;
  candidateStates[0].spanEnd = 34;
  candidateStates[0].canSplitTowardStart = 0;
  candidateStates[0].canSplitTowardEnd = 1;
  candidateStates[0].peakOrderIndex = 0;

  windowAbs[20] = 64.0;
  windowAbs[28] = 8.0;
  windowAbs[12] = 8.0;

  const pointWindowCounts = { current: 0, next: 0 };
  expandGaincSplitCandidatesAt5(
    3,
    candidateStates,
    orderedPeakIndices,
    10,
    34,
    windowAbs,
    windowScale,
    0,
    pointWindowCounts,
    view
  );

  assert.equal(candidateStates[1].peakOrderIndex, 1);
  assert.equal(candidateStates[1].spanStart, 20);
  assert.equal(candidateStates[1].spanEnd, 34);
  assert.equal(candidateStates[1].emittedPointCount, 1);
  assert.equal(candidateStates[2].peakOrderIndex, -1);
  assert.deepEqual(pointWindowCounts, { current: 1, next: 0 });
});
