import assert from "node:assert/strict";
import test from "node:test";

import {
  calcNbitsForIdwl1At5,
  calcNbitsForIdwl3At5,
  idwlWorkMode1Base,
  idwlWorkMode1Lead,
  idwlWorkMode1Width,
} from "../../../src/atrac3plus/bitstream/internal.js";
import { createAt5IdwlScratch } from "../../../src/atrac3plus/channel-block/construction.js";

function createScratch() {
  return createAt5IdwlScratch(new Uint8Array(0x290));
}

test("calcNbitsForIdwl1At5 keeps the cheapest flat range-coded row selection explicit", () => {
  const scratch = createScratch();
  scratch.rowEnabled.set([1, 1, 0, 0]);
  scratch.rowSeq[0].set([0, 7, 0, 7]);
  scratch.rowSeq[1].set([2, 2, 2, 2]);
  scratch.bandCountBySlot.set([4, 4, 4, 4, 4, 4, 4, 4]);
  scratch.mappedGroupBySlot.fill(-1);
  scratch.extraWordByIndex.set([1, 5, 0, 0]);

  const bits = calcNbitsForIdwl1At5({ channelIndex: 0, shared: { bandLimit: 4 } }, scratch);

  assert.equal(bits, 14);
  assert.deepEqual(Array.from(scratch.slot1Config), [0, 0, 4, 5, 1]);
  assert.equal(idwlWorkMode1Lead(scratch.work), 0);
  assert.equal(idwlWorkMode1Width(scratch.work), 0);
  assert.equal(idwlWorkMode1Base(scratch.work), 2);
});

test("calcNbitsForIdwl3At5 keeps the cheapest delta-coded row selection explicit", () => {
  const scratch = createScratch();
  scratch.rowEnabled.set([1, 1, 0, 0]);
  scratch.rowSeq[0].set([1, 2, 3, 4]);
  scratch.rowSeq[1].set([2, 2, 2, 2]);
  scratch.bandCountBySlot.set([4, 4, 4, 4, 4, 4, 4, 4]);
  scratch.mappedGroupBySlot.fill(-1);
  scratch.extraWordByIndex.set([2, 6, 0, 0]);

  const bits = calcNbitsForIdwl3At5({ channelIndex: 0, shared: { bandLimit: 4 } }, scratch);

  assert.equal(bits, 12);
  assert.deepEqual(Array.from(scratch.slot3Config), [0, 0, 4, 6, 1]);
});

test("calcNbitsForIdwl3At5 still allows header-only empty groups to beat costly deltas", () => {
  const scratch = createScratch();
  scratch.rowEnabled.set([1, 0, 0, 0]);
  scratch.rowSeq[0].set([4, 2, 3, 0, 4, 3, 3, 6]);
  scratch.bandCountBySlot.set([5, 0, 2, 5]);
  scratch.mappedGroupBySlot.fill(-1);
  scratch.extraWordByIndex.set([0, 0, 0, 0]);

  const bits = calcNbitsForIdwl3At5({ channelIndex: 0, shared: { bandLimit: 8 } }, scratch);

  assert.equal(bits, 9);
  assert.deepEqual(Array.from(scratch.slot3Config), [0, 1, 0, 0, 0]);
});

test("calcNbitsForIdwl1At5 ignores header-only empty mapped groups", () => {
  const scratch = createScratch();
  scratch.rowEnabled.set([1, 0, 0, 0]);
  scratch.rowSeq[0].set([3, 6, 3]);
  scratch.bandCountBySlot.set([1, 1, 1, 0]);
  scratch.mappedGroupBySlot.set([-1, 0, 1, -1]);
  scratch.extraWordByIndex.set([6, 0, 0, 0]);

  const bits = calcNbitsForIdwl1At5({ channelIndex: 1, shared: { bandLimit: 3 } }, scratch);

  assert.equal(bits, 14);
  assert.deepEqual(Array.from(scratch.slot1Config), [0, 0, 1, 6, 0]);
});
