import assert from "node:assert/strict";
import test from "node:test";

import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/buf.js";
import { setGaincAt5 } from "../../../src/atrac3plus/gainc/set.js";

function createGaincBlock(
  { coreMode = 0x12, channels = 1 } = {},
  { encodeMode = 0 } = {},
  { table0Fill = 4, table1Fill = 4 } = {}
) {
  return {
    header: {
      shared: { coreMode, channels },
      blockState: { encodeMode },
    },
    shared: { coreMode, channels },
    blockState: { encodeMode },
    table0: new Float32Array(33 * 16).fill(table0Fill),
    table1: new Float32Array(32 * 16).fill(table1Fill),
  };
}

function createGaincBuffers() {
  const prevBuf = createAt5EncodeBufBlock();
  const curBuf = createAt5EncodeBufBlock();

  prevBuf.records[0].entries = 1;
  prevBuf.records[0].levels[0] = 8;
  prevBuf.records[0].attackSeedLimit = 4;
  prevBuf.records[0].derivSeedLimit = 4;
  prevBuf.records[0].ampScaledMax = 16;

  curBuf.records[0].gainBase = 1;
  curBuf.records[0].tlev = 8;

  return { prevBuf, curBuf };
}

test("setGaincAt5 preserves the no-point flat-window path while refreshing the stored primary maxima", () => {
  const block = createGaincBlock();
  const { prevBuf, curBuf } = createGaincBuffers();
  const analysis = new Float32Array(0x180).fill(6);

  setGaincAt5([block], analysis, 0, 0, prevBuf, curBuf, 1);

  const record = curBuf.records[0];
  assert.equal(record.entries, 0);
  assert.equal(record.attackTotal, 0);
  assert.equal(record.releaseTotal, 0);
  assert.equal(record.releaseLast, 31);
  assert.equal(record.minAll, 4);
  assert.equal(record.minHi, 4);
  assert.equal(record.minTail, 4);
  assert.equal(record.ampScaledMax, 4);
  assert.equal(record.attackSeedLimit, 4);
  assert.equal(record.derivSeedLimit, 4);
  assert.equal(record.ampSlotMaxSum, 192);
  assert.equal(record.derivSlotMaxSum, 128);
  assert.deepEqual(Array.from(block.table0.slice(0, 32)), new Array(32).fill(6));
});

test("setGaincAt5 preserves the simple tail-attack output for a steadily rising band", () => {
  const block = createGaincBlock();
  const { prevBuf, curBuf } = createGaincBuffers();
  const analysis = new Float32Array(0x180);

  for (let i = 0; i < analysis.length; i += 1) {
    analysis[i] = i / 32;
  }

  setGaincAt5([block], analysis, 0, 0, prevBuf, curBuf, 1);

  const record = curBuf.records[0];
  assert.equal(record.entries, 1);
  assert.equal(record.attackPoints, 1);
  assert.equal(record.attackFirst, 31);
  assert.equal(record.attackTotal, 1);
  assert.equal(record.locations[0], 31);
  assert.equal(record.levels[0], 7);
  assert.equal(record.ampScaledMax, 8);
  assert.equal(record.attackSeedLimit, 8.09375);
  assert.equal(record.minAll, 4);
  assert.equal(record.minHi, 4);
  assert.equal(record.minTail, 4);
  assert.equal(record.ampSlotMaxSum, 321);
});

test("setGaincAt5 skips derivative tracking in encoder2 mode while keeping the primary no-point path", () => {
  const block = createGaincBlock({}, { encodeMode: 2 });
  const { prevBuf, curBuf } = createGaincBuffers();
  curBuf.records[0].derivMaxHi = 0;
  const analysis = new Float32Array(0x180).fill(6);

  setGaincAt5([block], analysis, 0, 0, prevBuf, curBuf, 1);

  const record = curBuf.records[0];
  assert.equal(record.entries, 0);
  assert.equal(record.minAll, 4);
  assert.equal(record.minHi, 4);
  assert.equal(record.ampScaledMax, 4);
  assert.equal(record.attackSeedLimit, 4);
  assert.equal(record.derivMaxHi, 0);
  assert.equal(record.derivSeedLimit, 4);
  assert.equal(record.derivSlotMaxSum, 128);
  assert.deepEqual(Array.from(block.table1.slice(0, 32)), new Array(32).fill(4));
});

test("setGaincAt5 preserves derivative attack seeding from the stored history window", () => {
  const block = createGaincBlock();
  block.table1[0] = 4;
  block.table1[1] = 64;

  const { prevBuf, curBuf } = createGaincBuffers();
  const analysis = new Float32Array(0x180).fill(6);

  setGaincAt5([block], analysis, 0, 0, prevBuf, curBuf, 1);

  const record = curBuf.records[0];
  assert.equal(record.entries, 0);
  assert.equal(record.attackTotalB, 4);
  assert.equal(record.releaseTotalB, 0);
});
