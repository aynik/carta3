import assert from "node:assert/strict";
import test from "node:test";

import { selectAtrac3plusEncodeProfile } from "../../src/atrac3plus/profiles.js";
import {
  analyzeAtrac3plusFramesFromInterleavedPcm,
  encodeAtrac3plusFramesFromInterleavedPcm,
} from "../../src/encoders/atrac3plus.js";

function assertEncodedFrames(frames, frameBytes) {
  assert.ok(Array.isArray(frames));
  for (const frame of frames) {
    assert.ok(frame instanceof Uint8Array);
    assert.equal(frame.length, frameBytes);
  }
}

test("encodeAtrac3plusFramesFromInterleavedPcm reuses runtime contexts", () => {
  const pcm = new Int16Array(2048 * 2);

  const result = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    encodeMode: 0,
  });
  assert.equal(result.totalSamples, 2048);
  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.equal(result.context.handle.flushFramesRemaining, 0);
  assert.equal(result.context.handle.delayFramesRemaining, 0);
  assert.ok(Array.isArray(result.context.planarScratch));
  assert.ok(Array.isArray(result.context.zeroPlanar));

  const previousFrameIndex = result.context.frameIndex;
  const resumed = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    encodeMode: 0,
    context: result.context,
  });
  assert.equal(resumed.totalSamples, 2048);
  assert.ok(resumed.encodedFrames.length > 0);
  assertEncodedFrames(resumed.encodedFrames, resumed.profile.frameBytes);
  assert.ok(resumed.context.frameIndex > previousFrameIndex);
  assert.equal(resumed.context.handle.flushFramesRemaining, 0);
  assert.equal(resumed.context.handle.delayFramesRemaining, 0);
  assert.equal(resumed.context, result.context);
});

test("encodeAtrac3plusFramesFromInterleavedPcm rejects mismatched runtime settings", () => {
  const pcm = new Int16Array(2048 * 2);

  const result = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    encodeMode: 0,
  });

  assert.throws(
    () =>
      encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
        bitrateKbps: 96,
        channels: 2,
        sampleRate: 44100,
        encodeMode: 2,
        context: result.context,
      }),
    /ATRAC3plus encode context mismatch/
  );
});

test("encodeAtrac3plusFramesFromInterleavedPcm ignores incomplete runtime stubs", () => {
  const pcm = new Int16Array(2048 * 2);
  const profile = selectAtrac3plusEncodeProfile(96, 2, 44100);
  const stubRuntime = {
    handle: {
      sampleRate: 44100,
      mode: profile.mode,
      frameBytes: profile.frameBytes,
      inputChannels: 2,
      encodeMode: 0,
      bitrateKbps: 96,
    },
    blocks: [],
    frameIndex: 0,
  };

  const result = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    encodeMode: 0,
    context: stubRuntime,
  });

  assert.equal(result.encodedFrames.length, 3);
  assert.notEqual(result.context, stubRuntime);
  assert.equal(result.context.handle.streamChannels, 2);
});

test("encodeAtrac3plusFramesFromInterleavedPcm supports resumable maxOutputFrames", () => {
  const pcm = new Int16Array(2048 * 2);

  const partial = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    maxOutputFrames: 1,
  });
  assert.equal(partial.totalSamples, 2048);
  assert.equal(partial.encodedFrames.length, 1);
  assertEncodedFrames(partial.encodedFrames, partial.profile.frameBytes);
  assert.ok(
    partial.context.handle.flushFramesRemaining > 0 ||
      partial.context.handle.delayFramesRemaining > 0
  );
  const partialFrameIndex = partial.context.frameIndex;

  const resumed = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    maxOutputFrames: 1,
    context: partial.context,
  });
  assert.equal(resumed.totalSamples, 2048);
  assert.equal(resumed.encodedFrames.length, 1);
  assertEncodedFrames(resumed.encodedFrames, resumed.profile.frameBytes);
  assert.equal(resumed.context, partial.context);
  assert.ok(resumed.context.frameIndex > partialFrameIndex);
  assert.ok(Number.isInteger(resumed.context.handle.flushFramesRemaining));
  assert.ok(resumed.context.handle.flushFramesRemaining >= 0);
  assert.ok(Number.isInteger(resumed.context.handle.delayFramesRemaining));
  assert.ok(resumed.context.handle.delayFramesRemaining >= 0);
});

