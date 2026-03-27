import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAtracEncodeFrames,
  computeAtracEncodePadPlan,
  createAtracEncodeInputPlan,
  createAtracEncodeFrameCollector,
  prepareAtracEncodePcmFrames,
  splitInterleavedPcmFrames,
  stageInterleavedPcmFramePlans,
  stageInterleavedPcmFrames,
} from "../../src/encoders/pcm.js";
import {
  copyInterleavedPcmToPlanarF32,
  createPlanarF32Frame,
} from "../../src/common/pcm-planar.js";

function summarizeStagedFrames(stagedFrames) {
  return stagedFrames.map((frame) => ({
    sampleCount: frame.sampleCount,
    pcm: Array.from(frame.pcm),
  }));
}

test("computeAtracEncodePadPlan preserves current pad and drop calculations", () => {
  assert.deepEqual(computeAtracEncodePadPlan(8, 12, 4), {
    alignedSampleCount: 8,
    padSamples: 0,
    dropInitialOutputFrames: 0,
  });

  assert.deepEqual(computeAtracEncodePadPlan(8, 20, 4), {
    alignedSampleCount: 16,
    padSamples: 0,
    dropInitialOutputFrames: 0,
  });

  assert.deepEqual(computeAtracEncodePadPlan(8, 5, 1), {
    alignedSampleCount: 4,
    padSamples: 4,
    dropInitialOutputFrames: 1,
  });

  assert.deepEqual(computeAtracEncodePadPlan(8, 0, 1), {
    alignedSampleCount: -1,
    padSamples: 1,
    dropInitialOutputFrames: 1,
  });
});

test("createAtracEncodeInputPlan normalizes negative alignment padding", () => {
  const result = createAtracEncodeInputPlan({
    pcmI16: Int16Array.from([1, 11, 2, 22, 3, 33, 4, 44]),
    channels: 2,
    frameSamples: 8,
    factParam: 0,
    encoderDelaySamples: 1,
  });

  assert.deepEqual(result, {
    totalSamples: 4,
    padSamples: 1,
    dropInitialOutputFrames: 1,
    framePlans: [
      {
        sampleCount: 8,
        sourceSampleOffset: 0,
        sourceSampleCount: 1,
        targetSampleOffset: 7,
      },
      {
        sampleCount: 3,
        sourceSampleOffset: 1,
        sourceSampleCount: 3,
        targetSampleOffset: 0,
      },
    ],
  });
});

test("createAtracEncodeInputPlan preserves leading-pad frame planning", () => {
  const result = createAtracEncodeInputPlan({
    pcmI16: Int16Array.from([1, 11, 2, 22, 3, 33, 4, 44, 5, 55]),
    channels: 2,
    frameSamples: 4,
    factParam: 2,
    encoderDelaySamples: 0,
  });

  assert.deepEqual(result, {
    totalSamples: 5,
    padSamples: 2,
    dropInitialOutputFrames: 1,
    framePlans: [
      {
        sampleCount: 4,
        sourceSampleOffset: 0,
        sourceSampleCount: 2,
        targetSampleOffset: 2,
      },
      {
        sampleCount: 3,
        sourceSampleOffset: 2,
        sourceSampleCount: 3,
        targetSampleOffset: 0,
      },
    ],
  });
});

test("createAtracEncodeInputPlan preserves contiguous planning without a leading pad", () => {
  const result = createAtracEncodeInputPlan({
    pcmI16: Int16Array.from([1, 11, 2, 22, 3, 33, 4, 44, 5, 55]),
    channels: 2,
    frameSamples: 4,
    factParam: 4,
    encoderDelaySamples: 0,
  });

  assert.deepEqual(result, {
    totalSamples: 5,
    padSamples: 0,
    dropInitialOutputFrames: 0,
    framePlans: [
      {
        sampleCount: 4,
        sourceSampleOffset: 0,
        sourceSampleCount: 4,
        targetSampleOffset: 0,
      },
      {
        sampleCount: 1,
        sourceSampleOffset: 4,
        sourceSampleCount: 1,
        targetSampleOffset: 0,
      },
    ],
  });
});

