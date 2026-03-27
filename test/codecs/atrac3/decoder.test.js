import assert from "node:assert/strict";
import test from "node:test";

import { Atrac3Decoder } from "../../../src/atrac3/decoder.js";
import {
  createAtrac3DecoderChannelState,
  createAtrac3DecoderState,
  createAtrac3FrameBitstreamState,
  createAtrac3StereoMixState,
} from "../../../src/atrac3/decoder-state.js";
import {
  decodeAtrac3Frames,
  resolveAtrac3DecodeOutputChannels,
} from "../../../src/atrac3/decode-output.js";
import {
  ATRAC3_TRANSPORT_DIRECT,
  ATRAC3_TRANSPORT_SWAPPED_TAIL,
} from "../../../src/atrac3/profiles.js";
import { parseAtracWavBuffer } from "../../../src/container/index.js";
import { encodeAtrac3WavBufferFromInterleavedPcm } from "../../../src/encoders/atrac3.js";

function createPcm(sampleCount) {
  return Int16Array.from({ length: sampleCount }, (_, index) => ((index * 37) % 200) - 100);
}

function createAtrac3Container(bitrateKbps = 66) {
  const encoded = encodeAtrac3WavBufferFromInterleavedPcm(createPcm(1024 * 2), {
    bitrateKbps,
    channels: 2,
    sampleRate: 44100,
  });

  return parseAtracWavBuffer(encoded.buffer);
}

test("createAtrac3DecoderState rejects null config without crashing", () => {
  assert.throws(() => createAtrac3DecoderState(null), /config must be an object/);
});

function summarizeState(state) {
  return {
    modeIndex: state.modeIndex,
    bitrateKbps: state.bitrateKbps,
    streamChannels: state.streamChannels,
    frameBytes: state.frameBytes,
    frameSamples: state.frameSamples,
    spectrumScratchLength: state.spectrumScratch.length,
    stepBytes: state.bitstream.stepBytes,
    streamLength: state.bitstream.stream.length,
    stereoMix: {
      source: {
        unitMode: state.stereoMix.source.unitMode,
        pairScaleIndex: state.stereoMix.source.pairScaleIndex,
        gainSelectors: state.stereoMix.source.gainSelectors,
      },
      target: {
        unitMode: state.stereoMix.target.unitMode,
        pairScaleIndex: state.stereoMix.target.pairScaleIndex,
        gainSelectors: state.stereoMix.target.gainSelectors,
      },
    },
    transportModes: [state.primaryChannel.transportMode, state.secondaryChannel.transportMode],
    workLengths: [state.primaryChannel.workF32.length, state.secondaryChannel.workF32.length],
    spectrumHistoryLengths: [
      state.primaryChannel.spectrumHistory.map((history) => history.length),
      state.secondaryChannel.spectrumHistory.map((history) => history.length),
    ],
    activeGainTables: [state.primaryChannel, state.secondaryChannel].map(({ gainTables }) =>
      gainTables.active.map((entries) => ({
        length: entries.length,
        first: entries[0],
        last: entries.at(-1),
      }))
    ),
  };
}

function summarizeGainTablePhase(phase) {
  return phase.map((entries) => ({
    length: entries.length,
    first: entries[0],
    last: entries.at(-1),
  }));
}

test("resolveAtrac3DecodeOutputChannels keeps mono requests and stream-mono fallback", () => {
  assert.equal(resolveAtrac3DecodeOutputChannels(1, 2), 1);
  assert.equal(resolveAtrac3DecodeOutputChannels(2, 2), 2);
  assert.equal(resolveAtrac3DecodeOutputChannels(2, 1), 2);
  assert.equal(resolveAtrac3DecodeOutputChannels(undefined, 1), 1);
  assert.equal(resolveAtrac3DecodeOutputChannels(undefined, 2), 2);
  assert.equal(resolveAtrac3DecodeOutputChannels(9, 2), 2);
});

