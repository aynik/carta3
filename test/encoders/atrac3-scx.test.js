import assert from "node:assert/strict";
import test from "node:test";

import { createAtrac3ScxEncoderContext } from "../../src/atrac3/scx/index.js";
import { parseFactChunk, parseWavChunks } from "../../src/container/index.js";
import { createPlanarF32Frame } from "../../src/common/pcm-planar.js";
import {
  encodeAtrac3ScxFramesFromInterleavedPcm,
  encodeAtrac3ScxWavBufferFromInterleavedPcm,
} from "../../src/encoders/atrac3-scx.js";
import { resolveAtracEncodeFactPlan } from "../../src/encoders/fact.js";

test("encodeAtrac3ScxFramesFromInterleavedPcm treats null options as defaults", () => {
  const pcm = new Int16Array(2048 * 2);
  const result = encodeAtrac3ScxFramesFromInterleavedPcm(pcm, null);

  assert.equal(result.profile.bitrateKbps, 132);
  assert.equal(result.encodedFrames.length, 4);
});

test("encodeAtrac3ScxFramesFromInterleavedPcm preserves current zero-PCM output", () => {
  const pcm = new Int16Array(2048 * 2);
  const result = encodeAtrac3ScxFramesFromInterleavedPcm(pcm);

  assert.deepEqual(
    {
      codec: result.profile.codec,
      encodeVariant: result.profile.encodeVariant,
      bitrateKbps: result.profile.bitrateKbps,
      frameBytes: result.profile.frameBytes,
      frameSamples: result.profile.frameSamples,
      totalSamples: result.totalSamples,
      encodedFrameCount: result.encodedFrames.length,
      firstFrameLen: result.encodedFrames[0]?.length ?? 0,
      contextKeys: Object.keys(result.context).sort(),
      hasPlanarScratch: Object.hasOwn(result.context, "planarScratch"),
      frameIndex: result.context.frameIndex,
      flushComplete: result.context.flushComplete,
    },
    {
      codec: "atrac3",
      encodeVariant: "atrac3-scx",
      bitrateKbps: 132,
      frameBytes: 384,
      frameSamples: 1024,
      totalSamples: 2048,
      encodedFrameCount: 4,
      firstFrameLen: 384,
      contextKeys: ["encoderContext", "flushComplete", "frameIndex", "planarScratch"],
      hasPlanarScratch: true,
      frameIndex: 6,
      flushComplete: true,
    }
  );
});

test("ATRAC3 SCX wrapper accepts a complete runtime context", () => {
  const pcm = new Int16Array(2048 * 2);
  const runtime = {
    encoderContext: createAtrac3ScxEncoderContext(),
    frameIndex: 0,
    flushComplete: false,
    planarScratch: createPlanarF32Frame(2, 1024),
  };

  const result = encodeAtrac3ScxFramesFromInterleavedPcm(pcm, { context: runtime });

  assert.equal(result.encodedFrames.length, 4);
  assert.equal(result.context, runtime);
  assert.equal(result.context.frameIndex, 6);
  assert.equal(result.context.flushComplete, true);
});

test("ATRAC3 SCX wrapper repairs undersized wrapper scratch", () => {
  const pcm = new Int16Array(2048 * 2);
  const runtime = {
    encoderContext: createAtrac3ScxEncoderContext(),
    frameIndex: 0,
    flushComplete: false,
    planarScratch: [new Float32Array(1), new Float32Array(1)],
  };

  const result = encodeAtrac3ScxFramesFromInterleavedPcm(pcm, { context: runtime });

  assert.equal(result.encodedFrames.length, 4);
  assert.equal(result.context, runtime);
  assert.deepEqual(
    result.context.planarScratch.map((channel) => channel.length),
    [1024, 1024]
  );
});

test("ATRAC3 SCX wrapper preserves current context reuse and WAV packaging", () => {
  const pcm = new Int16Array(2048 * 2);
  const first = encodeAtrac3ScxFramesFromInterleavedPcm(pcm);
  const second = encodeAtrac3ScxFramesFromInterleavedPcm(pcm, { context: first.context });
  const wav = encodeAtrac3ScxWavBufferFromInterleavedPcm(pcm);

  assert.deepEqual(
    {
      firstFrames: first.encodedFrames.length,
      secondFrames: second.encodedFrames.length,
      secondFrameIndex: second.context.frameIndex,
      secondFlushComplete: second.context.flushComplete,
      sameEncoderContext: first.context.encoderContext === second.context.encoderContext,
      wavFrames: wav.encodedFrames.length,
      wavBufferLen: wav.buffer.length,
    },
    {
      firstFrames: 4,
      secondFrames: 2,
      secondFrameIndex: 9,
      secondFlushComplete: true,
      sameEncoderContext: true,
      wavFrames: 4,
      wavBufferLen: 1616,
    }
  );
});

