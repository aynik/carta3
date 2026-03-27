import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInterleavedPcmInput,
  assertPlanarF32Scratch,
  copyInterleavedPcmToPlanarF32,
  createPlanarF32Frame,
  ensurePlanarF32Frame,
  interleavedFrameToPlanar,
} from "../../src/common/pcm-planar.js";

test("createPlanarF32Frame builds isolated planar Float32 lanes", () => {
  const frame = createPlanarF32Frame(3, 4);

  assert.deepEqual(
    frame.map((channel) => channel.length),
    [4, 4, 4]
  );
  assert.notEqual(frame[0], frame[1]);
  assert.notEqual(frame[1], frame[2]);
});

test("ensurePlanarF32Frame preserves the current scratch reuse and growth policy", () => {
  const scratch = createPlanarF32Frame(2, 4);
  const reused = ensurePlanarF32Frame(scratch, 2, 4);
  const grown = ensurePlanarF32Frame(scratch, 3, 6);
  const repaired = ensurePlanarF32Frame([new Float32Array(1), new Uint8Array(4)], 2, 4);

  assert.equal(reused, scratch);
  assert.notEqual(grown, scratch);
  assert.notEqual(repaired, scratch);
  assert.deepEqual(
    grown.map((channel) => channel.length),
    [6, 6, 6]
  );
  assert.deepEqual(
    repaired.map((channel) => ({
      type: channel.constructor.name,
      length: channel.length,
    })),
    [
      { type: "Float32Array", length: 4 },
      { type: "Float32Array", length: 4 },
    ]
  );
});

test("assertPlanarF32Scratch validates reusable planar frame lanes", () => {
  const scratch = createPlanarF32Frame(2, 4);

  assert.equal(assertPlanarF32Scratch(scratch, 2, 4), scratch);
  assert.throws(
    () => assertPlanarF32Scratch([new Float32Array(0), new Float32Array(4)], 2, 1),
    /scratch\[0\] must be a Float32Array of length >= 1/
  );
});

test("assertInterleavedPcmInput preserves current shared validation errors", () => {
  assert.throws(
    () => assertInterleavedPcmInput(new Uint8Array(4), 2),
    /pcmI16 must be an Int16Array/
  );
  assert.throws(() => assertInterleavedPcmInput(new Int16Array(4), 0), /invalid channel count: 0/);
  assert.throws(
    () => assertInterleavedPcmInput(new Int16Array(3), 2),
    /PCM sample length 3 is not divisible by channel count 2/
  );
});

test("interleavedFrameToPlanar reshapes interleaved PCM into channel buffers", () => {
  const pcm = Int16Array.from([1, 10, 100, 2, 20, 200, 3, 30, 300]);

  const planar = interleavedFrameToPlanar(pcm, 3);

  assert.deepEqual(
    planar.map((channel) => Array.from(channel)),
    [
      [1, 2, 3],
      [10, 20, 30],
      [100, 200, 300],
    ]
  );
});

test("copyInterleavedPcmToPlanarF32 deinterleaves into reusable float scratch", () => {
  const scratch = createPlanarF32Frame(3, 4);
  scratch[2].fill(9);

  const planar = copyInterleavedPcmToPlanarF32(Int16Array.from([1, 10, 2, 20, 3, 30]), 2, 4, {
    outputChannels: 3,
    scratch,
  });

  assert.equal(planar, scratch);
  assert.deepEqual(
    planar.map((channel) => Array.from(channel)),
    [
      [1, 2, 3, 0],
      [10, 20, 30, 0],
      [0, 0, 0, 0],
    ]
  );
});

test("copyInterleavedPcmToPlanarF32 preserves truncated packedSampleCount reads", () => {
  const planar = copyInterleavedPcmToPlanarF32(Int16Array.from([1, 10, 2, 20, 999]), 2, 3, {
    packedSampleCount: 4,
  });

  assert.deepEqual(
    planar.map((channel) => Array.from(channel)),
    [
      [1, 2, 0],
      [10, 20, 0],
    ]
  );
});

test("copyInterleavedPcmToPlanarF32 preserves the legacy totalSamples alias", () => {
  const planar = copyInterleavedPcmToPlanarF32(Int16Array.from([1, 10, 2, 20, 999]), 2, 3, {
    totalSamples: 4,
  });

  assert.deepEqual(
    planar.map((channel) => Array.from(channel)),
    [
      [1, 2, 0],
      [10, 20, 0],
    ]
  );
});

test("copyInterleavedPcmToPlanarF32 rejects conflicting packed-sample aliases", () => {
  assert.throws(
    () =>
      copyInterleavedPcmToPlanarF32(Int16Array.from([1, 10, 2, 20]), 2, 2, {
        packedSampleCount: 2,
        totalSamples: 4,
      }),
    /packedSampleCount 2 does not match legacy totalSamples 4/
  );
});

test("copyInterleavedPcmToPlanarF32 supports source and target sample offsets", () => {
  const scratch = createPlanarF32Frame(2, 4);

  copyInterleavedPcmToPlanarF32(Int16Array.from([1, 11, 2, 22, 3, 33, 4, 44]), 2, 4, {
    scratch,
    packedSampleCount: 4,
    sourceSampleOffset: 1,
    targetSampleOffset: 1,
  });

  assert.deepEqual(
    scratch.map((channel) => Array.from(channel)),
    [
      [0, 2, 3, 0],
      [0, 22, 33, 0],
    ]
  );
});

test("copyInterleavedPcmToPlanarF32 rejects smaller output channel counts", () => {
  assert.throws(
    () =>
      copyInterleavedPcmToPlanarF32(Int16Array.from([1, 10, 2, 20]), 2, 2, {
        outputChannels: 1,
      }),
    /output channel count 1 cannot be smaller than input channel count 2/
  );
});

test("copyInterleavedPcmToPlanarF32 validates reusable scratch channel lengths", () => {
  assert.throws(
    () =>
      copyInterleavedPcmToPlanarF32(Int16Array.from([1, 10]), 2, 1, {
        scratch: [new Float32Array(0), new Float32Array(1)],
      }),
    /scratch\[0\] must be a Float32Array of length >= 1/
  );
});

test("PCM planar helpers reject copy windows that exceed the frame length", () => {
  assert.throws(
    () => copyInterleavedPcmToPlanarF32(new Int16Array(8), 2, 3),
    /PCM frame count 4 exceeds frame length 3/
  );
});
