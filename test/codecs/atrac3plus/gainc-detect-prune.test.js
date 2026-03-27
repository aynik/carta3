import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_GC_POINT_FIELDS as POINT,
  AT5_GC_POINT_ENTRY_STRIDE_BYTES,
  readGaincPoint as readPoint,
  readGaincPointLink as readLink,
  writeGaincPoint as writePoint,
  writeGaincPointFlag as writeFlag,
  writeGaincPointLink as writeLink,
} from "../../../src/atrac3plus/gainc/point-layout.js";
import {
  encodeGaincCurveToRecordEntries,
  finalizePreviousGaincCurve,
  pruneCurrentGaincPoints,
  writeGaincOutputRecord,
} from "../../../src/atrac3plus/gainc/detect-prune.js";

const TEST_SENTINEL_OFFSET = 0x00;
const TEST_GROUP_OFFSET = 0x30;

function entryOffset(index) {
  return TEST_GROUP_OFFSET + index * AT5_GC_POINT_ENTRY_STRIDE_BYTES;
}

function linkByIndex(view, sentinelOffset, offsets) {
  let previous = sentinelOffset;
  for (const offset of offsets) {
    writeLink(view, offset, POINT.PREV_BY_INDEX, previous === sentinelOffset ? null : previous);
    writeLink(view, previous, POINT.NEXT_BY_INDEX, offset);
    previous = offset;
  }
  writeLink(view, previous, POINT.NEXT_BY_INDEX, null);
}

test("pruneCurrentGaincPoints counts a paired current-window point as disabled when pruning its partner", () => {
  const buffer = new ArrayBuffer(0x800);
  const view = new DataView(buffer);
  const activeA = entryOffset(0);
  const activeB = entryOffset(1);
  const activeC = entryOffset(2);

  writePoint(view, activeA, POINT.INDEX, 5);
  writePoint(view, activeA, POINT.DELTA, 3);
  writePoint(view, activeA, POINT.STEP, 1);
  writePoint(view, activeA, POINT.SPAN_COST, 0);
  writeFlag(view, activeA, POINT.DISABLED, false);
  writeFlag(view, activeA, POINT.HAS_LINK, true);
  writePoint(view, activeA, POINT.LINK_GROUP_DELTA, 0);
  writePoint(view, activeA, POINT.LINK_INDEX, 4);
  writePoint(view, activeA, POINT.POINT_COUNT, 1);

  writePoint(view, activeB, POINT.INDEX, 6);
  writePoint(view, activeB, POINT.DELTA, 2);
  writePoint(view, activeB, POINT.STEP, 40);
  writePoint(view, activeB, POINT.SPAN_COST, 0);
  writeFlag(view, activeB, POINT.DISABLED, false);
  writePoint(view, activeB, POINT.POINT_COUNT, 1);

  writePoint(view, activeC, POINT.INDEX, 7);
  writePoint(view, activeC, POINT.DELTA, 2);
  writePoint(view, activeC, POINT.STEP, 80);
  writePoint(view, activeC, POINT.SPAN_COST, 0);
  writeFlag(view, activeC, POINT.DISABLED, false);
  writePoint(view, activeC, POINT.POINT_COUNT, 1);

  writeLink(view, activeA, POINT.NEXT_BY_INDEX, activeB);
  writeLink(view, activeB, POINT.PREV_BY_INDEX, activeA);
  writeLink(view, activeB, POINT.NEXT_BY_INDEX, activeC);
  writeLink(view, activeC, POINT.PREV_BY_INDEX, activeB);
  writeLink(view, activeC, POINT.NEXT_BY_INDEX, null);
  writeLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_BY_INDEX, activeA);

  writeLink(view, activeA, POINT.NEXT_ACTIVE, activeB);
  writeLink(view, activeB, POINT.NEXT_ACTIVE, activeC);
  writeLink(view, activeC, POINT.NEXT_ACTIVE, null);
  writeLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_ACTIVE, activeA);

  const pruningState = {
    currentDisabledCount: 0,
    nextDisabledCount: 0,
    currentDuplicateIndexCount: 0,
  };
  const pointWindowCounts = {
    current: 8,
    next: 0,
  };
  const currentDeltaSumByIndex = new Int32Array(32);
  currentDeltaSumByIndex[5] = 4;
  currentDeltaSumByIndex[6] = 2;
  currentDeltaSumByIndex[7] = 3;

  pruneCurrentGaincPoints(
    view,
    TEST_SENTINEL_OFFSET,
    pointWindowCounts,
    pruningState,
    currentDeltaSumByIndex
  );

  assert.equal(pruningState.currentDisabledCount, 2);
  assert.equal(pruningState.nextDisabledCount, 0);
  assert.equal(readPoint(view, activeA, POINT.DISABLED), 1);
  assert.equal(readPoint(view, TEST_SENTINEL_OFFSET, POINT.NEXT_BY_INDEX), activeB);
});

