import assert from "node:assert/strict";
import test from "node:test";

import { calcNbitsForIdctAt5 } from "../../../src/atrac3plus/bitstream/idct-internal.js";
import { createChannelBlock } from "../../../src/atrac3plus/channel-block/construction.js";

function createChannel({
  channelIndex = 0,
  idsfCount,
  gainModeFlag = 0,
  idwl,
  values,
  baseIdwl = null,
  baseValues = null,
}) {
  const channel = {
    channelIndex,
    shared: { idsfCount, gainModeFlag },
    idwl: { values: Int32Array.from(idwl) },
    idct: {},
  };

  if (baseIdwl || baseValues) {
    channel.block0 = {
      idwl: { values: Int32Array.from(baseIdwl ?? idwl) },
      idct: { values: Uint32Array.from(baseValues ?? values) },
    };
  }

  return channel;
}

function createBlock(values) {
  const block = createChannelBlock();
  block.rebitallocScratch.specIndexByBand.set(values);
  return block;
}

function scratchState(block, count) {
  const packState = block.rebitallocScratch.packState;
  return {
    mode: packState.mode,
    count: packState.bandCount,
    flag: packState.flag,
    types: Array.from(packState.types.slice(0, count)),
  };
}

test("calcNbitsForIdctAt5 keeps forced fixed-width mode aligned with scratch state", () => {
  const channel = createChannel({
    channelIndex: 0,
    idsfCount: 5,
    idwl: [1, 0, 1, 0, 0],
    values: [3, 0, 2, 0, 0],
  });
  const block = createBlock([3, 0, 2, 0, 0]);

  const bits = calcNbitsForIdctAt5([channel], [block], 1, 0);

  assert.equal(bits, 9);
  assert.equal(channel.idctModeSelect, 0);
  assert.equal(channel.idct.flag, 0);
  assert.equal(channel.idct.count, 5);
  assert.deepEqual(scratchState(block, 5), {
    mode: 0,
    count: 5,
    flag: 0,
    types: [1, 0, 1, 0, 0],
  });
});

test("calcNbitsForIdctAt5 chooses direct Huffman coding for sparse primary deltas", () => {
  const channel = createChannel({
    channelIndex: 0,
    idsfCount: 5,
    gainModeFlag: 1,
    idwl: [1, 0, 1, 1, 0],
    values: [0, 0, 0, 1, 0],
  });
  const block = createBlock([0, 0, 0, 1, 0]);

  const bits = calcNbitsForIdctAt5([channel], [block], 1, 1);

  assert.equal(bits, 12);
  assert.equal(channel.idctModeSelect, 1);
  assert.equal(channel.idct.flag, 0);
  assert.equal(channel.idct.count, 4);
  assert.deepEqual(scratchState(block, 5), {
    mode: 1,
    count: 4,
    flag: 0,
    types: [1, 0, 1, 1, 0],
  });
});

test("calcNbitsForIdctAt5 chooses chained Huffman deltas when they are cheaper", () => {
  const channel = createChannel({
    channelIndex: 0,
    idsfCount: 5,
    gainModeFlag: 1,
    idwl: [1, 0, 1, 1, 0],
    values: [0, 0, 0, 6, 0],
  });
  const block = createBlock([0, 0, 0, 6, 0]);

  const bits = calcNbitsForIdctAt5([channel], [block], 1, 1);

  assert.equal(bits, 12);
  assert.equal(channel.idctModeSelect, 2);
  assert.equal(channel.idct.flag, 0);
  assert.equal(channel.idct.count, 4);
  assert.deepEqual(scratchState(block, 5), {
    mode: 2,
    count: 4,
    flag: 0,
    types: [1, 0, 1, 1, 0],
  });
});

test("calcNbitsForIdctAt5 keeps the truncated fixed-width path when it beats Huffman", () => {
  const channel = createChannel({
    channelIndex: 0,
    idsfCount: 5,
    gainModeFlag: 1,
    idwl: [1, 0, 1, 1, 0],
    values: [6, 0, 0, 0, 0],
  });
  const block = createBlock([6, 0, 0, 0, 0]);

  const bits = calcNbitsForIdctAt5([channel], [block], 1, 1);

  assert.equal(bits, 13);
  assert.equal(channel.idctModeSelect, 0);
  assert.equal(channel.idct.flag, 1);
  assert.equal(channel.idct.count, 1);
  assert.deepEqual(scratchState(block, 5), {
    mode: 0,
    count: 1,
    flag: 1,
    types: [1, 0, 1, 1, 0],
  });
});

test("calcNbitsForIdctAt5 preserves the zero-bit primary copy mode for empty payloads", () => {
  const channel = createChannel({
    channelIndex: 0,
    idsfCount: 5,
    idwl: [1, 0, 1, 0, 0],
    values: [0, 0, 0, 0, 0],
  });
  const block = createBlock([0, 0, 0, 0, 0]);

  const bits = calcNbitsForIdctAt5([channel], [block], 1, 1);

  assert.equal(bits, 4);
  assert.equal(channel.idctModeSelect, 3);
  assert.equal(channel.idct.flag, 0);
  assert.equal(channel.idct.count, 5);
  assert.deepEqual(scratchState(block, 5), {
    mode: 3,
    count: 5,
    flag: 0,
    types: [1, 0, 1, 0, 0],
  });
});

test("calcNbitsForIdctAt5 records stereo pair coding against the left block", () => {
  const left = createChannel({
    channelIndex: 0,
    idsfCount: 5,
    gainModeFlag: 1,
    idwl: [1, 0, 1, 1, 0],
    values: [0, 0, 0, 0, 0],
  });
  const right = createChannel({
    channelIndex: 1,
    idsfCount: 5,
    gainModeFlag: 1,
    idwl: [0, 1, 0, 0, 0],
    baseIdwl: [1, 0, 1, 1, 0],
    baseValues: [0, 0, 0, 0, 0],
    values: [0, 0, 0, 1, 0],
  });
  const leftBlock = createBlock([0, 0, 0, 0, 0]);
  const rightBlock = createBlock([0, 0, 0, 1, 0]);

  const bits = calcNbitsForIdctAt5([left, right], [leftBlock, rightBlock], 2, 1);

  assert.equal(bits, 12);
  assert.equal(left.idctModeSelect, 3);
  assert.equal(left.idct.count, 5);
  assert.equal(right.idctModeSelect, 3);
  assert.equal(right.idct.flag, 0);
  assert.equal(right.idct.count, 4);
  assert.deepEqual(scratchState(rightBlock, 5), {
    mode: 3,
    count: 4,
    flag: 0,
    types: [2, 1, 2, 2, 0],
  });
});
