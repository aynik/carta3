import assert from "node:assert/strict";
import test from "node:test";

import { parseAtracWavBuffer, parseFactChunk, parseWavChunks } from "../../src/container/index.js";
import {
  encodeAtracFramesFromInterleavedPcm,
  encodeAtracWavBufferFromInterleavedPcm,
} from "../../src/encoders/atrac.js";
import { resolveAtracEncodeFactPlan } from "../../src/encoders/fact.js";
import { encodeAtrac3ScxFramesFromInterleavedPcm } from "../../src/encoders/atrac3-scx.js";
import { encodeAtrac3FramesFromInterleavedPcm } from "../../src/encoders/atrac3.js";
import { encodeAtrac3plusFramesFromInterleavedPcm } from "../../src/encoders/atrac3plus.js";

function createPcm(sampleCount) {
  return Int16Array.from({ length: sampleCount }, (_, index) => ((index * 37) % 200) - 100);
}

test("ATRAC dispatcher treats null options as default options", () => {
  const pcm = createPcm(32);
  const result = encodeAtracFramesFromInterleavedPcm(pcm, null);

  assert.equal(result.totalSamples, 16);
  assert.ok(result.profile && typeof result.profile === "object");
});

test("ATRAC dispatcher rejects an explicit codec that does not match the selected profile", () => {
  assert.throws(
    () =>
      encodeAtracFramesFromInterleavedPcm(createPcm(32), {
        codec: "atrac3plus",
        bitrateKbps: 66,
        channels: 2,
        sampleRate: 44100,
      }),
    /requested codec=atrac3plus does not match selected profile codec=atrac3/
  );
});

test("ATRAC dispatcher rejects unsupported channel counts", () => {
  assert.throws(
    () =>
      encodeAtracFramesFromInterleavedPcm(createPcm(32), {
        bitrateKbps: 66,
        channels: 1,
        sampleRate: 44100,
      }),
    /unsupported ATRAC encode profile/
  );
});

test("ATRAC dispatcher routes ATRAC3 algorithm 0, SCX, and ATRAC3plus to the direct encoders", () => {
  const pcm = createPcm(32);

  const atrac3 = encodeAtracFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const atrac3Direct = encodeAtrac3FramesFromInterleavedPcm(pcm, {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });

  const scx = encodeAtracFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 132,
    channels: 2,
    sampleRate: 44100,
  });
  const scxDirect = encodeAtrac3ScxFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 132,
    channels: 2,
    sampleRate: 44100,
  });

  const atrac3plus = encodeAtracFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const atrac3plusDirect = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });

  assert.deepEqual(atrac3.profile, atrac3Direct.profile);
  assert.deepEqual(atrac3.encodedFrames, atrac3Direct.encodedFrames);
  assert.equal(atrac3.totalSamples, atrac3Direct.totalSamples);

  assert.deepEqual(scx.profile, scxDirect.profile);
  assert.deepEqual(scx.encodedFrames, scxDirect.encodedFrames);
  assert.equal(scx.totalSamples, scxDirect.totalSamples);

  assert.deepEqual(atrac3plus.profile, atrac3plusDirect.profile);
  assert.deepEqual(atrac3plus.encodedFrames, atrac3plusDirect.encodedFrames);
  assert.equal(atrac3plus.totalSamples, atrac3plusDirect.totalSamples);
});

test("ATRAC dispatcher preserves ATRAC3plus-specific encode options while routing", () => {
  const pcm = new Int16Array(2048 * 4);

  const dispatched = encodeAtracFramesFromInterleavedPcm(pcm, {
    codec: "atrac3plus",
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    encodeMode: 0,
    useExactQuant: false,
    maxOutputFrames: 1,
    collectDebug: true,
  });
  const direct = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    encodeMode: 0,
    useExactQuant: false,
    maxOutputFrames: 1,
    collectDebug: true,
  });

  assert.deepEqual(dispatched.profile, direct.profile);
  assert.deepEqual(dispatched.encodedFrames, direct.encodedFrames);
  assert.equal(dispatched.totalSamples, direct.totalSamples);
  assert.deepEqual(dispatched.debug, direct.debug);
  assert.equal(dispatched.context.frameIndex, direct.context.frameIndex);
});