test("pruneCurrentGaincPoints keeps the active head when pruning a later candidate", () => {
  const buffer = new ArrayBuffer(0x800);
  const view = new DataView(buffer);
  const activeA = entryOffset(0);
  const activeB = entryOffset(1);
  const activeC = entryOffset(2);

  writePoint(view, activeA, POINT.INDEX, 5);
  writePoint(view, activeA, POINT.DELTA, 3);
  writePoint(view, activeA, POINT.STEP, 300);
  writeFlag(view, activeA, POINT.DISABLED, false);

  writePoint(view, activeB, POINT.INDEX, 6);
  writePoint(view, activeB, POINT.DELTA, 2);
  writePoint(view, activeB, POINT.STEP, 1);
  writeFlag(view, activeB, POINT.DISABLED, false);

  writePoint(view, activeC, POINT.INDEX, 7);
  writePoint(view, activeC, POINT.DELTA, 1);
  writePoint(view, activeC, POINT.STEP, 80);
  writeFlag(view, activeC, POINT.DISABLED, false);

  linkByIndex(view, TEST_SENTINEL_OFFSET, [activeA, activeB, activeC]);

  writeLink(view, activeA, POINT.NEXT_ACTIVE, activeB);
  writeLink(view, activeB, POINT.NEXT_ACTIVE, activeC);
  writeLink(view, activeC, POINT.NEXT_ACTIVE, null);
  writeLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_ACTIVE, activeA);

  const pruningState = {
    currentDisabledCount: 0,
    nextDisabledCount: 0,
    currentDuplicateIndexCount: 0,
  };
  const pointWindowCounts = {
    current: 8,
    next: 0,
  };
  const currentDeltaSumByIndex = new Int32Array(32);
  currentDeltaSumByIndex[5] = 3;
  currentDeltaSumByIndex[6] = 3;
  currentDeltaSumByIndex[7] = 2;

  pruneCurrentGaincPoints(
    view,
    TEST_SENTINEL_OFFSET,
    pointWindowCounts,
    pruningState,
    currentDeltaSumByIndex
  );

  assert.equal(readPoint(view, activeB, POINT.DISABLED), 1);
  assert.equal(readLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_ACTIVE), activeA);
  assert.equal(readLink(view, activeA, POINT.NEXT_ACTIVE), activeC);
  assert.equal(readLink(view, activeA, POINT.NEXT_BY_INDEX), activeC);
});

test("pruneCurrentGaincPoints advances past a removed head across multiple prune passes", () => {
  const buffer = new ArrayBuffer(0x800);
  const view = new DataView(buffer);
  const activeA = entryOffset(0);
  const activeB = entryOffset(1);
  const activeC = entryOffset(2);
  const activeD = entryOffset(3);

  writePoint(view, activeA, POINT.INDEX, 5);
  writePoint(view, activeA, POINT.DELTA, 1);
  writePoint(view, activeA, POINT.STEP, 1);
  writeFlag(view, activeA, POINT.DISABLED, false);

  writePoint(view, activeB, POINT.INDEX, 6);
  writePoint(view, activeB, POINT.DELTA, 1);
  writePoint(view, activeB, POINT.STEP, 2);
  writeFlag(view, activeB, POINT.DISABLED, false);

  writePoint(view, activeC, POINT.INDEX, 7);
  writePoint(view, activeC, POINT.DELTA, 1);
  writePoint(view, activeC, POINT.STEP, 80);
  writeFlag(view, activeC, POINT.DISABLED, false);

  writePoint(view, activeD, POINT.INDEX, 8);
  writePoint(view, activeD, POINT.DELTA, 1);
  writePoint(view, activeD, POINT.STEP, 81);
  writeFlag(view, activeD, POINT.DISABLED, false);

  linkByIndex(view, TEST_SENTINEL_OFFSET, [activeA, activeB, activeC, activeD]);

  writeLink(view, activeA, POINT.NEXT_ACTIVE, activeB);
  writeLink(view, activeB, POINT.NEXT_ACTIVE, activeC);
  writeLink(view, activeC, POINT.NEXT_ACTIVE, activeD);
  writeLink(view, activeD, POINT.NEXT_ACTIVE, null);
  writeLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_ACTIVE, activeA);

  const pruningState = {
    currentDisabledCount: 0,
    nextDisabledCount: 0,
    currentDuplicateIndexCount: 0,
  };
  const pointWindowCounts = {
    current: 9,
    next: 0,
  };
  const currentDeltaSumByIndex = new Int32Array(32);
  currentDeltaSumByIndex[5] = 2;
  currentDeltaSumByIndex[6] = 2;
  currentDeltaSumByIndex[7] = 2;
  currentDeltaSumByIndex[8] = 2;

  pruneCurrentGaincPoints(
    view,
    TEST_SENTINEL_OFFSET,
    pointWindowCounts,
    pruningState,
    currentDeltaSumByIndex
  );

  assert.equal(pruningState.currentDisabledCount, 2);
  assert.equal(readPoint(view, activeA, POINT.DISABLED), 1);
  assert.equal(readPoint(view, activeB, POINT.DISABLED), 1);
  assert.equal(readPoint(view, activeC, POINT.DISABLED), 0);
  assert.equal(readPoint(view, activeD, POINT.DISABLED), 0);
  assert.equal(readLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_ACTIVE), activeC);
  assert.equal(readLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_BY_INDEX), activeC);
});

