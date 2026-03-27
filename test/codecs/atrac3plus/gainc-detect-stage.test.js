import assert from "node:assert/strict";
import test from "node:test";

import { AT5_GAINC_BANDS_MAX } from "../../../src/atrac3plus/gainc/helpers.js";
import { detectGaincDataNewAt5 } from "../../../src/atrac3plus/gainc/detect.js";
import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/buf.js";

function createGaincRuntimeBlock() {
  return {
    pointGroupCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    disabledPointCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    gainLevelBoundsHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    peakIndexHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    peakValueHistory: new Float32Array(AT5_GAINC_BANDS_MAX * 2),
    windowAbsHistory: new Float32Array(AT5_GAINC_BANDS_MAX * 64),
    windowScaleHistory: new Float32Array(AT5_GAINC_BANDS_MAX * 64),
    trailingWindowPeakHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
    duplicatePointCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX),
    gainPointHistoryBytes: new Uint8Array(0x18000),
    stereoBandEnergyHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
    stereoBandEnergyRatioHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
  };
}

function createDetectAnalysis() {
  const analysis = new Float32Array(640);

  for (let block = 0; block < 32; block += 1) {
    analysis[512 + block * 4] = block + 1;
  }

  for (let i = 0; i < 16; i += 1) {
    analysis[500 + i] = i % 4 === 0 ? 1 : 0;
  }

  return analysis;
}

function assertAlmostEqual(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("detectGaincDataNewAt5 bootstraps an empty mono runtime history from the new analysis window", () => {
  const block = createGaincRuntimeBlock();
  const curBuf = createAt5EncodeBufBlock();

  detectGaincDataNewAt5(
    [block],
    [createDetectAnalysis()],
    [createAt5EncodeBufBlock()],
    [curBuf],
    1,
    1
  );

  assert.equal(curBuf.records[0].entries, 0);
  assert.equal(block.pointGroupCountHistory[0], 0);
  assert.equal(block.pointGroupCountHistory[1], 0);
  assert.equal(block.peakIndexHistory[0], 0);
  assert.equal(block.peakIndexHistory[1], 31);
  assert.equal(block.peakValueHistory[0], 0);
  assert.equal(block.peakValueHistory[1], 32);
  assert.equal(block.trailingWindowPeakHistory[0], 0);
  assert.deepEqual(Array.from(block.windowAbsHistory.slice(0, 32)), new Array(32).fill(0));
  assert.deepEqual(Array.from(block.windowAbsHistory.slice(32, 40)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(block.windowScaleHistory[63], 0);
  assertAlmostEqual(block.windowScaleHistory[54], 1.2760169506072998);
});

test("detectGaincDataNewAt5 rotates the current mono history forward before storing the new window", () => {
  const block = createGaincRuntimeBlock();
  const curBuf = createAt5EncodeBufBlock();

  for (let i = 0; i < 64; i += 1) {
    block.windowAbsHistory[i] = i + 10;
    block.windowScaleHistory[i] = i + 20;
  }
  block.pointGroupCountHistory.set([2, 3], 0);
  block.disabledPointCountHistory.set([4, 5], 0);
  block.gainLevelBoundsHistory.set([6, 7], 0);
  block.peakIndexHistory.set([8, 9], 0);
  block.peakValueHistory.set([10.5, 11.5], 0);
  block.trailingWindowPeakHistory[0] = 12.5;
  block.duplicatePointCountHistory[0] = 13;

  detectGaincDataNewAt5(
    [block],
    [createDetectAnalysis()],
    [createAt5EncodeBufBlock()],
    [curBuf],
    1,
    1
  );

  assert.equal(curBuf.records[0].entries, 0);
  assert.equal(block.pointGroupCountHistory[0], 3);
  assert.equal(block.pointGroupCountHistory[1], 0);
  assert.equal(block.disabledPointCountHistory[0], 5);
  assert.equal(block.disabledPointCountHistory[1], 0);
  assert.equal(block.peakIndexHistory[0], 9);
  assert.equal(block.peakIndexHistory[1], 31);
  assert.equal(block.peakValueHistory[0], 11.5);
  assert.equal(block.peakValueHistory[1], 32);
  assert.equal(block.trailingWindowPeakHistory[0], 41);
  assert.equal(block.duplicatePointCountHistory[0], 2);
  assert.deepEqual(
    Array.from(block.windowAbsHistory.slice(0, 8)),
    [42, 43, 44, 45, 46, 47, 48, 49]
  );
  assert.deepEqual(Array.from(block.windowAbsHistory.slice(32, 40)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    Array.from(block.windowScaleHistory.slice(0, 8)),
    [52, 53, 54, 55, 56, 57, 58, 59]
  );
  assert.equal(block.windowScaleHistory[63], 0);
  assertAlmostEqual(block.windowScaleHistory[31], 1.435490369796753);
});
