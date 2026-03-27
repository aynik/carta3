import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAt3GainControlBlock,
  createAt3GainControlBlock,
  createAt3GainControlBlocks,
  getAt3GainControlCount,
  getAt3GainControlEnd,
  getAt3GainControlGainId,
  getAt3GainControlMaxFirst,
  getAt3GainControlWords,
  hasAt3GainControl,
  isAt3GainControlAttack,
  setAt3GainControlCount,
  setAt3GainControlEntry,
  setAt3GainControlMaxFirst,
} from "../../../../src/atrac3/scx/gainc-layout.js";

test("ATRAC3 SCX gain-control layout helpers preserve the packed word layout", () => {
  const block = createAt3GainControlBlock();
  setAt3GainControlCount(block, 2);
  setAt3GainControlEntry(block, 0, 3, 6);
  setAt3GainControlEntry(block, 1, 5, 9);
  setAt3GainControlMaxFirst(block, 1234);

  assert.equal(getAt3GainControlCount(block), 2);
  assert.equal(getAt3GainControlEnd(block, 0), 3);
  assert.equal(getAt3GainControlEnd(block, 1), 5);
  assert.equal(getAt3GainControlGainId(block, 0), 6);
  assert.equal(getAt3GainControlGainId(block, 1), 9);
  assert.equal(getAt3GainControlMaxFirst(block), 1234);
  assert.equal(hasAt3GainControl(block), true);
  assert.deepEqual(
    Array.from(getAt3GainControlWords(block)),
    [2, 3, 5, 0, 0, 0, 0, 0, 6, 9, 0, 0, 0, 0, 0, 0]
  );
});

test("ATRAC3 SCX gain-control block helpers create isolated neutral blocks", () => {
  const [first, second] = createAt3GainControlBlocks(2);
  setAt3GainControlCount(first, 1);

  assert.equal(getAt3GainControlCount(first), 1);
  assert.equal(getAt3GainControlCount(second), 0);
  assert.equal(getAt3GainControlMaxFirst(first), 0);
  assert.equal(getAt3GainControlMaxFirst(second), 0);
  assert.notEqual(first, second);
});

test("ATRAC3 SCX gain-control block helpers clear words and side metadata together", () => {
  const block = createAt3GainControlBlock();
  setAt3GainControlCount(block, 1);
  setAt3GainControlEntry(block, 0, 3, 6);
  setAt3GainControlMaxFirst(block, 1234);

  assert.equal(clearAt3GainControlBlock(block), block);
  assert.deepEqual(Array.from(getAt3GainControlWords(block)), Array(16).fill(0));
  assert.equal(getAt3GainControlMaxFirst(block), 0);
});

test("ATRAC3 SCX gain-control layout helpers preserve attack detection semantics", () => {
  assert.equal(isAt3GainControlAttack(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0)), 0);
  assert.equal(isAt3GainControlAttack(Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 0, 1, 4, 7)), 1);
  assert.equal(isAt3GainControlAttack(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 6, 0, 15, 0)), 0);
  assert.equal(isAt3GainControlAttack(Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0, 6, 2, 15, 0)), 1);
});
