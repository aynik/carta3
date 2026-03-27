import assert from "node:assert/strict";
import test from "node:test";

import { createAtrac3EncoderState } from "../../src/atrac3/encode-runtime.js";
import { createPlanarF32Frame } from "../../src/common/pcm-planar.js";
import { parseAtracWavBuffer } from "../../src/container/index.js";
import { resolveAtracEncodeFactPlan } from "../../src/encoders/fact.js";
import {
  encodeAtrac3FramesFromInterleavedPcm,
  encodeAtrac3WavBufferFromInterleavedPcm,
} from "../../src/encoders/atrac3.js";

function assertEncodedFrames(frames, frameBytes) {
  assert.ok(Array.isArray(frames));
  for (const frame of frames) {
    assert.ok(frame instanceof Uint8Array);
    assert.equal(frame.length, frameBytes);
  }
}

test("encodeAtrac3FramesFromInterleavedPcm reuses runtime contexts", () => {
  const pcm = new Int16Array(1024 * 2);

  const result = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  assert.equal(result.totalSamples, 1024);
  assert.ok(result.encodedFrames.length > 0);
  assert.equal(result.profile.encodeVariant, "atrac3-algorithm0");
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.deepEqual(Object.keys(result.context).sort(), [
    "encoderState",
    "frameIndex",
    "planarScratch",
  ]);
  assert.ok(Array.isArray(result.context.planarScratch));
  assert.ok(Array.isArray(result.context.encoderState?.layers));
  assert.ok(!!result.context.encoderState?.primaryLayer);
  assert.ok(!!result.context.encoderState?.secondaryLayer);

  const previousFrameIndex = result.context.frameIndex;
  const resumed = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: result.context,
  });
  assert.ok(resumed.encodedFrames.length > 0);
  assertEncodedFrames(resumed.encodedFrames, resumed.profile.frameBytes);
  assert.ok(resumed.context.frameIndex > previousFrameIndex);
  assert.equal(resumed.context, result.context);
});

test("ATRAC3 transform caches lane weights in layer workspace", () => {
  const pcm = new Int16Array(1024 * 2);

  const first = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });

  const { encoderState } = first.context;
  const primaryWorkspace = encoderState.primaryLayer.workspace;
  const secondaryWorkspace = encoderState.secondaryLayer.workspace;
  assert.ok(primaryWorkspace.laneWeights instanceof Float32Array);
  assert.ok(secondaryWorkspace.laneWeights instanceof Float32Array);

  const primaryLaneWeights = primaryWorkspace.laneWeights;
  const secondaryLaneWeights = secondaryWorkspace.laneWeights;

  const resumed = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: first.context,
  });

  assert.equal(resumed.context.encoderState.primaryLayer.workspace.laneWeights, primaryLaneWeights);
  assert.equal(
    resumed.context.encoderState.secondaryLayer.workspace.laneWeights,
    secondaryLaneWeights
  );
});

test("encodeAtrac3FramesFromInterleavedPcm rejects mismatched runtime settings", () => {
  const pcm = new Int16Array(1024 * 2);
  const first = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });

  assert.throws(
    () =>
      encodeAtrac3FramesFromInterleavedPcm(pcm, {
        bitrateKbps: 105,
        channels: 2,
        sampleRate: 44100,
        context: first.context,
      }),
    /ATRAC3 encode context mismatch/
  );
});

test("encodeAtrac3FramesFromInterleavedPcm accepts a complete wrapper runtime", () => {
  const pcm = new Int16Array(1024 * 2);
  const runtime = {
    encoderState: createAtrac3EncoderState(2, 66).state,
    frameIndex: 0,
    planarScratch: createPlanarF32Frame(2, 1024),
  };

  const result = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: runtime,
  });

  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.equal(result.context, runtime);
  assert.ok(result.context.frameIndex > 0);
});

test("encodeAtrac3FramesFromInterleavedPcm repairs undersized wrapper scratch", () => {
  const pcm = new Int16Array(1024 * 2);
  const runtime = {
    encoderState: createAtrac3EncoderState(2, 66).state,
    frameIndex: 0,
    planarScratch: [new Float32Array(1), new Float32Array(1)],
  };

  const result = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: runtime,
  });

  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.equal(result.context, runtime);
  assert.deepEqual(
    result.context.planarScratch.map((channel) => channel.length),
    [1024, 1024]
  );
});