test("pruneCurrentGaincPoints applies merged-run step updates when wrapped costs favor a same-index merge", () => {
  const buffer = new ArrayBuffer(0x800);
  const view = new DataView(buffer);
  const dummy = entryOffset(0);
  const mergePrev = entryOffset(1);
  const mergeMid = entryOffset(2);
  const mergeNext = entryOffset(3);

  writePoint(view, dummy, POINT.INDEX, 2);
  writePoint(view, dummy, POINT.DELTA, 1);
  writePoint(view, dummy, POINT.STEP, 300);
  writePoint(view, dummy, POINT.SPAN_COST, 0);
  writeFlag(view, dummy, POINT.DISABLED, false);

  writePoint(view, mergePrev, POINT.INDEX, 5);
  writePoint(view, mergePrev, POINT.DELTA, 2);
  writePoint(view, mergePrev, POINT.STEP, 10);
  writePoint(view, mergePrev, POINT.SPAN_COST, 0);
  writeFlag(view, mergePrev, POINT.DISABLED, false);

  writePoint(view, mergeMid, POINT.INDEX, 5);
  writePoint(view, mergeMid, POINT.DELTA, 1);
  writePoint(view, mergeMid, POINT.STEP, -214);
  writePoint(view, mergeMid, POINT.SPAN_COST, 20);
  writeFlag(view, mergeMid, POINT.DISABLED, false);

  writePoint(view, mergeNext, POINT.INDEX, 5);
  writePoint(view, mergeNext, POINT.DELTA, -1);
  writePoint(view, mergeNext, POINT.STEP, 20);
  writePoint(view, mergeNext, POINT.SPAN_COST, 0);
  writeFlag(view, mergeNext, POINT.DISABLED, false);

  linkByIndex(view, TEST_SENTINEL_OFFSET, [dummy, mergePrev, mergeMid, mergeNext]);

  writeLink(view, dummy, POINT.NEXT_ACTIVE, mergePrev);
  writeLink(view, mergePrev, POINT.NEXT_ACTIVE, mergeMid);
  writeLink(view, mergeMid, POINT.NEXT_ACTIVE, mergeNext);
  writeLink(view, mergeNext, POINT.NEXT_ACTIVE, null);
  writeLink(view, TEST_SENTINEL_OFFSET, POINT.NEXT_ACTIVE, dummy);

  const pruningState = {
    currentDisabledCount: 0,
    nextDisabledCount: 0,
    currentDuplicateIndexCount: 2,
  };
  const pointWindowCounts = {
    current: 10,
    next: 0,
  };
  const currentDeltaSumByIndex = new Int32Array(32);
  currentDeltaSumByIndex[2] = 2;
  currentDeltaSumByIndex[5] = 2;

  pruneCurrentGaincPoints(
    view,
    TEST_SENTINEL_OFFSET,
    pointWindowCounts,
    pruningState,
    currentDeltaSumByIndex
  );

  assert.equal(readPoint(view, mergeMid, POINT.DISABLED), 1);
  assert.equal(readPoint(view, mergePrev, POINT.STEP), 554);
  assert.equal(readPoint(view, mergeNext, POINT.STEP), 564);
  assert.equal(readPoint(view, mergePrev, POINT.SPAN_COST), 6);
  assert.equal(readPoint(view, mergeNext, POINT.SPAN_COST), 6);
  assert.equal(readLink(view, mergePrev, POINT.NEXT_ACTIVE), mergeNext);
  assert.equal(readLink(view, mergePrev, POINT.NEXT_BY_INDEX), mergeNext);
});

