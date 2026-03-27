import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3Internal from "../../../src/atrac3/internal.js";
import {
  ATRAC3_FRAME_SAMPLES,
  ATRAC3_RESIDUAL_DELAY_SAMPLES,
} from "../../../src/atrac3/constants.js";
import { parseAtracWavBuffer } from "../../../src/container/index.js";
import { encodeAtrac3WavBufferFromInterleavedPcm } from "../../../src/encoders/atrac3.js";

function createPcm(sampleCount) {
  return Int16Array.from({ length: sampleCount }, (_, index) => ((index * 37) % 200) - 100);
}

function createAtrac3Container(sampleCount = 1024 * 4, bitrateKbps = 66) {
  const encoded = encodeAtrac3WavBufferFromInterleavedPcm(createPcm(sampleCount), {
    bitrateKbps,
    channels: 2,
    sampleRate: 44100,
  });

  return parseAtracWavBuffer(encoded.buffer);
}

function writeStridedValues(work, start, values) {
  for (const [index, value] of values.entries()) {
    work[start + index * 4] = value;
  }
}

function readStereoBandValues(state, start, count) {
  const left = state.primaryChannel.workF32;
  const right = state.secondaryChannel.workF32;
  return Array.from({ length: count }, (_, index) => {
    const sampleIndex = start + index * 4;
    return [sampleIndex, left[sampleIndex], right[sampleIndex]];
  });
}

function roundFloat(value) {
  return Math.round(value * 1e6) / 1e6;
}

test("rollAtrac3StereoMixHeader preserves source-target rotation and selector staging", () => {
  const state = Atrac3Internal.Codec.createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  const errors = [];

  state.bitstream.stream.set(Uint8Array.of(0x13, 0x10), 0);
  Atrac3Internal.Codec.rollAtrac3StereoMixHeader(state, 0, (_state, message) =>
    errors.push(message)
  );

  assert.deepEqual(state.stereoMix.source, {
    unitMode: 4,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 3],
  });
  assert.deepEqual(state.stereoMix.target, {
    unitMode: 0,
    pairScaleIndex: 2,
    gainSelectors: [0, 3, 0, 1],
  });
  assert.deepEqual(errors, []);
});

test("rollAtrac3StereoMixHeader preserves invalid gain-selector rollover behavior", () => {
  const state = Atrac3Internal.Codec.createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  const errors = [];

  state.bitstream.stream.set(Uint8Array.of(0x00, 0x20), 0);
  Atrac3Internal.Codec.rollAtrac3StereoMixHeader(state, 1, (_state, message) =>
    errors.push(message)
  );

  assert.deepEqual(errors, ["gain-sel band=3"]);
  assert.deepEqual(state.stereoMix.source, {
    unitMode: 4,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 3],
  });
  assert.deepEqual(state.stereoMix.target, {
    unitMode: 1,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 3],
  });
});

test("rollAtrac3StereoMixHeader preserves partial header rollover before a later selector error", () => {
  const state = Atrac3Internal.Codec.createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  const errors = [];

  state.bitstream.stream.set(Uint8Array.of(0x00, 0x90), 0);
  Atrac3Internal.Codec.rollAtrac3StereoMixHeader(state, 1, (_state, message) =>
    errors.push(message)
  );

  assert.deepEqual(errors, ["gain-sel band=2"]);
  assert.deepEqual(state.stereoMix.source, {
    unitMode: 4,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 3],
  });
  assert.deepEqual(state.stereoMix.target, {
    unitMode: 1,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 1],
  });
});