test("encodeAtrac3FramesFromInterleavedPcm ignores incomplete runtime stubs", () => {
  const pcm = new Int16Array(1024 * 2);
  const stubRuntime = {
    encoderState: {
      bytesPerLayer: 96,
      primaryLayer: {},
      secondaryLayer: {},
    },
    frameIndex: 0,
  };

  const result = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: stubRuntime,
  });

  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.ok(result.context.frameIndex > 0);
  assert.notEqual(result.context, stubRuntime);
});

test("encodeAtrac3FramesFromInterleavedPcm ignores shallow-authored encoder state stubs", () => {
  const pcm = new Int16Array(1024 * 2);
  const primaryLayer = {};
  const secondaryLayer = {};
  const stubRuntime = {
    encoderState: {
      bytesPerLayer: 96,
      basePrimaryShift: 0,
      primaryShiftTarget: 0,
      secondaryUsesSwappedTailTransport: true,
      usesDbaStereoRebalance: false,
      channelConversion: null,
      primaryLayer,
      secondaryLayer,
      layers: [primaryLayer, secondaryLayer],
      procWords: new Uint32Array(6613),
      scratch: {
        fft: new Float32Array(1024),
        qmfCurve: new Float32Array(1),
      },
    },
    frameIndex: 0,
  };

  const result = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: stubRuntime,
  });

  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.ok(result.context.frameIndex > 0);
  assert.notEqual(result.context, stubRuntime);
});

test("encodeAtrac3FramesFromInterleavedPcm accepts a bare encoder state context", () => {
  const pcm = new Int16Array(1024 * 2);
  const encoderState = createAtrac3EncoderState(2, 66).state;

  const result = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: encoderState,
  });

  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.equal(result.context.encoderState, encoderState);
  assert.ok(result.context.frameIndex > 0);
  assert.deepEqual(Object.keys(result.context).sort(), [
    "encoderState",
    "frameIndex",
    "planarScratch",
  ]);
  assert.notEqual(result.context, encoderState);
});

test("encodeAtrac3FramesFromInterleavedPcm preserves current validation errors", () => {
  assert.throws(
    () => encodeAtrac3FramesFromInterleavedPcm(new Int16Array(3), { channels: 2 }),
    /PCM sample length 3 is not divisible by channel count 2/
  );
  assert.throws(
    () =>
      encodeAtrac3FramesFromInterleavedPcm(new Int16Array(4), {
        bitrateKbps: 132,
        channels: 2,
        sampleRate: 44100,
      }),
    /ATRAC3 encoder \(algorithm 0\) currently supports only 66, 105 kbps 2ch @ 44100Hz/
  );
  assert.throws(
    () =>
      encodeAtrac3FramesFromInterleavedPcm(new Int16Array(1024 * 2), {
        bitrateKbps: 66,
        channels: 2,
        sampleRate: 44100,
        loopEnd: 1024,
      }),
    /loopEnd 1024 must be < totalSamples 1024/
  );
});

test("encodeAtrac3FramesFromInterleavedPcm flushes even for empty input", () => {
  const result = encodeAtrac3FramesFromInterleavedPcm(new Int16Array(0), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });

  assert.equal(result.totalSamples, 0);
  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.ok(result.context.frameIndex >= 0);
});

test("encodeAtrac3WavBufferFromInterleavedPcm packages encoded frames into a WAV container", () => {
  const pcm = new Int16Array(1024 * 2);
  const result = encodeAtrac3WavBufferFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const parsed = parseAtracWavBuffer(result.buffer);

  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.equal(parsed.frameCount, result.encodedFrames.length);
  assert.equal(parsed.codec, "atrac3");
  assert.equal(parsed.frameBytes, result.profile.frameBytes);
});

test("encodeAtrac3WavBufferFromInterleavedPcm forwards loopEnd into FACT alignment metadata", () => {
  const pcm = new Int16Array(1024 * 2);
  const loopEnd = 511;
  const result = encodeAtrac3WavBufferFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    loopEnd,
  });
  const parsed = parseAtracWavBuffer(result.buffer);
  const expectedFact = resolveAtracEncodeFactPlan(result.profile, loopEnd);

  assert.equal(parsed.factRaw[1], expectedFact.alignedSampleCount);
  assert.equal(parsed.factRaw[2], expectedFact.factParam);
});
