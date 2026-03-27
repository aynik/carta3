import assert from "node:assert/strict";
import test from "node:test";

import {
  computeRowMetaAndBandCountsForRow,
  refreshIdwlRowBandCountsForIndex,
  resetIdwlRowBandCounts,
} from "../../../src/atrac3plus/bitstream/idwl-rows.js";
import { createAt5IdwlScratch } from "../../../src/atrac3plus/channel-block/construction.js";

function createScratch() {
  return createAt5IdwlScratch();
}

function rowState(scratch, row) {
  const baseSlot = (row * 4) | 0;
  return {
    extra: scratch.extraWordByIndex[row] | 0,
    bandCountBySlot: Array.from(scratch.bandCountBySlot.slice(baseSlot, baseSlot + 4)),
    mappedGroups: Array.from(scratch.mappedGroupBySlot.slice(baseSlot, baseSlot + 4)),
  };
}

test("resetIdwlRowBandCounts clears one row without disturbing others", () => {
  const scratch = createScratch();

  scratch.bandCountBySlot.set([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6]);
  scratch.mappedGroupBySlot.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  scratch.extraWordByIndex.set([1, 2, 3, 4]);

  resetIdwlRowBandCounts(scratch, 2, 6);

  assert.deepEqual(
    Array.from(scratch.bandCountBySlot),
    [9, 8, 7, 6, 5, 4, 3, 2, 6, 6, 6, 6, -3, -4, -5, -6]
  );
  assert.deepEqual(
    Array.from(scratch.mappedGroupBySlot),
    [0, 1, 2, 3, 4, 5, 6, 7, -1, -1, -1, -1, 12, 13, 14, 15]
  );
  assert.deepEqual(Array.from(scratch.extraWordByIndex), [1, 2, 0, 4]);
});

test("refreshIdwlRowBandCountsForIndex preserves primary-row tail-zero metadata", () => {
  const scratch = createScratch();
  const row = 2;
  const bandLimit = 6;
  const rowCoeffs = scratch.rowSeq[row];

  rowCoeffs.set([3, 3, 1, 1, 0, 0]);
  computeRowMetaAndBandCountsForRow(0, bandLimit, rowCoeffs, scratch, row);

  rowCoeffs[3] = 0;
  refreshIdwlRowBandCountsForIndex(0, bandLimit, rowCoeffs, scratch, row, 3);

  assert.deepEqual(rowState(scratch, row), {
    extra: 3,
    bandCountBySlot: [6, 3, 6, 2],
    mappedGroups: [-1, -1, 0, -1],
  });
});

test("refreshIdwlRowBandCountsForIndex preserves stereo ones-run metadata", () => {
  const scratch = createScratch();
  const row = 3;
  const bandLimit = 6;
  const rowCoeffs = scratch.rowSeq[row];

  rowCoeffs.set([3, 3, 1, 1, 2, 0]);
  computeRowMetaAndBandCountsForRow(1, bandLimit, rowCoeffs, scratch, row);

  rowCoeffs[4] = 1;
  refreshIdwlRowBandCountsForIndex(1, bandLimit, rowCoeffs, scratch, row, 4);

  assert.deepEqual(rowState(scratch, row), {
    extra: 3,
    bandCountBySlot: [6, 5, 2, 2],
    mappedGroups: [-1, -1, -1, 2],
  });
});