test("ATRAC dispatcher preserves current routed context reuse behavior", () => {
  const atrac3 = encodeAtracFramesFromInterleavedPcm(new Int16Array(1024 * 2), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const atrac3FrameIndex = atrac3.context.frameIndex;
  const atrac3Resumed = encodeAtracFramesFromInterleavedPcm(new Int16Array(1024 * 2), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    context: atrac3.context,
  });

  assert.deepEqual(
    {
      firstFrames: atrac3.encodedFrames.length,
      firstFrameIndex: atrac3FrameIndex,
      secondFrames: atrac3Resumed.encodedFrames.length,
      secondFrameIndex: atrac3Resumed.context.frameIndex,
      sameContext: atrac3Resumed.context === atrac3.context,
    },
    {
      firstFrames: 3,
      firstFrameIndex: 5,
      secondFrames: 4,
      secondFrameIndex: 10,
      sameContext: true,
    }
  );

  const atrac3plus = encodeAtracFramesFromInterleavedPcm(new Int16Array(2048 * 2), {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const atrac3plusFrameIndex = atrac3plus.context.frameIndex;
  const atrac3plusResumed = encodeAtracFramesFromInterleavedPcm(new Int16Array(2048 * 2), {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    context: atrac3plus.context,
  });

  assert.deepEqual(
    {
      firstFrames: atrac3plus.encodedFrames.length,
      firstFrameIndex: atrac3plusFrameIndex,
      secondFrames: atrac3plusResumed.encodedFrames.length,
      secondFrameIndex: atrac3plusResumed.context.frameIndex,
      sameContext: atrac3plusResumed.context === atrac3plus.context,
    },
    {
      firstFrames: 3,
      firstFrameIndex: 10,
      secondFrames: 10,
      secondFrameIndex: 20,
      sameContext: true,
    }
  );
});

test("ATRAC dispatcher preserves current routed SCX raw-context normalization", () => {
  const first = encodeAtracFramesFromInterleavedPcm(new Int16Array(2048 * 2), {
    bitrateKbps: 132,
    channels: 2,
    sampleRate: 44100,
  });
  const resumed = encodeAtracFramesFromInterleavedPcm(new Int16Array(2048 * 2), {
    bitrateKbps: 132,
    channels: 2,
    sampleRate: 44100,
    context: first.context.encoderContext,
  });

  assert.deepEqual(
    {
      frames: resumed.encodedFrames.length,
      frameIndex: resumed.context.frameIndex,
      flushComplete: resumed.context.flushComplete,
      sameEncoderContext: resumed.context.encoderContext === first.context.encoderContext,
    },
    {
      frames: 4,
      frameIndex: 6,
      flushComplete: true,
      sameEncoderContext: true,
    }
  );
});

test("ATRAC WAV wrapper returns a parsable container for the dispatched output", () => {
  const pcm = createPcm(32);
  const encoded = encodeAtracWavBufferFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const parsed = parseAtracWavBuffer(encoded.buffer);

  assert.equal(parsed.codec, encoded.profile.codec);
  assert.equal(parsed.frameBytes, encoded.profile.frameBytes);
  assert.equal(parsed.frameCount, encoded.encodedFrames.length);
});

test("ATRAC WAV wrapper forwards loopEnd into FACT alignment metadata", () => {
  const pcm = new Int16Array(2048 * 2);
  const loopEnd = 511;
  const encoded = encodeAtracWavBufferFromInterleavedPcm(pcm, {
    codec: "atrac3plus",
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    loopEnd,
  });
  const parsed = parseAtracWavBuffer(encoded.buffer);
  const expectedFact = resolveAtracEncodeFactPlan(encoded.profile, loopEnd);

  assert.equal(parsed.factRaw[1], expectedFact.alignedSampleCount);
  assert.equal(parsed.factRaw[2], expectedFact.factParam);
});

test("ATRAC WAV wrapper forwards loopStart and factMode into smpl and fact chunks", () => {
  const pcm = new Int16Array(2048 * 2);
  const loopStart = 10;
  const loopEnd = 511;
  const factMode = 0;
  const encoded = encodeAtracWavBufferFromInterleavedPcm(pcm, {
    codec: "atrac3plus",
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    loopStart,
    loopEnd,
    factMode,
  });
  const chunks = parseWavChunks(encoded.buffer);
  const factChunk = chunks.find((chunk) => chunk.id === "fact")?.body ?? null;
  const smplChunk = chunks.find((chunk) => chunk.id === "smpl")?.body ?? null;
  assert.ok(factChunk);
  assert.ok(smplChunk);

  const expectedFact = resolveAtracEncodeFactPlan(encoded.profile, loopEnd);
  assert.deepEqual(parseFactChunk(factChunk).raw, [
    encoded.totalSamples,
    expectedFact.alignedSampleCount,
  ]);

  const smplView = new DataView(smplChunk.buffer, smplChunk.byteOffset, smplChunk.byteLength);
  assert.equal(smplView.getUint32(44, true), loopStart + expectedFact.alignedSampleCount);
  assert.equal(smplView.getUint32(48, true), loopEnd + expectedFact.alignedSampleCount);
});

test("ATRAC3plus encoder output changes when loopEnd alignment is requested", () => {
  const pcm = createPcm(2048 * 2 * 4);
  const baseOptions = {
    codec: "atrac3plus",
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  };

  const noLoop = encodeAtracFramesFromInterleavedPcm(pcm, baseOptions);
  const loopAligned = encodeAtracFramesFromInterleavedPcm(pcm, {
    ...baseOptions,
    loopEnd: 511,
  });

  assert.notDeepEqual(loopAligned.encodedFrames, noLoop.encodedFrames);
});

test("ATRAC WAV wrapper preserves ATRAC3plus debug routing and result shape", () => {
  const pcm = new Int16Array(2048 * 4);
  const options = {
    codec: "atrac3plus",
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    encodeMode: 0,
    useExactQuant: false,
    maxOutputFrames: 1,
    collectDebug: true,
  };

  const encoded = encodeAtracWavBufferFromInterleavedPcm(pcm, options);
  const direct = encodeAtracFramesFromInterleavedPcm(pcm, options);
  const parsed = parseAtracWavBuffer(encoded.buffer);

  assert.deepEqual(Object.keys(encoded).sort(), [
    "buffer",
    "context",
    "debug",
    "encodedFrames",
    "profile",
    "totalSamples",
  ]);
  assert.deepEqual(encoded.profile, direct.profile);
  assert.deepEqual(encoded.encodedFrames, direct.encodedFrames);
  assert.equal(encoded.totalSamples, direct.totalSamples);
  assert.deepEqual(encoded.debug, direct.debug);
  assert.equal(encoded.context.frameIndex, direct.context.frameIndex);
  assert.equal(parsed.frameCount, encoded.encodedFrames.length);
});

test("ATRAC WAV wrapper preserves current SCX container sizing", () => {
  const encoded = encodeAtracWavBufferFromInterleavedPcm(new Int16Array(2048 * 2), {
    bitrateKbps: 132,
    channels: 2,
    sampleRate: 44100,
  });
  const parsed = parseAtracWavBuffer(encoded.buffer);

  assert.equal(encoded.encodedFrames.length, 4);
  assert.equal(encoded.buffer.length, 1616);
  assert.equal(parsed.codec, "atrac3");
  assert.equal(parsed.frameCount, 4);
});