test("encodeAtrac3plusFramesFromInterleavedPcm preserves current zero maxOutputFrames fallback", () => {
  const pcm = new Int16Array(2048 * 2);
  const unlimited = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const zeroLimited = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    maxOutputFrames: 0,
  });

  assert.deepEqual(zeroLimited.encodedFrames, unlimited.encodedFrames);
  assert.equal(zeroLimited.totalSamples, unlimited.totalSamples);
});

test("encodeAtrac3plusFramesFromInterleavedPcm returns debug frames and honors searchBestCandidate", () => {
  const pcm = new Int16Array(2048 * 2);

  const debugResult = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    collectDebug: true,
  });
  assertEncodedFrames(debugResult.encodedFrames, debugResult.profile.frameBytes);
  assert.ok(debugResult.debug);
  assert.equal(debugResult.debug.frames.length, debugResult.encodedFrames.length);

  for (let i = 0; i < debugResult.debug.frames.length; i += 1) {
    const frame = debugResult.debug.frames[i];
    assert.equal(frame.outputFrameIndex, i);
    assert.ok(Number.isInteger(frame.frameIndex));
    assert.ok(frame.frameIndex >= 0);
    assert.ok(Number.isInteger(frame.bandLimit));
    assert.ok(frame.bandLimit >= 0);
    assert.ok(Number.isInteger(frame.bitpos));
    assert.ok(frame.bitpos >= 0);
    assert.ok(Number.isInteger(frame.usedBits));
    assert.ok(frame.usedBits >= 0);
    assert.ok(Number.isInteger(frame.budgetBits));
    assert.ok(frame.budgetBits >= frame.usedBits);
    assert.ok(Number.isInteger(frame.maxBits));
    assert.ok(frame.maxBits >= frame.budgetBits);
    assert.ok(Number.isInteger(frame.attempt));
    assert.ok(frame.attempt >= 0);
    assert.equal(frame.useExactQuant, true);
  }

  const searchFalse = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    searchBestCandidate: false,
  });
  const searchTrue = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    searchBestCandidate: true,
  });
  assert.deepEqual(searchFalse.encodedFrames, searchTrue.encodedFrames);
});

test("encodeAtrac3plusFramesFromInterleavedPcm traces multiblock allocation summaries", () => {
  const pcm = new Int16Array(2048 * 6);
  const previousTrace = process.env.CARTA_TRACE_ATX_MC_ALLOC;
  process.env.CARTA_TRACE_ATX_MC_ALLOC = "1";

  try {
    const result = encodeAtrac3plusFramesFromInterleavedPcm(pcm, {
      bitrateKbps: 192,
      channels: 6,
      sampleRate: 44100,
      collectDebug: true,
      maxOutputFrames: 1,
    });
    assert.equal(result.encodedFrames.length, 1);
    assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
    assert.ok(result.debug);
    assert.equal(result.debug.frames.length, 1);

    const debugFrame = result.debug.frames[0];
    assert.equal(debugFrame.outputFrameIndex, 0);
    assert.ok(debugFrame.sharedBudget);

    const sharedBudget = debugFrame.sharedBudget;
    assert.ok(Number.isInteger(sharedBudget.maxBits));
    assert.ok(sharedBudget.maxBits > 0);
    assert.ok(Number.isInteger(sharedBudget.unitCount));
    assert.ok(sharedBudget.unitCount > 0);
    assert.equal(sharedBudget.channelsInUnit.length, sharedBudget.unitCount);
    assert.equal(sharedBudget.mode4BlockFlags.length, sharedBudget.unitCount);
    assert.equal(sharedBudget.targetBitsPreCarry.length, sharedBudget.unitCount);
    assert.equal(sharedBudget.targetBitsFinal.length, sharedBudget.unitCount);
    assert.equal(sharedBudget.usedBitsByUnit.length, sharedBudget.unitCount);
    assert.equal(sharedBudget.carryBitsByUnit.length, sharedBudget.unitCount);
    for (const usedBits of sharedBudget.usedBitsByUnit) {
      assert.ok(Number.isInteger(usedBits));
      assert.ok(usedBits >= 0);
    }
    for (const carryBits of sharedBudget.carryBitsByUnit) {
      assert.ok(Number.isInteger(carryBits));
      assert.ok(carryBits >= 0);
    }
    assert.ok(Number.isInteger(sharedBudget.totalUsedBits));
    assert.ok(sharedBudget.totalUsedBits >= 0);
    assert.equal(
      sharedBudget.usedBitsByUnit.reduce((sum, bits) => sum + bits, 0),
      sharedBudget.totalUsedBits
    );
  } finally {
    if (previousTrace === undefined) {
      delete process.env.CARTA_TRACE_ATX_MC_ALLOC;
    } else {
      process.env.CARTA_TRACE_ATX_MC_ALLOC = previousTrace;
    }
  }
});