test("createAtracEncodeInputPlan preserves the empty-input leading pad behavior", () => {
  const result = createAtracEncodeInputPlan({
    pcmI16: new Int16Array(0),
    channels: 2,
    frameSamples: 4,
    factParam: 2,
    encoderDelaySamples: 0,
  });

  assert.deepEqual(result, {
    totalSamples: 0,
    padSamples: 2,
    dropInitialOutputFrames: 1,
    framePlans: [
      {
        sampleCount: 4,
        sourceSampleOffset: 0,
        sourceSampleCount: 0,
        targetSampleOffset: 2,
      },
    ],
  });
});

test("prepareAtracEncodePcmFrames inserts a leading padded frame when required", () => {
  const pcm = Int16Array.from([1, 11, 2, 22, 3, 33, 4, 44, 5, 55]);

  const result = prepareAtracEncodePcmFrames({
    pcmI16: pcm,
    channels: 2,
    frameSamples: 4,
    factParam: 2,
    encoderDelaySamples: 0,
  });

  assert.deepEqual(Object.keys(result).sort(), [
    "dropInitialOutputFrames",
    "padSamples",
    "stagedFrames",
  ]);
  assert.equal(result.padSamples, 2);
  assert.equal(result.dropInitialOutputFrames, 1);
  assert.deepEqual(summarizeStagedFrames(result.stagedFrames), [
    {
      sampleCount: 4,
      pcm: [0, 0, 0, 0, 1, 11, 2, 22],
    },
    {
      sampleCount: 3,
      pcm: [3, 33, 4, 44, 5, 55, 0, 0],
    },
  ]);
});

test("prepareAtracEncodePcmFrames rejects null options without crashing", () => {
  assert.throws(() => prepareAtracEncodePcmFrames(null), /invalid frameSamples/);
});