test("finalizePreviousGaincCurve accumulates deltas, drops duplicate indices, and clamps gain bounds", () => {
  const buffer = new ArrayBuffer(0x800);
  const view = new DataView(buffer);
  const first = entryOffset(0);
  const duplicate = entryOffset(1);
  const third = entryOffset(2);

  writePoint(view, first, POINT.INDEX, 8);
  writePoint(view, first, POINT.DELTA, -10);
  writeFlag(view, first, POINT.DISABLED, false);

  writePoint(view, duplicate, POINT.INDEX, 8);
  writePoint(view, duplicate, POINT.DELTA, 20);
  writeFlag(view, duplicate, POINT.DISABLED, false);

  writePoint(view, third, POINT.INDEX, 12);
  writePoint(view, third, POINT.DELTA, -1);
  writeFlag(view, third, POINT.DISABLED, false);

  linkByIndex(view, TEST_SENTINEL_OFFSET, [first, duplicate, third]);

  const curve = finalizePreviousGaincCurve(view, TEST_SENTINEL_OFFSET, TEST_GROUP_OFFSET, 3);

  assert.equal(curve.headOffset, duplicate);
  assert.equal(curve.minGain, -6);
  assert.equal(curve.maxGain, 9);
  assert.equal(readPoint(view, duplicate, POINT.DELTA), 10);
  assert.equal(readPoint(view, third, POINT.DELTA), 9);
  assert.equal(readPoint(view, first, POINT.NEXT_BY_INDEX), 0);
});

test("finalizePreviousGaincCurve keeps the last point across chained duplicate indices", () => {
  const buffer = new ArrayBuffer(0x800);
  const view = new DataView(buffer);
  const first = entryOffset(0);
  const second = entryOffset(1);
  const third = entryOffset(2);
  const fourth = entryOffset(3);

  writePoint(view, first, POINT.INDEX, 8);
  writePoint(view, first, POINT.DELTA, -1);
  writeFlag(view, first, POINT.DISABLED, false);

  writePoint(view, second, POINT.INDEX, 8);
  writePoint(view, second, POINT.DELTA, 2);
  writeFlag(view, second, POINT.DISABLED, false);

  writePoint(view, third, POINT.INDEX, 8);
  writePoint(view, third, POINT.DELTA, 3);
  writeFlag(view, third, POINT.DISABLED, false);

  writePoint(view, fourth, POINT.INDEX, 12);
  writePoint(view, fourth, POINT.DELTA, -1);
  writeFlag(view, fourth, POINT.DISABLED, false);

  linkByIndex(view, TEST_SENTINEL_OFFSET, [first, second, third, fourth]);

  const curve = finalizePreviousGaincCurve(view, TEST_SENTINEL_OFFSET, TEST_GROUP_OFFSET, 4);

  assert.equal(curve.headOffset, third);
  assert.equal(readPoint(view, third, POINT.DELTA), 4);
  assert.equal(readPoint(view, fourth, POINT.DELTA), 3);
  assert.equal(readPoint(view, first, POINT.NEXT_BY_INDEX), 0);
  assert.equal(readPoint(view, second, POINT.NEXT_BY_INDEX), 0);
});

test("encodeGaincCurveToRecordEntries skips repeated gains and writeGaincOutputRecord reverses output order", () => {
  const buffer = new ArrayBuffer(0x800);
  const view = new DataView(buffer);
  const first = entryOffset(0);
  const second = entryOffset(1);
  const third = entryOffset(2);

  writePoint(view, first, POINT.INDEX, 3);
  writePoint(view, first, POINT.DELTA, 1);
  writePoint(view, second, POINT.INDEX, 9);
  writePoint(view, second, POINT.DELTA, 1);
  writePoint(view, third, POINT.INDEX, 15);
  writePoint(view, third, POINT.DELTA, 5);

  writeLink(view, first, POINT.NEXT_BY_INDEX, second);
  writeLink(view, second, POINT.NEXT_BY_INDEX, third);
  writeLink(view, third, POINT.NEXT_BY_INDEX, null);

  const locs = new Int32Array(16);
  const gains = new Int32Array(16);
  const entryCount = encodeGaincCurveToRecordEntries(view, first, -6, 9, locs, gains);

  assert.equal(entryCount, 2);
  assert.deepEqual(Array.from(locs.slice(0, 2)), [3, 15]);
  assert.deepEqual(Array.from(gains.slice(0, 2)), [7, 11]);

  const record = {
    entries: 0,
    locations: new Uint32Array(16),
    levels: new Uint32Array(16),
  };
  writeGaincOutputRecord(record, locs, gains, entryCount);

  assert.equal(record.entries, 2);
  assert.deepEqual(Array.from(record.locations.slice(0, 2)), [15, 3]);
  assert.deepEqual(Array.from(record.levels.slice(0, 2)), [11, 7]);
});