test("analyzeAtrac3plusFramesFromInterleavedPcm reports per-frame block summaries", () => {
  const pcm = new Int16Array(2048 * 2);
  const result = analyzeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });

  assert.equal(result.totalSamples, 2048);
  const expectedFrames = Math.ceil(result.totalSamples / result.profile.frameSamples);
  assert.equal(result.processedFrames, expectedFrames);
  assert.equal(result.frameAnalyses.length, expectedFrames);
  assert.equal(result.context.frameIndex, expectedFrames);

  for (const analysis of result.frameAnalyses) {
    assert.ok(Number.isInteger(analysis.frameIndex));
    assert.ok(analysis.frameIndex >= 0);
    assert.ok(Array.isArray(analysis.blockResults));
    assert.ok(analysis.blockResults.length > 0);

    for (const block of analysis.blockResults) {
      assert.ok(Number.isInteger(block.blockIndex));
      assert.ok(block.blockIndex >= 0);
      assert.ok(Number.isInteger(block.channels));
      assert.ok(block.channels >= 1);
      assert.ok(Number.isInteger(block.bandCount));
      assert.ok(block.bandCount > 0);
      assert.ok(block.bandCount <= 16);
    }
  }
});

test("analyzeAtrac3plusFramesFromInterleavedPcm reuses runtime contexts", () => {
  const pcm = new Int16Array(2048 * 2);
  const first = analyzeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const firstEndFrameIndex = first.context.frameIndex;
  assert.ok(Array.isArray(first.context.planarScratch));

  const resumed = analyzeAtrac3plusFramesFromInterleavedPcm(pcm, {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    context: first.context,
  });
  assert.equal(resumed.context, first.context);
  assert.equal(resumed.processedFrames, first.processedFrames);
  assert.equal(resumed.frameAnalyses.length, first.frameAnalyses.length);
  assert.equal(resumed.frameAnalyses[0].frameIndex, firstEndFrameIndex);
  assert.equal(resumed.context.frameIndex, firstEndFrameIndex + resumed.processedFrames);
});

test("ATRAC3plus wrappers preserve current validation behavior", () => {
  assert.throws(
    () => encodeAtrac3plusFramesFromInterleavedPcm(new Int16Array(3), { channels: 2 }),
    /PCM sample length 3 is not divisible by channel count 2/
  );
  assert.throws(
    () =>
      encodeAtrac3plusFramesFromInterleavedPcm(new Int16Array(4), {
        bitrateKbps: 132,
        channels: 2,
        sampleRate: 44100,
      }),
    /ATRAC3plus profile mismatch: bitrate=132 channels=2 sampleRate=44100/
  );
});

test("encodeAtrac3plusFramesFromInterleavedPcm flushes even for empty input", () => {
  const result = encodeAtrac3plusFramesFromInterleavedPcm(new Int16Array(0), {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });

  assert.equal(result.totalSamples, 0);
  assert.ok(result.encodedFrames.length > 0);
  assertEncodedFrames(result.encodedFrames, result.profile.frameBytes);
  assert.equal(result.context.handle.flushFramesRemaining, 0);
  assert.equal(result.context.handle.delayFramesRemaining, 0);
});
