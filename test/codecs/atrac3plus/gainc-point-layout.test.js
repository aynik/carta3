import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_GC_POINT_FIELDS as POINT,
  AT5_GC_POINT_ENTRY_STRIDE_BYTES,
  insertGaincEntryByIndex,
  readGaincPoint as readPoint,
  readGaincPointLink as readLink,
  writeGaincPoint as writePoint,
} from "../../../src/atrac3plus/gainc/point-layout.js";

function entryOffset(index) {
  return AT5_GC_POINT_ENTRY_STRIDE_BYTES + index * AT5_GC_POINT_ENTRY_STRIDE_BYTES;
}

function seedPoint(view, offset, { index, delta, pointCount }) {
  writePoint(view, offset, POINT.INDEX, index);
  writePoint(view, offset, POINT.DELTA, delta);
  writePoint(view, offset, POINT.POINT_COUNT, pointCount);
}

function collectPointCounts(view, sentinelOffset) {
  const counts = [];
  for (
    let pointOffset = readLink(view, sentinelOffset, POINT.NEXT_BY_INDEX);
    pointOffset !== null;
    pointOffset = readLink(view, pointOffset, POINT.NEXT_BY_INDEX)
  ) {
    counts.push(readPoint(view, pointOffset, POINT.POINT_COUNT));
  }
  return counts;
}

function collectIndices(view, sentinelOffset) {
  const indices = [];
  for (
    let pointOffset = readLink(view, sentinelOffset, POINT.NEXT_BY_INDEX);
    pointOffset !== null;
    pointOffset = readLink(view, pointOffset, POINT.NEXT_BY_INDEX)
  ) {
    indices.push(readPoint(view, pointOffset, POINT.INDEX));
  }
  return indices;
}

function collectOffsets(view, sentinelOffset) {
  const offsets = [];
  for (
    let pointOffset = readLink(view, sentinelOffset, POINT.NEXT_BY_INDEX);
    pointOffset !== null;
    pointOffset = readLink(view, pointOffset, POINT.NEXT_BY_INDEX)
  ) {
    offsets.push(pointOffset);
  }
  return offsets;
}

test("insertGaincEntryByIndex keeps the scratch curve sorted by descending point index", () => {
  const view = new DataView(new ArrayBuffer(0x200));
  const sentinelOffset = 0;
  const offsets = [entryOffset(0), entryOffset(1), entryOffset(2)];

  seedPoint(view, offsets[0], { index: 10, delta: 1, pointCount: 1 });
  seedPoint(view, offsets[1], { index: 12, delta: 1, pointCount: 1 });
  seedPoint(view, offsets[2], { index: 8, delta: 1, pointCount: 1 });

  let tailOffset = null;
  for (const offset of offsets) {
    tailOffset = insertGaincEntryByIndex(view, sentinelOffset, tailOffset, offset);
  }

  assert.deepEqual(collectIndices(view, sentinelOffset), [12, 10, 8]);
  assert.equal(tailOffset, offsets[2]);
});

test("insertGaincEntryByIndex uses opposite point-count tie breaks for closing and opening edges", () => {
  const view = new DataView(new ArrayBuffer(0x400));
  const sentinelOffset = 0;
  const negativeOffsets = [entryOffset(0), entryOffset(1), entryOffset(2)];
  const positiveOffsets = [entryOffset(3), entryOffset(4), entryOffset(5)];

  seedPoint(view, negativeOffsets[0], { index: 10, delta: -2, pointCount: 2 });
  seedPoint(view, negativeOffsets[1], { index: 10, delta: -2, pointCount: 4 });
  seedPoint(view, negativeOffsets[2], { index: 10, delta: -2, pointCount: 1 });

  let tailOffset = null;
  for (const offset of negativeOffsets) {
    tailOffset = insertGaincEntryByIndex(view, sentinelOffset, tailOffset, offset);
  }

  assert.deepEqual(collectPointCounts(view, sentinelOffset), [4, 2, 1]);
  assert.equal(tailOffset, negativeOffsets[2]);

  const positiveSentinelOffset = entryOffset(6);
  seedPoint(view, positiveOffsets[0], { index: 10, delta: 2, pointCount: 2 });
  seedPoint(view, positiveOffsets[1], { index: 10, delta: 2, pointCount: 4 });
  seedPoint(view, positiveOffsets[2], { index: 10, delta: 2, pointCount: 1 });

  tailOffset = null;
  for (const offset of positiveOffsets) {
    tailOffset = insertGaincEntryByIndex(view, positiveSentinelOffset, tailOffset, offset);
  }

  assert.deepEqual(collectPointCounts(view, positiveSentinelOffset), [1, 2, 4]);
  assert.equal(tailOffset, positiveOffsets[1]);
});

test("insertGaincEntryByIndex keeps later equal-span points at the front of a same-index run", () => {
  const view = new DataView(new ArrayBuffer(0x400));
  const openingSentinelOffset = 0;
  const openingOffsets = [entryOffset(0), entryOffset(1)];

  seedPoint(view, openingOffsets[0], { index: 10, delta: 2, pointCount: 2 });
  seedPoint(view, openingOffsets[1], { index: 10, delta: 2, pointCount: 2 });

  let tailOffset = null;
  for (const offset of openingOffsets) {
    tailOffset = insertGaincEntryByIndex(view, openingSentinelOffset, tailOffset, offset);
  }

  assert.deepEqual(collectOffsets(view, openingSentinelOffset), [
    openingOffsets[1],
    openingOffsets[0],
  ]);
  assert.equal(tailOffset, openingOffsets[0]);

  const closingSentinelOffset = entryOffset(6);
  const closingOffsets = [entryOffset(2), entryOffset(3)];

  seedPoint(view, closingOffsets[0], { index: 10, delta: -2, pointCount: 2 });
  seedPoint(view, closingOffsets[1], { index: 10, delta: -2, pointCount: 2 });

  tailOffset = null;
  for (const offset of closingOffsets) {
    tailOffset = insertGaincEntryByIndex(view, closingSentinelOffset, tailOffset, offset);
  }

  assert.deepEqual(collectOffsets(view, closingSentinelOffset), [
    closingOffsets[1],
    closingOffsets[0],
  ]);
  assert.equal(tailOffset, closingOffsets[0]);
});
