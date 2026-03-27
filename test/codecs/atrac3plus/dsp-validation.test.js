import assert from "node:assert/strict";
import test from "node:test";

import {
  addSeqAt5,
  backwardTransformAt5,
  copyGainRecordToGaincBlock,
  createAt5GaincBlock,
  synthesisWavAt5,
  subSeqAt5,
} from "../../../src/atrac3plus/dsp.js";

test("ATRAC3plus DSP entrypoints fail fast on invalid vector counts", () => {
  assert.throws(
    () => addSeqAt5(new Float32Array(4), new Float32Array(4), new Float32Array(4), -1),
    RangeError
  );
});

test("ATRAC3plus vector math processes tail samples", () => {
  const a = Float32Array.from([1, 2, 3, 4, 5, 6]);
  const b = Float32Array.from([10, 20, 30, 40, 50, 60]);
  const out = new Float32Array(6).fill(99);

  addSeqAt5(a, b, out, 6);
  assert.deepEqual(Array.from(out), [11, 22, 33, 44, 55, 66]);

  subSeqAt5(b, a, out, 6);
  assert.deepEqual(Array.from(out), [9, 18, 27, 36, 45, 54]);
});

test("backwardTransformAt5 rejects invalid block counts instead of silently no-op'ing", () => {
  assert.throws(() => backwardTransformAt5(null, null, null, null, undefined, null), RangeError);
});

test("synthesisWavAt5 rejects missing contexts instead of returning silence", () => {
  assert.throws(() => synthesisWavAt5(null, new Float32Array(1), 0, 1, 0, 0, 0), TypeError);
});

test("copyGainRecordToGaincBlock rejects malformed records", () => {
  assert.throws(() => copyGainRecordToGaincBlock({}, createAt5GaincBlock()), RangeError);
});