test("ATRAC3 SCX WAV wrapper forwards loopStart and factMode into smpl and fact chunks", () => {
  const pcm = new Int16Array(2048 * 2);
  const loopStart = 10;
  const loopEnd = 511;
  const factMode = 0;
  const wav = encodeAtrac3ScxWavBufferFromInterleavedPcm(pcm, { loopStart, loopEnd, factMode });

  const chunks = parseWavChunks(wav.buffer);
  const factChunk = chunks.find((chunk) => chunk.id === "fact")?.body ?? null;
  const smplChunk = chunks.find((chunk) => chunk.id === "smpl")?.body ?? null;
  assert.ok(factChunk);
  assert.ok(smplChunk);

  const expectedFact = resolveAtracEncodeFactPlan(wav.profile, loopEnd);
  assert.deepEqual(parseFactChunk(factChunk).raw, [
    wav.totalSamples,
    expectedFact.alignedSampleCount,
  ]);

  const smplView = new DataView(smplChunk.buffer, smplChunk.byteOffset, smplChunk.byteLength);
  assert.equal(smplView.getUint32(44, true), loopStart + expectedFact.alignedSampleCount);
  assert.equal(smplView.getUint32(48, true), loopEnd + expectedFact.alignedSampleCount);
});

test("ATRAC3 SCX wrapper preserves current raw context normalization", () => {
  const pcm = new Int16Array(2048 * 2);
  const first = encodeAtrac3ScxFramesFromInterleavedPcm(pcm);
  const resumed = encodeAtrac3ScxFramesFromInterleavedPcm(pcm, {
    context: first.context.encoderContext,
  });

  assert.deepEqual(
    {
      frames: resumed.encodedFrames.length,
      frameIndex: resumed.context.frameIndex,
      flushComplete: resumed.context.flushComplete,
      contextKeys: Object.keys(resumed.context).sort(),
      sameEncoderContext: resumed.context.encoderContext === first.context.encoderContext,
    },
    {
      frames: 4,
      frameIndex: 6,
      flushComplete: true,
      contextKeys: ["encoderContext", "flushComplete", "frameIndex", "planarScratch"],
      sameEncoderContext: true,
    }
  );
});

test("ATRAC3 SCX wrapper ignores incomplete raw context stubs", () => {
  const pcm = new Int16Array(2048 * 2);
  const stubContext = {
    frameBytes: 384,
    pcmLenHistory: new Int32Array([1024, 1024, 1024]),
    state: { channelCount: 2, channelHistories: [], channelScratch: [] },
  };
  const result = encodeAtrac3ScxFramesFromInterleavedPcm(pcm, { context: stubContext });

  assert.equal(result.encodedFrames.length, 4);
  assert.equal(result.context.frameIndex, 6);
  assert.equal(result.context.flushComplete, true);
  assert.notEqual(result.context.encoderContext, stubContext);
});

test("ATRAC3 SCX wrapper preserves current validation and profile restrictions", () => {
  assert.throws(
    () => encodeAtrac3ScxFramesFromInterleavedPcm(new Int16Array(3), { channels: 2 }),
    /PCM sample length 3 is not divisible by channel count 2/
  );
  assert.throws(
    () => encodeAtrac3ScxFramesFromInterleavedPcm(new Int16Array(2048 * 2), { bitrateKbps: 128 }),
    /ATRAC3 SCX encoder currently supports only 132 kbps 2ch @ 44100Hz/
  );
});

test("encodeAtrac3ScxFramesFromInterleavedPcm preserves current empty-input flush output", () => {
  const result = encodeAtrac3ScxFramesFromInterleavedPcm(new Int16Array(0));

  assert.deepEqual(
    {
      totalSamples: result.totalSamples,
      frames: result.encodedFrames.length,
      frameIndex: result.context.frameIndex,
      flushComplete: result.context.flushComplete,
      frameLengths: result.encodedFrames.map((frame) => frame.length),
    },
    {
      totalSamples: 0,
      frames: 3,
      frameIndex: 4,
      flushComplete: true,
      frameLengths: [384, 384, 384],
    }
  );
});