test("decodeAtrac3Frames preserves current trimmed stereo output", () => {
  const container = createAtrac3Container();
  const state = createAtrac3DecoderState(container);
  const pcm = decodeAtrac3Frames(
    state,
    container.channels,
    container.frames.map((frame) => new DataView(frame.buffer, frame.byteOffset, frame.byteLength)),
    container.factSamples,
    container.factRaw
  );

  assert.equal(pcm.length, 2048);
  assert.deepEqual(
    Array.from(pcm.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
});

test("decodeAtrac3Frames preserves mono projection and fact fallback trim", () => {
  const container = createAtrac3Container();

  const mono = decodeAtrac3Frames(
    createAtrac3DecoderState(container),
    1,
    container.frames,
    container.factSamples,
    container.factRaw
  );
  const fallback = decodeAtrac3Frames(createAtrac3DecoderState(container), 2, container.frames);

  assert.equal(mono.length, 1024);
  assert.deepEqual(
    Array.from(mono.slice(0, 16)),
    [-43, -10, 18, 3, -14, -8, -2, 1, 14, 16, -5, -19, 0, 21, 8, -16]
  );
  assert.equal(fallback.length, 3958);
  assert.deepEqual(
    Array.from(fallback.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
});

test("decodeAtrac3Frames preserves mono projection with direct secondary transport", () => {
  const container = createAtrac3Container(105);

  const mono = decodeAtrac3Frames(
    createAtrac3DecoderState(container),
    1,
    container.frames,
    container.factSamples,
    container.factRaw
  );

  assert.equal(mono.length, 1024);
  assert.deepEqual(
    Array.from(mono.slice(0, 16)),
    [-53, -16, -5, -26, -10, 20, 6, -2, 28, 27, -22, -36, 1, 13, -9, 1]
  );
});

test("decodeAtrac3Frames preserves current frame validation errors", () => {
  const container = createAtrac3Container();

  assert.throws(
    () => decodeAtrac3Frames(createAtrac3DecoderState(container), 2, []),
    /ATRAC3 input has no frames/
  );
  assert.throws(
    () =>
      decodeAtrac3Frames(
        createAtrac3DecoderState(container),
        2,
        [container.frames[0].subarray(0, container.frameBytes - 1)],
        container.factSamples,
        container.factRaw
      ),
    /invalid ATRAC3 frame length at index 0 \(expected 192, got 191\)/
  );
});

test("Atrac3Decoder preserves current trimmed stereo output", () => {
  const container = createAtrac3Container();
  const decoder = new Atrac3Decoder(container);
  const pcm = decoder.decodeFrames(container.frames, container.factSamples, container.factRaw).pcm;

  assert.equal(pcm.length, 2048);
  assert.deepEqual(
    Array.from(pcm.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
});

test("Atrac3Decoder preserves the current direct secondary transport path at 105 kbps", () => {
  const container = createAtrac3Container(105);
  const decoder = new Atrac3Decoder(container);
  const pcm = decoder.decodeFrames(container.frames, container.factSamples, container.factRaw).pcm;

  assert.equal(pcm.length, 2048);
  assert.deepEqual(
    Array.from(pcm.slice(0, 16)),
    [-53, -30, -16, 3, -5, 45, -26, 19, -10, -40, 20, -40, 6, 3, -2, 3]
  );
});

test("Atrac3Decoder falls back to the resolved stream channel layout when channels are omitted", () => {
  const container = createAtrac3Container();
  const inferred = new Atrac3Decoder({
    sampleRate: container.sampleRate,
    frameBytes: container.frameBytes,
    bitrateKbps: container.bitrateKbps,
  }).decodeFrames(container.frames, container.factSamples, container.factRaw).pcm;

  assert.equal(inferred.length, 2048);
  assert.deepEqual(
    Array.from(inferred.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
});

test("Atrac3Decoder resolves the authored layout without requiring sampleRate", () => {
  const container = createAtrac3Container();
  const inferred = new Atrac3Decoder({
    frameBytes: container.frameBytes,
    bitrateKbps: container.bitrateKbps,
  }).decodeFrames(container.frames, container.factSamples, container.factRaw).pcm;

  assert.equal(inferred.length, 2048);
  assert.deepEqual(
    Array.from(inferred.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
});

test("Atrac3Decoder ignores unsupported requested channel counts and keeps the stream layout", () => {
  const container = createAtrac3Container();
  const pcm = new Atrac3Decoder({ ...container, channels: 9 }).decodeFrames(
    container.frames,
    container.factSamples,
    container.factRaw
  ).pcm;

  assert.equal(pcm.length, 2048);
  assert.deepEqual(
    Array.from(pcm.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
});

test("Atrac3Decoder keeps the requested output channel count live on the wrapper config", () => {
  const container = createAtrac3Container();
  const decoder = new Atrac3Decoder({
    frameBytes: container.frameBytes,
    bitrateKbps: container.bitrateKbps,
  });

  const stereo = decoder.decodeFrames(
    container.frames,
    container.factSamples,
    container.factRaw
  ).pcm;
  decoder.config.channels = 1;
  const mono = decoder.decodeFrames(container.frames, container.factSamples, container.factRaw).pcm;

  assert.equal(stereo.length, 2048);
  assert.deepEqual(
    Array.from(stereo.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
  assert.equal(mono.length, 1024);
  assert.deepEqual(
    Array.from(mono.slice(0, 16)),
    [-43, -10, 18, 3, -14, -8, -2, 1, 14, 16, -5, -19, 0, 21, 8, -16]
  );
});

test("Atrac3Decoder preserves current null-fact fallback through the public wrapper", () => {
  const container = createAtrac3Container();
  const pcm = new Atrac3Decoder(container).decodeFrames(
    container.frames,
    container.factSamples,
    null
  ).pcm;

  assert.equal(pcm.length, 2048);
  assert.deepEqual(
    Array.from(pcm.slice(0, 16)),
    [-43, -37, -10, -5, 18, 20, 3, 4, -14, -15, -8, -10, -2, -6, 1, -3]
  );
});

test("Atrac3Decoder preserves current frame validation errors", () => {
  const container = createAtrac3Container();
  const decoder = new Atrac3Decoder(container);

  assert.throws(() => decoder.decodeFrames([]), /ATRAC3 input has no frames/);
  assert.throws(
    () =>
      decoder.decodeFrames(
        [container.frames[0].subarray(0, container.frameBytes - 1)],
        container.factSamples,
        container.factRaw
      ),
    /invalid ATRAC3 frame length at index 0 \(expected 192, got 191\)/
  );
});

test("createAtrac3DecoderState preserves representative stereo and mono layouts", () => {
  const stereo = createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  const mono = createAtrac3DecoderState({ bitrateKbps: 132, frameBytes: 384 });

  assert.deepEqual(summarizeState(stereo), {
    modeIndex: 2,
    bitrateKbps: 66,
    streamChannels: 2,
    frameBytes: 192,
    frameSamples: 1024,
    spectrumScratchLength: 1024,
    stepBytes: 192,
    streamLength: 196,
    stereoMix: {
      source: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
      target: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
    },
    transportModes: [ATRAC3_TRANSPORT_DIRECT, ATRAC3_TRANSPORT_SWAPPED_TAIL],
    workLengths: [1162, 1162],
    spectrumHistoryLengths: [
      [128, 128, 128, 128],
      [128, 128, 128, 128],
    ],
    activeGainTables: [
      [
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
      ],
      [
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
      ],
    ],
  });

  assert.deepEqual(summarizeState(mono), {
    modeIndex: 5,
    bitrateKbps: 132,
    streamChannels: 1,
    frameBytes: 384,
    frameSamples: 1024,
    spectrumScratchLength: 1024,
    stepBytes: 192,
    streamLength: 388,
    stereoMix: {
      source: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
      target: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
    },
    transportModes: [ATRAC3_TRANSPORT_DIRECT, ATRAC3_TRANSPORT_DIRECT],
    workLengths: [1162, 1162],
    spectrumHistoryLengths: [
      [128, 128, 128, 128],
      [128, 128, 128, 128],
    ],
    activeGainTables: [
      [
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
      ],
      [
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
      ],
    ],
  });
});

test("createAtrac3DecoderState preserves the authored mono and stereo layout catalogues", () => {
  const stereoModes = [
    [33, 96, 0, 96],
    [47, 136, 1, 136],
    [66, 192, 2, 192],
    [94, 272, 3, 272],
    [105, 304, 12, 304],
    [132, 384, 13, 384],
    [146, 424, 14, 424],
    [176, 512, 15, 512],
  ];
  const monoModes = [
    [33, 96, 8, 48],
    [47, 136, 9, 68],
    [66, 192, 10, 96],
    [94, 272, 11, 136],
    [105, 304, 4, 152],
    [132, 384, 5, 192],
    [146, 424, 6, 212],
    [176, 512, 7, 256],
  ];

  assert.deepEqual(
    stereoModes.map(([bitrateKbps, frameBytes]) => {
      const state = createAtrac3DecoderState({ atrac3Flag: 1, bitrateKbps, frameBytes });
      return {
        modeIndex: state.modeIndex,
        bitrateKbps: state.bitrateKbps,
        frameBytes: state.frameBytes,
        streamChannels: state.streamChannels,
        stepBytes: state.bitstream.stepBytes,
        transportModes: [state.primaryChannel.transportMode, state.secondaryChannel.transportMode],
      };
    }),
    stereoModes.map(([bitrateKbps, frameBytes, modeIndex, stepBytes]) => ({
      modeIndex,
      bitrateKbps,
      frameBytes,
      streamChannels: 2,
      stepBytes,
      transportModes: [ATRAC3_TRANSPORT_DIRECT, ATRAC3_TRANSPORT_SWAPPED_TAIL],
    }))
  );

  assert.deepEqual(
    monoModes.map(([bitrateKbps, frameBytes]) => {
      const state = createAtrac3DecoderState({ atrac3Flag: 0, bitrateKbps, frameBytes });
      return {
        modeIndex: state.modeIndex,
        bitrateKbps: state.bitrateKbps,
        frameBytes: state.frameBytes,
        streamChannels: state.streamChannels,
        stepBytes: state.bitstream.stepBytes,
        transportModes: [state.primaryChannel.transportMode, state.secondaryChannel.transportMode],
      };
    }),
    monoModes.map(([bitrateKbps, frameBytes, modeIndex, stepBytes]) => ({
      modeIndex,
      bitrateKbps,
      frameBytes,
      streamChannels: 1,
      stepBytes,
      transportModes: [ATRAC3_TRANSPORT_DIRECT, ATRAC3_TRANSPORT_DIRECT],
    }))
  );
});

test("createAtrac3DecoderState preserves atrac3Flag override behavior", () => {
  assert.deepEqual(
    summarizeState(createAtrac3DecoderState({ atrac3Flag: 0, bitrateKbps: 66, frameBytes: 192 })),
    {
      modeIndex: 10,
      bitrateKbps: 66,
      streamChannels: 1,
      frameBytes: 192,
      frameSamples: 1024,
      spectrumScratchLength: 1024,
      stepBytes: 96,
      streamLength: 196,
      stereoMix: {
        source: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
        target: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
      },
      transportModes: [ATRAC3_TRANSPORT_DIRECT, ATRAC3_TRANSPORT_DIRECT],
      workLengths: [1162, 1162],
      spectrumHistoryLengths: [
        [128, 128, 128, 128],
        [128, 128, 128, 128],
      ],
      activeGainTables: [
        [
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        ],
        [
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        ],
      ],
    }
  );

  assert.deepEqual(
    summarizeState(createAtrac3DecoderState({ atrac3Flag: 1, bitrateKbps: 132, frameBytes: 384 })),
    {
      modeIndex: 13,
      bitrateKbps: 132,
      streamChannels: 2,
      frameBytes: 384,
      frameSamples: 1024,
      spectrumScratchLength: 1024,
      stepBytes: 384,
      streamLength: 388,
      stereoMix: {
        source: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
        target: { unitMode: 4, pairScaleIndex: 0, gainSelectors: [3, 3, 3, 3] },
      },
      transportModes: [ATRAC3_TRANSPORT_DIRECT, ATRAC3_TRANSPORT_SWAPPED_TAIL],
      workLengths: [1162, 1162],
      spectrumHistoryLengths: [
        [128, 128, 128, 128],
        [128, 128, 128, 128],
      ],
      activeGainTables: [
        [
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        ],
        [
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
          { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
        ],
      ],
    }
  );
});

test("createAtrac3DecoderState prefers explicit channels when atrac3Flag is missing", () => {
  const mono = createAtrac3DecoderState({ channels: 1, bitrateKbps: 66, frameBytes: 192 });
  const stereo = createAtrac3DecoderState({ channels: 2, bitrateKbps: 132, frameBytes: 384 });

  assert.equal(mono.modeIndex, 10);
  assert.equal(mono.streamChannels, 1);
  assert.equal(mono.bitstream.stepBytes, 96);

  assert.equal(stereo.modeIndex, 13);
  assert.equal(stereo.streamChannels, 2);
  assert.equal(stereo.bitstream.stepBytes, 384);
});

test("createAtrac3DecoderState keeps staged gain tables isolated from active decode state", () => {
  const state = createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  const { active, staged } = state.primaryChannel.gainTables;

  assert.notStrictEqual(active, staged);
  assert.notStrictEqual(active[0], staged[0]);
  assert.notStrictEqual(active[0][0], staged[0][0]);
  assert.notStrictEqual(
    state.primaryChannel.spectrumHistory[0],
    state.primaryChannel.spectrumHistory[1]
  );

  active[0][0].gain = 1;
  active[0][0].start = 9;

  assert.deepEqual(staged[0][0], { start: 255, gain: 4 });
});

test("createAtrac3DecoderState prefers bitrate matches over frame-size matches", () => {
  const state = createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 384 });

  assert.equal(state.modeIndex, 2);
  assert.equal(state.bitrateKbps, 66);
  assert.equal(state.streamChannels, 2);
  assert.equal(state.frameBytes, 192);
});

test("createAtrac3DecoderState falls back to frame-size matches within the resolved layout", () => {
  const stereo = createAtrac3DecoderState({ atrac3Flag: 1, bitrateKbps: 999, frameBytes: 384 });
  const mono = createAtrac3DecoderState({ atrac3Flag: 0, bitrateKbps: 999, frameBytes: 192 });

  assert.equal(stereo.modeIndex, 13);
  assert.equal(stereo.bitrateKbps, 132);
  assert.equal(stereo.streamChannels, 2);
  assert.equal(stereo.frameBytes, 384);

  assert.equal(mono.modeIndex, 10);
  assert.equal(mono.bitrateKbps, 66);
  assert.equal(mono.streamChannels, 1);
  assert.equal(mono.frameBytes, 192);
});

test("createAtrac3DecoderState rejects unsupported decoder layouts", () => {
  assert.throws(
    () => createAtrac3DecoderState({ bitrateKbps: 999, frameBytes: 999 }),
    /unsupported ATRAC3 mode: mode=1 br=999 frameBytes=999/
  );
});

test("createAtrac3DecoderState exposes the authored primary and secondary channel pair", () => {
  const state = createAtrac3DecoderState({ bitrateKbps: 66, frameBytes: 192 });
  const channelStates = state.channelStates;

  assert.equal(channelStates, state.channelStates);
  assert.equal(channelStates.length, 2);
  assert.equal(channelStates[0], state.primaryChannel);
  assert.equal(channelStates[1], state.secondaryChannel);
  assert.equal(state.primaryChannel.transportMode, ATRAC3_TRANSPORT_DIRECT);
  assert.equal(state.secondaryChannel.transportMode, ATRAC3_TRANSPORT_SWAPPED_TAIL);
});

test("createAtrac3DecoderChannelState preserves channel-lane defaults", () => {
  const directChannel = createAtrac3DecoderChannelState(ATRAC3_TRANSPORT_DIRECT);
  const swappedTailChannel = createAtrac3DecoderChannelState(ATRAC3_TRANSPORT_SWAPPED_TAIL);

  assert.equal(directChannel.transportMode, ATRAC3_TRANSPORT_DIRECT);
  assert.equal(swappedTailChannel.transportMode, ATRAC3_TRANSPORT_SWAPPED_TAIL);
  assert.equal(directChannel.prevBlockCount, 0);
  assert.equal(directChannel.workF32.length, 1162);
  assert.deepEqual(
    directChannel.spectrumHistory.map((history) => history.length),
    [128, 128, 128, 128]
  );
  assert.deepEqual(summarizeGainTablePhase(directChannel.gainTables.active), [
    { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
    { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
    { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
    { length: 8, first: { start: 255, gain: 4 }, last: { start: 0, gain: 0 } },
  ]);
});

test("createAtrac3DecoderChannelState isolates active and staged gain ramps", () => {
  const channelState = createAtrac3DecoderChannelState(ATRAC3_TRANSPORT_DIRECT);
  const { active, staged } = channelState.gainTables;

  assert.notStrictEqual(active, staged);
  assert.notStrictEqual(active[0], staged[0]);
  assert.notStrictEqual(active[0][0], staged[0][0]);
  assert.notStrictEqual(channelState.spectrumHistory[0], channelState.spectrumHistory[1]);

  active[0][0].gain = 1;
  active[0][0].start = 9;

  assert.deepEqual(staged[0][0], { start: 255, gain: 4 });
});

test("createAtrac3StereoMixState preserves swapped-tail carry defaults", () => {
  const stereoMix = createAtrac3StereoMixState();

  assert.notStrictEqual(stereoMix.source, stereoMix.target);
  assert.notStrictEqual(stereoMix.source.gainSelectors, stereoMix.target.gainSelectors);
  assert.deepEqual(stereoMix.source, {
    unitMode: 4,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 3],
  });
  assert.deepEqual(stereoMix.target, {
    unitMode: 4,
    pairScaleIndex: 0,
    gainSelectors: [3, 3, 3, 3],
  });
});

test("createAtrac3FrameBitstreamState preserves authored frame sizing", () => {
  const bitstream = createAtrac3FrameBitstreamState(192, 96);

  assert.equal(bitstream.stepBytes, 96);
  assert.equal(bitstream.stream.length, 196);
  assert.strictEqual(bitstream.stream, bitstream.baseStream);
  assert.equal(bitstream.baseStream.length, 196);
  assert.equal(bitstream.swappedStream.length, 196);
  assert.notStrictEqual(bitstream.baseStream, bitstream.swappedStream);
  assert.equal(bitstream.bitpos, 0);
  assert.equal(bitstream.flags, 0);
});
