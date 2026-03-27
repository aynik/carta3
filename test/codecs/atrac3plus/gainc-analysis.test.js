import assert from "node:assert/strict";
import test from "node:test";

import { analyzeGainWindows } from "../../../src/atrac3plus/gainc/set.js";

const TABLE0_WORDS = 0x21;
const TABLE1_WORDS = 0x20;

function createGaincBlock() {
  return {
    table0: Float32Array.from({ length: TABLE0_WORDS }, (_, i) => i + 1),
    table1: Float32Array.from({ length: TABLE1_WORDS }, (_, i) => i + 1),
  };
}

test("analyzeGainWindows preserves crossover history semantics while refreshing slot maxima", () => {
  const block = createGaincBlock();
  const analysis = new Float32Array(0x180);
  for (let i = 0; i < 0x80; i += 1) {
    analysis[0x100 + i] = i % 2 === 0 ? 20 : 0;
  }

  const prev = {
    histA: 4,
    histB: 2,
    ampSlotMaxSum: 123,
    derivSlotMaxSum: 456,
  };
  const cur = {
    minTail: 0,
    ampSlotMaxSum: 0,
    derivSlotMaxSum: 0,
  };
  const ampWindow = new Float32Array(66);
  const derivVals = new Float32Array(0x180);
  const derivWindow = new Float32Array(101);
  const ampPairs = new Float32Array(0x24);

  const result = analyzeGainWindows(
    block,
    analysis,
    0,
    true,
    prev,
    cur,
    ampWindow,
    derivVals,
    derivWindow,
    ampPairs
  );

  assert.equal(result.noisyHist, true);
  assert.equal(result.prevHistB, 2);
  assert.equal(result.prevSumAmp, 123);
  assert.equal(result.prevSumDeriv, 456);
  assert.equal(result.sumAmp, 640);
  assert.equal(result.sumDeriv, 320);
  assert.equal(result.ampPeakIdx, 31);
  assert.equal(result.releasePeakIdx, 31);
  assert.equal(result.derivPeakIdx, 29);
  assert.equal(cur.minTail, 32);
  assert.equal(cur.ampSlotMaxSum, 640);
  assert.equal(cur.derivSlotMaxSum, 320);
  assert.deepEqual(Array.from(block.table0.slice(0, 5)), [20, 20, 20, 20, 20]);
  assert.deepEqual(Array.from(block.table0.slice(-2)), [20, 0]);
  assert.deepEqual(Array.from(block.table1.slice(0, 5)), [10, 10, 10, 10, 10]);
  assert.deepEqual(Array.from(ampPairs.slice(0, 8)), [2, 2, 4, 4, 6, 6, 8, 8]);
  assert.deepEqual(Array.from(derivWindow.slice(0, 8)), [2, 2, 4, 4, 6, 6, 8, 8]);
});
