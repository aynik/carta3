import assert from "node:assert/strict";
import test from "node:test";

import { selectAtracEncodeProfile } from "../../../src/encoders/profiles.js";
import {
  createAtrac3PlusDecoderState,
  parseAtrac3PlusCodecBytes,
} from "../../../src/atrac3plus/state.js";

test("parseAtrac3PlusCodecBytes decodes ATRAC3plus profile metadata", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);

  assert.deepEqual(parseAtrac3PlusCodecBytes(profile.atracxCodecBytes, profile.frameBytes), {
    sampleRateCode: 1,
    sampleRate: 44100,
    mode: 2,
    derivedFrameBytes: 560,
  });
});

test("parseAtrac3PlusCodecBytes preserves current short-buffer fallback", () => {
  assert.deepEqual(parseAtrac3PlusCodecBytes(null, 560), {
    sampleRateCode: null,
    sampleRate: null,
    mode: null,
    derivedFrameBytes: 560,
  });
  assert.deepEqual(parseAtrac3PlusCodecBytes(Uint8Array.of(0x28), 560), {
    sampleRateCode: null,
    sampleRate: null,
    mode: null,
    derivedFrameBytes: 560,
  });
});

test("createAtrac3PlusDecoderState preserves codec-derived topology", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const state = createAtrac3PlusDecoderState({
    channels: profile.channels,
    frameBytes: profile.frameBytes,
    atracxCodecBytes: profile.atracxCodecBytes,
  });

  assert.deepEqual(
    {
      outputChannels: state.outputChannels,
      streamChannels: state.streamChannels,
      mode: state.mode,
      blockCount: state.blockCount,
      blockChannels: state.blockChannels,
      sampleRateCode: state.sampleRateCode,
      sampleRate: state.sampleRate,
      frameSamples: state.frameSamples,
      handleSampleRate: state.handle?.sampleRate ?? null,
      handleMode: state.handle?.mode ?? null,
    },
    {
      outputChannels: 2,
      streamChannels: 2,
      mode: 2,
      blockCount: 1,
      blockChannels: [2],
      sampleRateCode: 1,
      sampleRate: 44100,
      frameSamples: 2048,
      handleSampleRate: 44100,
      handleMode: 2,
    }
  );
});

test("createAtrac3PlusDecoderState preserves current sample-rate fallback", () => {
  const state = createAtrac3PlusDecoderState({
    channels: 2,
    frameBytes: 560,
    sampleRate: 48000,
    atracxCodecBytes: Uint8Array.of(0xe8, 0x45),
  });

  assert.equal(state.sampleRateCode, 7);
  assert.equal(state.sampleRate, 48000);
  assert.equal(state.handle?.sampleRate, 48000);
  assert.equal(state.mode, 2);
});

test("createAtrac3PlusDecoderState keeps codec-derived topology when the sample rate stays unknown", () => {
  const state = createAtrac3PlusDecoderState({
    channels: 2,
    frameBytes: 560,
    atracxCodecBytes: Uint8Array.of(0xe8, 0x45),
  });

  assert.deepEqual(
    {
      streamChannels: state.streamChannels,
      mode: state.mode,
      blockCount: state.blockCount,
      blockChannels: state.blockChannels,
      sampleRateCode: state.sampleRateCode,
      sampleRate: state.sampleRate,
      handle: state.handle,
    },
    {
      streamChannels: 2,
      mode: 2,
      blockCount: 1,
      blockChannels: [2],
      sampleRateCode: 7,
      sampleRate: null,
      handle: null,
    }
  );
});

test("createAtrac3PlusDecoderState preserves current no-codec fallback", () => {
  const state = createAtrac3PlusDecoderState({
    channels: 2,
    frameBytes: 560,
    frameSamples: 4096,
    sampleRate: 44100,
  });

  assert.deepEqual(
    {
      streamChannels: state.streamChannels,
      mode: state.mode,
      blockCount: state.blockCount,
      blockChannels: state.blockChannels,
      sampleRateCode: state.sampleRateCode,
      sampleRate: state.sampleRate,
      frameSamples: state.frameSamples,
      handle: state.handle,
    },
    {
      streamChannels: 2,
      mode: 0,
      blockCount: 0,
      blockChannels: [],
      sampleRateCode: null,
      sampleRate: 44100,
      frameSamples: 4096,
      handle: null,
    }
  );
});

test("createAtrac3PlusDecoderState ignores frameSamples when mode is known", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const state = createAtrac3PlusDecoderState({
    channels: profile.channels,
    frameBytes: profile.frameBytes,
    frameSamples: 4096,
    sampleRate: profile.sampleRate,
    atracxCodecBytes: profile.atracxCodecBytes,
  });

  assert.equal(state.mode, profile.mode);
  assert.equal(state.frameSamples, 2048);
  assert.ok(state.handle);
});

test("createAtrac3PlusDecoderState preserves current non-positive frame-sample fallback", () => {
  const state = createAtrac3PlusDecoderState({
    channels: 2,
    frameBytes: 560,
    frameSamples: 0,
    sampleRate: 44100,
  });

  assert.equal(state.frameSamples, 2048);
  assert.equal(state.handle, null);
});

test("createAtrac3PlusDecoderState preserves current validation errors", () => {
  assert.throws(() => createAtrac3PlusDecoderState(null), /config must be an object/);
  assert.throws(
    () => createAtrac3PlusDecoderState({ channels: 0, frameBytes: 560 }),
    /invalid ATRAC3plus channel count: 0/
  );
  assert.throws(
    () => createAtrac3PlusDecoderState({ channels: 2, frameBytes: 0 }),
    /invalid ATRAC3plus frame byte count: 0/
  );
  assert.throws(
    () =>
      createAtrac3PlusDecoderState({
        channels: 2,
        frameBytes: 568,
        atracxCodecBytes: Uint8Array.of(0x28, 0x45),
      }),
    /ATRAC3plus frame byte mismatch: fmt=568 codec=560/
  );
  assert.throws(
    () =>
      createAtrac3PlusDecoderState({
        channels: 1,
        frameBytes: 8,
        atracxCodecBytes: Uint8Array.of(0x20, 0x00),
      }),
    /unsupported ATRAC3plus mode: 0/
  );
});