test("prepareAtracEncodePcmFrames preserves current empty-input leading pad behavior", () => {
  const result = prepareAtracEncodePcmFrames({
    pcmI16: new Int16Array(0),
    channels: 2,
    frameSamples: 4,
    factParam: 2,
    encoderDelaySamples: 0,
  });

  assert.deepEqual(Object.keys(result).sort(), [
    "dropInitialOutputFrames",
    "padSamples",
    "stagedFrames",
  ]);
  assert.equal(result.padSamples, 2);
  assert.equal(result.dropInitialOutputFrames, 1);
  assert.deepEqual(summarizeStagedFrames(result.stagedFrames), [
    {
      sampleCount: 4,
      pcm: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  ]);
});

test("splitInterleavedPcmFrames pads the last frame without changing sample order", () => {
  const pcm = Int16Array.from([1, 10, 2, 20, 3, 30, 4, 40, 5, 50]);

  const frames = splitInterleavedPcmFrames(pcm, 2, 3);

  assert.deepEqual(
    frames.map((frame) => Array.from(frame)),
    [
      [1, 10, 2, 20, 3, 30],
      [4, 40, 5, 50, 0, 0],
    ]
  );
});

test("splitInterleavedPcmFrames preserves the current empty-input contract", () => {
  const frames = splitInterleavedPcmFrames(new Int16Array(0), 2, 3);

  assert.deepEqual(frames, []);
});

test("createAtracEncodeInputPlan rejects invalid interleaved input lengths", () => {
  assert.throws(
    () =>
      createAtracEncodeInputPlan({
        pcmI16: Int16Array.from([1, 2, 3]),
        channels: 2,
        frameSamples: 4,
        factParam: 8,
        encoderDelaySamples: 0,
      }),
    /PCM sample length 3 is not divisible by channel count 2/
  );
});

test("stageInterleavedPcmFrames preserves sample counts when starting mid-stream", () => {
  const pcm = Int16Array.from([1, 10, 2, 20, 3, 30, 4, 40, 5, 50]);
  const stagedFrames = stageInterleavedPcmFrames(pcm, 2, 3, 2);

  assert.deepEqual(summarizeStagedFrames(stagedFrames), [
    {
      sampleCount: 3,
      pcm: [3, 30, 4, 40, 5, 50],
    },
  ]);
});

test("stageInterleavedPcmFramePlans preserves authored target offsets and sample counts", () => {
  const pcm = Int16Array.from([1, 10, 2, 20, 3, 30, 4, 40, 5, 50]);
  const stagedFrames = stageInterleavedPcmFramePlans(pcm, 2, 4, [
    {
      sampleCount: 4,
      sourceSampleOffset: 0,
      sourceSampleCount: 2,
      targetSampleOffset: 2,
    },
    {
      sampleCount: 3,
      sourceSampleOffset: 2,
      sourceSampleCount: 3,
      targetSampleOffset: 0,
    },
  ]);

  assert.deepEqual(summarizeStagedFrames(stagedFrames), [
    {
      sampleCount: 4,
      pcm: [0, 0, 0, 0, 1, 10, 2, 20],
    },
    {
      sampleCount: 3,
      pcm: [3, 30, 4, 40, 5, 50, 0, 0],
    },
  ]);
});

test("collectAtracEncodeFrames preserves staged PCM copying and delayed output dropping", () => {
  const scratch = createPlanarF32Frame(2, 4);
  const runtime = { frameIndex: 0 };
  const encodedCalls = [];

  const { totalSamples, frameCollector } = collectAtracEncodeFrames(
    Int16Array.from([1, 11, 2, 22, 3, 33, 4, 44, 5, 55, 6, 66, 7, 77, 8, 88, 9, 99, 10, 110]),
    {
      channels: 2,
      profile: {
        codec: "atrac3",
        frameSamples: 4,
        encoderDelaySamples: 2,
        factBaseDelaySamples: 0,
        factValueDelaySamples: 0,
      },
      runtime,
      planarScratch: scratch,
      encodeFrame(sampleCount) {
        const snapshot = [sampleCount, ...Array.from(scratch[0], Math.trunc)];
        encodedCalls.push(snapshot);
        return Uint8Array.from(snapshot);
      },
    }
  );

  assert.equal(totalSamples, 10);
  assert.equal(runtime.frameIndex, 3);
  assert.deepEqual(encodedCalls, [
    [4, 0, 0, 1, 2],
    [4, 3, 4, 5, 6],
    [4, 7, 8, 9, 10],
  ]);
  assert.deepEqual(
    frameCollector.encodedFrames.map((frame) => Array.from(frame)),
    [[4, 7, 8, 9, 10]]
  );
});

test("collectAtracEncodeFrames preserves the empty delayed leading frame", () => {
  const scratch = createPlanarF32Frame(2, 4);
  const runtime = { frameIndex: 0 };
  const encodedCalls = [];

  const { totalSamples, frameCollector } = collectAtracEncodeFrames(new Int16Array(0), {
    channels: 2,
    profile: {
      codec: "atrac3",
      frameSamples: 4,
      encoderDelaySamples: 2,
      factBaseDelaySamples: 0,
      factValueDelaySamples: 0,
    },
    runtime,
    planarScratch: scratch,
    encodeFrame(sampleCount) {
      const snapshot = [sampleCount, ...Array.from(scratch[0], Math.trunc)];
      encodedCalls.push(snapshot);
      return Uint8Array.from(snapshot);
    },
  });

  assert.equal(totalSamples, 0);
  assert.equal(runtime.frameIndex, 1);
  assert.deepEqual(encodedCalls, [[4, 0, 0, 0, 0]]);
  assert.deepEqual(frameCollector.encodedFrames, []);
});

test("collectAtracEncodeFrames rejects invalid planar scratch", () => {
  assert.throws(
    () =>
      collectAtracEncodeFrames(new Int16Array(0), {
        channels: 2,
        profile: {
          codec: "atrac3",
          frameSamples: 4,
          encoderDelaySamples: 0,
          factBaseDelaySamples: 0,
          factValueDelaySamples: 0,
        },
        runtime: { frameIndex: 0 },
        planarScratch: null,
        encodeFrame() {
          return new Uint8Array(0);
        },
      }),
    /planarScratch must provide planar Float32Array channel buffers/
  );
});

test("createAtracEncodeFrameCollector preserves current delayed-output frame dropping", () => {
  const runtime = { frameIndex: 0 };
  const collector = createAtracEncodeFrameCollector(runtime, 1);

  assert.equal(collector.collect(Uint8Array.of(1, 2)), false);
  assert.equal(collector.collect(Uint8Array.of(3, 4), true), false);
  assert.equal(collector.collect(Uint8Array.of(5, 6), true), true);
  assert.equal(collector.collect(Uint8Array.of(7, 8)), true);

  assert.equal(runtime.frameIndex, 4);
  assert.deepEqual(
    collector.encodedFrames.map((frame) => Array.from(frame)),
    [
      [5, 6],
      [7, 8],
    ]
  );
});

test("createAtracEncodeFrameCollector preserves resumed-runtime output collection", () => {
  const runtime = { frameIndex: 3 };
  const collector = createAtracEncodeFrameCollector(runtime, 0);

  assert.equal(collector.collect(Uint8Array.of(9, 10)), true);
  assert.equal(runtime.frameIndex, 4);
  assert.deepEqual(
    collector.encodedFrames.map((frame) => Array.from(frame)),
    [[9, 10]]
  );
});

test("createAtracEncodeFrameCollector rejects invalid runtime and drop counts", () => {
  assert.throws(
    () => createAtracEncodeFrameCollector(null, 0),
    /runtime must expose an integer frameIndex/
  );
  assert.throws(
    () => createAtracEncodeFrameCollector({ frameIndex: 0.5 }, 0),
    /runtime must expose an integer frameIndex/
  );
  assert.throws(
    () => createAtracEncodeFrameCollector({ frameIndex: 0 }, -1),
    /invalid dropInitialOutputFrames: -1/
  );
});

test("copyInterleavedPcmToPlanarF32 preserves padded first-frame sample counts", () => {
  const prepared = prepareAtracEncodePcmFrames({
    pcmI16: Int16Array.from([1, 11, 2, 22, 3, 33, 4, 44, 5, 55]),
    channels: 2,
    frameSamples: 4,
    factParam: 2,
    encoderDelaySamples: 0,
  });
  const scratch = createPlanarF32Frame(2, 4);

  copyInterleavedPcmToPlanarF32(prepared.stagedFrames[0].pcm, 2, 4, {
    scratch,
    packedSampleCount: prepared.stagedFrames[0].sampleCount * 2,
  });
  const firstPlanar = scratch.map((channel) => Array.from(channel));
  copyInterleavedPcmToPlanarF32(prepared.stagedFrames[1].pcm, 2, 4, {
    scratch,
    packedSampleCount: prepared.stagedFrames[1].sampleCount * 2,
  });
  const secondPlanar = scratch.map((channel) => Array.from(channel));

  assert.deepEqual(firstPlanar, [
    [0, 0, 1, 2],
    [0, 0, 11, 22],
  ]);
  assert.deepEqual(secondPlanar, [
    [3, 4, 5, 0],
    [33, 44, 55, 0],
  ]);
});

test("ATRAC encode PCM helpers reject invalid interleaved input lengths", () => {
  const pcm = Int16Array.from([1, 2, 3]);

  assert.throws(
    () =>
      prepareAtracEncodePcmFrames({
        pcmI16: pcm,
        channels: 2,
        frameSamples: 4,
        factParam: 8,
        encoderDelaySamples: 0,
      }),
    /PCM sample length 3 is not divisible by channel count 2/
  );
  assert.throws(
    () => splitInterleavedPcmFrames(pcm, 2, 4),
    /PCM sample length 3 is not divisible by channel count 2/
  );
  assert.throws(
    () => stageInterleavedPcmFrames(new Int16Array(4), 2, 4, 3),
    /invalid startSampleOffset: 3/
  );
  assert.throws(
    () => stageInterleavedPcmFramePlans(new Int16Array(4), 2, 4, null),
    /framePlans must be an array/
  );
});