test("mixAtrac3StereoChannels preserves the steady stereo mix path and header rollover", () => {
  const state = Atrac3Internal.Codec.createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  writeStridedValues(state.primaryChannel.workF32, 138, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  writeStridedValues(state.secondaryChannel.workF32, 138, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

  const errors = [];
  state.bitstream.stream.set(Uint8Array.of(0, 0), 0);
  Atrac3Internal.Codec.mixAtrac3StereoChannels(state, 4, (_state, message) => errors.push(message));

  assert.deepEqual(readStereoBandValues(state, 138, 10), [
    [138, 28, 12],
    [142, 30, 12],
    [146, 32, 12],
    [150, 34, 12],
    [154, 36, 12],
    [158, 38, 12],
    [162, 40, 12],
    [166, 42, 12],
    [170, 44, 12],
    [174, 46, 12],
  ]);
  assert.deepEqual(state.stereoMix.source, {
    unitMode: 4,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 3],
  });
  assert.deepEqual(state.stereoMix.target, {
    unitMode: 4,
    pairScaleIndex: 0,
    gainSelectors: [0, 0, 0, 0],
  });
  assert.deepEqual(errors, []);
});

test("mixAtrac3StereoChannels preserves the 8-sample lead-in interpolation", () => {
  const state = Atrac3Internal.Codec.createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  state.stereoMix.source.unitMode = 2;
  state.stereoMix.target.unitMode = 1;
  state.stereoMix.source.pairScaleIndex = 0;
  state.stereoMix.target.pairScaleIndex = 14;
  state.stereoMix.source.gainSelectors[3] = 0;
  state.stereoMix.target.gainSelectors[3] = 3;

  writeStridedValues(state.primaryChannel.workF32, 141, [10, 11, 12, 13, 14, 15, 16, 17]);
  writeStridedValues(state.secondaryChannel.workF32, 141, [4, 5, 6, 7, 8, 9, 10, 11]);
  writeStridedValues(state.primaryChannel.workF32, 173, [20, 21, 22, 23, 24, 25, 26, 27]);
  writeStridedValues(state.secondaryChannel.workF32, 173, [8, 9, 10, 11, 12, 13, 14, 15]);

  const errors = [];
  state.bitstream.stream.set(Uint8Array.of(0x13, 0x10), 0);
  Atrac3Internal.Codec.mixAtrac3StereoChannels(state, 0, (_state, message) => errors.push(message));

  assert.deepEqual(readStereoBandValues(state, 141, 8), [
    [141, 0, 16.970561981201172],
    [145, 1.34375, 15.327414512634277],
    [149, 3.375, 13.761931419372559],
    [153, 6.09375, 12.274113655090332],
    [157, 9.5, 10.863961219787598],
    [161, 13.59375, 9.531473159790039],
    [165, 18.375, 8.276650428771973],
    [169, 23.84375, 7.09949254989624],
  ]);
  assert.deepEqual(readStereoBandValues(state, 173, 8), [
    [173, 28, 12],
    [177, 30, 12],
    [181, 32, 12],
    [185, 34, 12],
    [189, 36, 12],
    [193, 38, 12],
    [197, 40, 12],
    [201, 42, 12],
  ]);
  assert.deepEqual(state.stereoMix.source, {
    unitMode: 1,
    pairScaleIndex: 14,
    gainSelectors: [3, 3, 3, 3],
  });
  assert.deepEqual(state.stereoMix.target, {
    unitMode: 0,
    pairScaleIndex: 2,
    gainSelectors: [0, 3, 0, 1],
  });
  assert.deepEqual(errors, []);
});

test("synthesizeAtrac3Channel preserves the current tap traversal and state rollover", () => {
  const workF32 = new Float32Array(ATRAC3_FRAME_SAMPLES + ATRAC3_RESIDUAL_DELAY_SAMPLES);

  for (let index = 0; index < 96; index += 1) {
    workF32[index] = ((index * 17) % 29) - 14 + index / 16;
  }
  for (
    let index = ATRAC3_RESIDUAL_DELAY_SAMPLES;
    index < ATRAC3_RESIDUAL_DELAY_SAMPLES + 96;
    index += 1
  ) {
    workF32[index] = ((index * 11) % 31) - 15 + index / 32;
  }

  Atrac3Internal.Codec.synthesizeAtrac3Channel({ workF32 });

  assert.deepEqual(
    Array.from(workF32.slice(0, 16), roundFloat),
    [
      -124210.304687, -5351903.5, 816151.0625, 13388489, -4213954, -35744004, 12839616, 79402120,
      -25432072, -149823280, 34815904, 254149280, -28788688, -399348096, -20410178, 597655296,
    ]
  );
  assert.deepEqual(
    Array.from(workF32.slice(46, 62), roundFloat),
    [
      274760704, 849928512, 40969756, -409471232, -142098688, -821628672, 295308000, 878480512,
      -45279348, 668615424, -982299904, -1155487744, 342330240, -1383389952, 2355583488, 3451542528,
    ]
  );
});

test("buildAtrac3StereoPcm clamps to the full PCM16 range", () => {
  const primary = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const secondary = new Float32Array(ATRAC3_FRAME_SAMPLES);
  primary.set([32767.4, 32767.6, -32768.2, Number.NaN]);
  secondary.set([-32767.4, -0.49, 0.5, 12.6]);

  const pcm = Atrac3Internal.Codec.buildAtrac3StereoPcm(
    { workF32: primary },
    { workF32: secondary }
  );

  assert.deepEqual(Array.from(pcm.slice(0, 8)), [32767, -32767, 32767, 0, -32768, 1, 0, 13]);
});

test("decodeAtrac3Frame preserves frame warm-up output and gain-table rotation", () => {
  const container = createAtrac3Container();
  const state = Atrac3Internal.Codec.createAtrac3DecoderState(container);
  const channelPair = [state.primaryChannel, state.secondaryChannel];
  const initialGainTableRefs = channelPair.map((channel) => ({
    active: channel.gainTables.active,
    staged: channel.gainTables.staged,
  }));

  const firstFrame = Atrac3Internal.Codec.decodeAtrac3Frame(state, container.frames[0]);
  assert.deepEqual(Array.from(firstFrame.slice(0, 16)), new Array(16).fill(0));
  assert.equal(state.callCount, 1);
  assert.deepEqual(
    [state.primaryChannel.prevBlockCount, state.secondaryChannel.prevBlockCount],
    [3, 1]
  );

  for (const [channelIndex, channel] of channelPair.entries()) {
    assert.equal(channel.gainTables.active, initialGainTableRefs[channelIndex].staged);
    assert.equal(channel.gainTables.staged, initialGainTableRefs[channelIndex].active);
  }

  const secondFrame = Atrac3Internal.Codec.decodeAtrac3Frame(state, container.frames[1]);
  assert.deepEqual(
    Array.from(secondFrame.slice(0, 16)),
    [-6, -6, -7, -7, -1, -3, 5, 3, 4, 2, 2, -1, 2, -2, 2, -3]
  );
  assert.equal(state.callCount, 2);
  assert.equal(state.bitstream.flags, 0);

  for (const [channelIndex, channel] of channelPair.entries()) {
    assert.equal(channel.gainTables.active, initialGainTableRefs[channelIndex].active);
    assert.equal(channel.gainTables.staged, initialGainTableRefs[channelIndex].staged);
  }
});

test("decodeAtrac3Frame preserves low-level channel-header failure reporting", () => {
  const container = createAtrac3Container();
  const state = Atrac3Internal.Codec.createAtrac3DecoderState(container);
  const corruptedFrame = new Uint8Array(container.frames[0]);
  corruptedFrame[0] = 0;

  assert.throws(
    () => Atrac3Internal.Codec.decodeAtrac3Frame(state, corruptedFrame),
    /ATRAC3 frame decode failed/
  );
  assert.equal(state.callCount, 1);
  assert.equal(state.bitstream.flags, 2);
});

test("decodeAtrac3Frame preserves the direct secondary rebuild path at 105 kbps", () => {
  const container = createAtrac3Container(1024 * 4, 105);
  const state = Atrac3Internal.Codec.createAtrac3DecoderState(container);

  const firstFrame = Atrac3Internal.Codec.decodeAtrac3Frame(state, container.frames[0]);
  const secondFrame = Atrac3Internal.Codec.decodeAtrac3Frame(state, container.frames[1]);

  assert.deepEqual(Array.from(firstFrame.slice(0, 16)), new Array(16).fill(0));
  assert.deepEqual(
    Array.from(secondFrame.slice(0, 16)),
    [4, -9, -1, 5, 0, 7, 2, -5, -5, -1, -8, 9, 1, -3, 8, -14]
  );
  assert.deepEqual(
    [state.primaryChannel.prevBlockCount, state.secondaryChannel.prevBlockCount],
    [3, 3]
  );
});
