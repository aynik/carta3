import assert from "node:assert/strict";
import test from "node:test";

import {
  AT3_DEC_MAX_UNITS,
  AT3_DEC_NEUTRAL_GAIN,
  AT3_DEC_PAIR_ENTRIES_PER_UNIT,
  AT3_DEC_PAIR_SENTINEL_START,
  AT3_DEC_SPECTRUM_FLOATS_PER_UNIT,
  ATRAC3_FRAME_SAMPLES,
  ATRAC3_RESIDUAL_DELAY_SAMPLES,
  AT3_DEC_WORK_FLOATS,
} from "../../../src/atrac3/constants.js";
import {
  AT3_DEC_FLAG_ERROR,
  AT3_SPCODE_ERROR_FLAG,
  openAtrac3ChannelTransport,
  peekAtrac3Bits,
  readAtrac3Bits,
} from "../../../src/atrac3/decode-channel-transport.js";
import { decodeSpcode } from "../../../src/atrac3/decode-channel-spcode.js";
import {
  decodeAtrac3ChannelPayload,
  decodeAtrac3ChannelTransport,
  stageAtrac3GainPairTables,
} from "../../../src/atrac3/decode-channel.js";
import { decodeAtrac3TonePasses } from "../../../src/atrac3/decode-channel-tone.js";
import { rebuildAtrac3ChannelWorkArea } from "../../../src/atrac3/decode-rebuild.js";
import { applyAtrac3BlockTransform } from "../../../src/atrac3/decode-rebuild-block.js";
import { createAtrac3DecoderState } from "../../../src/atrac3/decoder-state.js";
import {
  ATRAC3_TRANSPORT_DIRECT,
  ATRAC3_TRANSPORT_SWAPPED_TAIL,
} from "../../../src/atrac3/profiles.js";
import { parseAtracWavBuffer } from "../../../src/container/index.js";
import { encodeAtrac3WavBufferFromInterleavedPcm } from "../../../src/encoders/atrac3.js";

const PATTERNED_SPECTRUM_SEED = [7, -3, 12, -9, 4, 15, -11, 6, -2, 8, -5, 14, -7, 10, -13, 1];

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

function stageFrameBitstream(state, frame) {
  state.bitstream.stream.fill(0);
  state.bitstream.stream.set(frame, 0);
  state.bitstream.flags = 0;
}

function createGainTablePhase() {
  return Array.from({ length: AT3_DEC_MAX_UNITS }, () =>
    Array.from({ length: AT3_DEC_PAIR_ENTRIES_PER_UNIT }, (_, pairIndex) => ({
      start: pairIndex === 0 ? AT3_DEC_PAIR_SENTINEL_START : 0,
      gain: pairIndex === 0 ? AT3_DEC_NEUTRAL_GAIN : 0,
    }))
  );
}

function createChannelState() {
  return {
    prevBlockCount: 0,
    workF32: new Float32Array(AT3_DEC_WORK_FLOATS),
    spectrumHistory: Array.from(
      { length: AT3_DEC_MAX_UNITS },
      () => new Float32Array(AT3_DEC_SPECTRUM_FLOATS_PER_UNIT)
    ),
    gainTables: {
      active: createGainTablePhase(),
      staged: createGainTablePhase(),
    },
  };
}

function createPatternedSpectrum() {
  return Float32Array.from(
    { length: 256 },
    (_, index) =>
      PATTERNED_SPECTRUM_SEED[index % PATTERNED_SPECTRUM_SEED.length] * ((index % 5) + 1)
  );
}

function runBlockTransformCase({
  blockIndex = 0,
  gainIndex = 3,
  pairEntries = [],
  spectra = null,
} = {}) {
  const state = createAtrac3DecoderState({ bitrateKbps: 132, frameBytes: 384 });
  const channelState = state.primaryChannel;
  const spectrumBuffer = spectra ? new Float32Array(spectra) : new Float32Array(256);

  channelState.spectrumHistory[blockIndex].fill(1);
  for (const [entryIndex, entry] of pairEntries.entries()) {
    channelState.gainTables.active[blockIndex][entryIndex] = entry;
  }

  applyAtrac3BlockTransform(spectrumBuffer, 0, blockIndex, gainIndex, channelState);
  return { channelState, spectra: spectrumBuffer };
}

function readWorkBlockValues(channelState, blockIndex, count) {
  const base = ATRAC3_RESIDUAL_DELAY_SAMPLES + blockIndex;
  return Array.from({ length: count }, (_, index) => channelState.workF32[base + index * 4]);
}

function normalizeSignedZero(values) {
  return values.map((value) => (Object.is(value, -0) ? 0 : value));
}

function roundSnapshot(values) {
  return values.map((value) => Number(value.toFixed(6)));
}

function packBits(fields) {
  const bitCount = fields.reduce((total, [, width]) => total + width, 0);
  const stream = new Uint8Array(Math.ceil(bitCount / 8) + 2);
  let bitOffset = 0;

  for (const [value, width] of fields) {
    for (let shift = width - 1; shift >= 0; shift -= 1, bitOffset += 1) {
      stream[bitOffset >>> 3] |= ((value >>> shift) & 1) << (7 - (bitOffset & 7));
    }
  }

  return stream;
}

function createTransportBitstream(stream, stepBytes, bitpos = 0) {
  return {
    stepBytes,
    bitpos,
    stream: Uint8Array.from(stream),
  };
}

function createSpcodeState(stream, bitpos = 0) {
  return {
    bitstream: {
      flags: 0,
      bitpos,
      stream: Uint8Array.from(stream),
    },
  };
}

test("ATRAC3 bit readers preserve cross-byte peeks and cursor advancement", () => {
  const bitstream = createTransportBitstream([0xaa, 0x55, 0xf0], 3);

  assert.equal(peekAtrac3Bits(bitstream.stream, 0, 4), 0xa);
  assert.equal(readAtrac3Bits(bitstream, 4), 0xa);
  assert.equal(bitstream.bitpos, 4);
  assert.equal(readAtrac3Bits(bitstream, 8), 0xa5);
  assert.equal(bitstream.bitpos, 12);
  assert.equal(readAtrac3Bits(bitstream, 4), 0x5);
  assert.equal(bitstream.bitpos, 16);
});

test("ATRAC3 bit readers support wide bitfield windows", () => {
  const stream = packBits([
    [0x5, 3],
    [0x1ffff, 17],
    [0x2aaaa, 18],
    [0xffffffff, 32],
  ]);
  const bitstream = createTransportBitstream(stream, stream.length, 0);

  assert.equal(readAtrac3Bits(bitstream, 3), 0x5);
  assert.equal(readAtrac3Bits(bitstream, 17), 0x1ffff);
  assert.equal(peekAtrac3Bits(bitstream.stream, bitstream.bitpos, 18), 0x2aaaa);
  assert.equal(readAtrac3Bits(bitstream, 18), 0x2aaaa);
  assert.equal(readAtrac3Bits(bitstream, 32), 0xffffffff);
  assert.equal(bitstream.bitpos, 70);
});

test("ATRAC3 bit readers flag buffer overruns instead of silently zero-padding", () => {
  const bitstream = createTransportBitstream([0xff], 1, 7);
  bitstream.flags = 0;
  bitstream.bitLimit = 8;

  assert.equal(readAtrac3Bits(bitstream, 2), 0);
  assert.ok((bitstream.flags & AT3_DEC_FLAG_ERROR) !== 0);
});

test("openAtrac3ChannelTransport preserves primary-slot stride math", () => {
  const bitstream = createTransportBitstream([0xa2, 1, 2, 3, 0xa1, 4, 5, 6], 4);
  const transport = openAtrac3ChannelTransport(bitstream, 1, ATRAC3_TRANSPORT_DIRECT);

  assert.equal(bitstream.bitpos, 40);
  assert.deepEqual(transport, {
    headerByte: 0xa1,
    bitLimit: 80,
    headerIsValid: true,
  });
});

test("openAtrac3ChannelTransport preserves swapped-tail reversal and padding trim", () => {
  const bitstream = createTransportBitstream([0x0c, 0x00, 0xf8, 0xf8], 4);
  const originalStream = bitstream.stream;
  const transport = openAtrac3ChannelTransport(bitstream, 0, ATRAC3_TRANSPORT_SWAPPED_TAIL);

  assert.equal(bitstream.bitpos, 16);
  assert.deepEqual(Array.from(originalStream), [0x0c, 0x00, 0xf8, 0xf8]);
  assert.deepEqual(Array.from(bitstream.stream.slice(0, 4)), [0x00, 0x0c, 0xf8, 0xf8]);
  assert.deepEqual(transport, {
    headerByte: 0x0c,
    bitLimit: 32,
    headerIsValid: true,
  });
});

test("openAtrac3ChannelTransport preserves swapped-tail payload sizing from the current cursor", () => {
  const bitstream = createTransportBitstream([0x99, 0x0c, 0x55, 0xf8], 4, 8);
  const originalStream = bitstream.stream;
  const transport = openAtrac3ChannelTransport(bitstream, 0, ATRAC3_TRANSPORT_SWAPPED_TAIL);

  assert.equal(bitstream.bitpos, 16);
  assert.deepEqual(Array.from(originalStream), [0x99, 0x0c, 0x55, 0xf8]);
  assert.deepEqual(Array.from(bitstream.stream.slice(0, 4)), [0x55, 0x0c, 0x99, 0xf8]);
  assert.deepEqual(transport, {
    headerByte: 0x0c,
    bitLimit: 32,
    headerIsValid: true,
  });
});

test("openAtrac3ChannelTransport flags invalid primary headers without changing slot math", () => {
  const bitstream = createTransportBitstream([0x80, 1, 2, 3, 0xa1, 4, 5, 6], 4);
  const transport = openAtrac3ChannelTransport(bitstream, 0, ATRAC3_TRANSPORT_DIRECT);

  assert.equal(bitstream.bitpos, 8);
  assert.equal(transport.headerByte, 0x80);
  assert.equal(transport.bitLimit, 48);
  assert.equal(transport.headerIsValid, false);
});

test("decodeSpcode preserves current pair decoding behavior for index 0", () => {
  const state = createSpcodeState([0xff, 0xff, 0xff, 0xff]);
  const out = new Float32Array(8);

  decodeSpcode(state, 0, 0, 1, out, 0, 8);

  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 20);
  assert.deepEqual(Array.from(out), [-3255, -3255, -3255, -3255, -3255, -3255, -3255, -3255]);
});

test("decodeSpcode preserves current scalar decoding for multiple table selections", () => {
  const mainState = createSpcodeState([0xff, 0xff, 0xff, 0xff]);
  const mainOut = new Float32Array(8);
  decodeSpcode(mainState, 0, 1, 1, mainOut, 0, 4);

  assert.equal(mainState.bitstream.flags, 0);
  assert.equal(mainState.bitstream.bitpos, 12);
  assert.deepEqual(Array.from(mainOut), [-3906, -3906, -3906, -3906, 0, 0, 0, 0]);

  const altState = createSpcodeState([0xaa, 0x55, 0xf0, 0x0f], 5);
  const altOut = new Float32Array(6);
  decodeSpcode(altState, 1, 2, 2, altOut, 1, 5);

  assert.equal(altState.bitstream.flags, 0);
  assert.equal(altState.bitstream.bitpos, 17);
  assert.deepEqual(Array.from(altOut), [0, 5580, 5580, -8370, 8370, 0]);
});

test("decodeSpcode marks the error flag for invalid field indices", () => {
  const state = createSpcodeState([0, 0]);
  const out = new Float32Array(4);

  decodeSpcode(state, 0, 99, 1, out, 0, 2);

  assert.equal(state.bitstream.flags, AT3_SPCODE_ERROR_FLAG);
  assert.deepEqual(Array.from(out), [0, 0, 0, 0]);
});

test("decodeSpcode preserves the current invalid alt-pair rejection without advancing the cursor", () => {
  const state = createSpcodeState([0x20, 0x00]);
  const out = new Float32Array(8);

  decodeSpcode(state, 1, 0, 1, out, 0, 8);

  assert.equal(state.bitstream.flags, AT3_SPCODE_ERROR_FLAG);
  assert.equal(state.bitstream.bitpos, 0);
  assert.deepEqual(Array.from(out), new Array(8).fill(0));
});

function createPayloadState(fields) {
  return {
    bitstream: {
      flags: 0,
      bitpos: 0,
      stream: packBits(fields),
    },
  };
}

function createFramePairTables() {
  return Array.from({ length: AT3_DEC_MAX_UNITS }, () =>
    Array.from({ length: 8 }, () => ({ start: 0, gain: 0 }))
  );
}

test("applyAtrac3BlockTransform preserves the neutral pair-table gain path", () => {
  const { channelState } = runBlockTransformCase();

  assert.deepEqual(readWorkBlockValues(channelState, 0, 24), new Array(24).fill(1));
  assert.deepEqual(
    normalizeSignedZero(Array.from(channelState.spectrumHistory[0].slice(0, 16))),
    new Array(16).fill(0)
  );
});

test("applyAtrac3BlockTransform preserves constant and transition gain regions", () => {
  const { channelState } = runBlockTransformCase({
    pairEntries: [
      { start: 8, gain: 0 },
      { start: 255, gain: 4 },
    ],
  });

  assert.deepEqual(
    readWorkBlockValues(channelState, 0, 24),
    [
      16, 16, 16, 16, 16, 16, 16, 16, 16, 11.313708305358887, 8, 5.656854152679443, 4,
      2.8284270763397217, 2, 1.4142135381698608, 1, 1, 1, 1, 1, 1, 1, 1,
    ]
  );
});

test("applyAtrac3BlockTransform preserves the even-block mirror and twiddle stages", () => {
  const { spectra } = runBlockTransformCase({ spectra: createPatternedSpectrum() });

  assert.deepEqual(
    roundSnapshot(Array.from(spectra.slice(0, 24))),
    [
      -148283.65625, 149109.84375, 98483.773438, 98501.203125, 695.682434, -1387.737427, -48.123814,
      -1741.762573, 646.30249, -824.470276, 178.520752, 1004.222229, 2758.993164, -3663.938232,
      1021.259888, 415.596497, 223.37706, -108.708366, 22.580812, 90.171997, 62.130184, -46.378147,
      -7.846264, 129.18866,
    ]
  );
});

test("applyAtrac3BlockTransform preserves the odd-block mirror swap and twiddle stages", () => {
  const { spectra } = runBlockTransformCase({
    blockIndex: 1,
    spectra: createPatternedSpectrum(),
  });

  assert.deepEqual(
    roundSnapshot(Array.from(spectra.slice(0, 24))),
    [
      134802.796875, -134013.15625, -87206.742188, -87263, -78.579117, -1688.130493, 642.744141,
      -1387.879272, 2949.007568, -3907.624756, 1034.510864, 298.501373, 426.622986, -697.406067,
      242.186646, 970.791199, 459.795715, -455.419952, -168.736603, -226.683441, -133.732269,
      -20.501263, 14.606601, -15.459553,
    ]
  );
});

test("decodeAtrac3ChannelTransport preserves primary and swapped-tail secondary lane rebuild", () => {
  const container = createAtrac3Container();
  const state = createAtrac3DecoderState(container);
  const initialGainTables = [state.primaryChannel, state.secondaryChannel].map((channel) => ({
    active: channel.gainTables.active,
    staged: channel.gainTables.staged,
  }));
  stageFrameBitstream(state, container.frames[0]);

  const primaryUnitMode = decodeAtrac3ChannelTransport(state, state.primaryChannel, 0);
  const secondaryUnitMode = decodeAtrac3ChannelTransport(state, state.secondaryChannel, 1);

  assert.equal(primaryUnitMode, 2);
  assert.equal(secondaryUnitMode, 0);
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.primaryChannel.prevBlockCount, 3);
  assert.equal(state.secondaryChannel.prevBlockCount, 1);
  assert.equal(state.primaryChannel.gainTables.active, initialGainTables[0].staged);
  assert.equal(state.primaryChannel.gainTables.staged, initialGainTables[0].active);
  assert.equal(state.secondaryChannel.gainTables.active, initialGainTables[1].staged);
  assert.equal(state.secondaryChannel.gainTables.staged, initialGainTables[1].active);
});

test("decodeAtrac3ChannelTransport preserves the direct secondary rebuild path at 105 kbps", () => {
  const container = createAtrac3Container(1024 * 4, 105);
  const state = createAtrac3DecoderState(container);
  stageFrameBitstream(state, container.frames[0]);

  const primaryUnitMode = decodeAtrac3ChannelTransport(state, state.primaryChannel, 0);
  const secondaryUnitMode = decodeAtrac3ChannelTransport(state, state.secondaryChannel, 1);

  assert.equal(primaryUnitMode, 2);
  assert.equal(secondaryUnitMode, 2);
  assert.equal(state.bitstream.flags, 0);
  assert.deepEqual(
    [state.primaryChannel.prevBlockCount, state.secondaryChannel.prevBlockCount],
    [3, 3]
  );
});

test("decodeAtrac3ChannelTransport preserves the sticky invalid-header failure path", () => {
  const container = createAtrac3Container();
  const state = createAtrac3DecoderState(container);
  const corruptedFrame = new Uint8Array(container.frames[0]);
  corruptedFrame[0] = 0;
  stageFrameBitstream(state, corruptedFrame);

  const unitMode = decodeAtrac3ChannelTransport(state, state.primaryChannel, 0);

  assert.equal(unitMode, 0);
  assert.equal(state.bitstream.flags, AT3_DEC_FLAG_ERROR);
  assert.equal(state.primaryChannel.prevBlockCount, 0);
});

test("rebuildAtrac3ChannelWorkArea rotates staged gain tables and clears inactive blocks", () => {
  const channelState = createChannelState();
  const spectrumScratch = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const originalActiveTables = channelState.gainTables.active;
  const originalStagedTables = channelState.gainTables.staged;

  channelState.spectrumHistory[1].fill(5);
  channelState.spectrumHistory[2].fill(6);
  channelState.spectrumHistory[3].fill(7);
  for (let block = 1; block < AT3_DEC_MAX_UNITS; block += 1) {
    for (
      let index = block;
      index < ATRAC3_FRAME_SAMPLES - ATRAC3_RESIDUAL_DELAY_SAMPLES;
      index += 4
    ) {
      channelState.workF32[ATRAC3_RESIDUAL_DELAY_SAMPLES + index] = 99;
    }
  }
  for (let index = 0; index < ATRAC3_RESIDUAL_DELAY_SAMPLES; index += 1) {
    channelState.workF32[ATRAC3_FRAME_SAMPLES + index] = index + 1;
  }

  rebuildAtrac3ChannelWorkArea(channelState, spectrumScratch, 1);

  assert.equal(channelState.prevBlockCount, 1);
  assert.equal(channelState.gainTables.active, originalStagedTables);
  assert.equal(channelState.gainTables.staged, originalActiveTables);
  assert.deepEqual(
    Array.from(channelState.workF32.slice(0, ATRAC3_RESIDUAL_DELAY_SAMPLES)),
    Array.from({ length: ATRAC3_RESIDUAL_DELAY_SAMPLES }, (_, index) => index + 1)
  );
  for (let block = 1; block < AT3_DEC_MAX_UNITS; block += 1) {
    assert.deepEqual(Array.from(channelState.spectrumHistory[block]), new Array(0x80).fill(0));
    const lane = [];
    for (let index = block; index < ATRAC3_FRAME_SAMPLES; index += 4) {
      lane.push(channelState.workF32[ATRAC3_RESIDUAL_DELAY_SAMPLES + index]);
    }
    assert(lane.every((sample) => sample === 0));
  }
});

test("rebuildAtrac3ChannelWorkArea preserves previously active blocks while the count shrinks", () => {
  const channelState = createChannelState();
  const spectrumScratch = new Float32Array(ATRAC3_FRAME_SAMPLES);

  channelState.prevBlockCount = 2;
  channelState.spectrumHistory[1].fill(1);

  rebuildAtrac3ChannelWorkArea(channelState, spectrumScratch, 1);

  const rebuiltLane = [];
  for (let index = 1; index < ATRAC3_FRAME_SAMPLES; index += 4) {
    rebuiltLane.push(channelState.workF32[ATRAC3_RESIDUAL_DELAY_SAMPLES + index]);
  }
  const clearedLane = [];
  for (let index = 2; index < ATRAC3_FRAME_SAMPLES; index += 4) {
    clearedLane.push(channelState.workF32[ATRAC3_RESIDUAL_DELAY_SAMPLES + index]);
  }

  assert.equal(channelState.prevBlockCount, 1);
  assert(rebuiltLane.some((sample) => sample !== 0));
  assert(clearedLane.every((sample) => sample === 0));
});

test("rebuildAtrac3ChannelWorkArea carries the previous lead block across an empty current span", () => {
  const channelState = createChannelState();
  const spectrumScratch = new Float32Array(ATRAC3_FRAME_SAMPLES);

  channelState.prevBlockCount = 1;
  channelState.spectrumHistory[0].fill(1);
  channelState.spectrumHistory[1].fill(1);
  for (let index = 0; index < ATRAC3_RESIDUAL_DELAY_SAMPLES; index += 1) {
    channelState.workF32[ATRAC3_FRAME_SAMPLES + index] = index + 1;
  }

  rebuildAtrac3ChannelWorkArea(channelState, spectrumScratch, 0);

  assert.equal(channelState.prevBlockCount, 0);
  assert.deepEqual(
    Array.from(channelState.spectrumHistory[1]),
    new Array(AT3_DEC_SPECTRUM_FLOATS_PER_UNIT).fill(0)
  );
  assert.deepEqual(
    Array.from(channelState.workF32.slice(0, ATRAC3_RESIDUAL_DELAY_SAMPLES)),
    Array.from({ length: ATRAC3_RESIDUAL_DELAY_SAMPLES }, (_, index) => index + 1)
  );

  const rebuiltLane = [];
  for (let index = 0; index < ATRAC3_FRAME_SAMPLES; index += 4) {
    rebuiltLane.push(channelState.workF32[ATRAC3_RESIDUAL_DELAY_SAMPLES + index]);
  }
  const clearedLane = [];
  for (let index = 1; index < ATRAC3_FRAME_SAMPLES; index += 4) {
    clearedLane.push(channelState.workF32[ATRAC3_RESIDUAL_DELAY_SAMPLES + index]);
  }

  assert(rebuiltLane.some((sample) => sample !== 0));
  assert(clearedLane.every((sample) => sample === 0));
});

test("decodeAtrac3TonePasses preserves current tone pass output before grouped spcodes", () => {
  const state = createPayloadState([
    [1, 5],
    [0, 2],
    [1, 1],
    [0, 3],
    [2, 3],
    [1, 3],
    [15, 6],
    [0, 6],
    [7, 3],
    [0, 3],
    [0, 3],
    [0, 3],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);

  const maxCoeffIndex = decodeAtrac3TonePasses(state, 1, spectrum);

  assert.equal(maxCoeffIndex, 1);
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 41);
  assert.deepEqual(Array.from(spectrum.slice(0, 8)), [-3906, 0, 0, 0, 0, 0, 0, 0]);
});

test("decodeAtrac3ChannelPayload preserves the empty grouped baseline path", () => {
  const state = createPayloadState([
    [0, 3],
    [0, 5],
    [0, 5],
    [0, 1],
    [0, 3],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const framePairTables = createFramePairTables();

  const payload = decodeAtrac3ChannelPayload(state, 0, spectrum, framePairTables);

  assert.deepEqual(payload, {
    pairTableBlockCount: 0,
    spectrumBlockCount: 1,
    decodedBlockCount: 1,
  });
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 17);
  assert.deepEqual(
    framePairTables.map((pairTable) => pairTable[0]),
    [
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
    ]
  );
  assert.deepEqual(Array.from(spectrum.slice(0, 16)), new Array(16).fill(0));
});

test("decodeAtrac3ChannelPayload preserves tone pass output before grouped spcodes", () => {
  const state = createPayloadState([
    [0, 3],
    [1, 5],
    [0, 2],
    [1, 1],
    [0, 3],
    [2, 3],
    [1, 3],
    [15, 6],
    [0, 6],
    [7, 3],
    [0, 3],
    [0, 3],
    [0, 3],
    [0, 5],
    [0, 1],
    [1, 3],
    [15, 6],
    [31, 5],
    [31, 5],
    [31, 5],
    [31, 5],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const framePairTables = createFramePairTables();

  const payload = decodeAtrac3ChannelPayload(state, 0, spectrum, framePairTables);

  assert.deepEqual(payload, {
    pairTableBlockCount: 0,
    spectrumBlockCount: 1,
    decodedBlockCount: 1,
  });
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 79);
  assert.deepEqual(
    Array.from(spectrum.slice(0, 8)),
    [-7161, -3255, -3255, -3255, -3255, -3255, -3255, -3255]
  );
});

test("decodeAtrac3TonePasses consumes dynamic table selectors even for inactive passes", () => {
  const state = createPayloadState([
    [2, 5],
    [3, 2],
    [0, 1],
    [0, 3],
    [2, 3],
    [1, 1],
    [1, 1],
    [0, 3],
    [2, 3],
    [0, 1],
    [1, 3],
    [15, 6],
    [0, 6],
    [7, 3],
    [0, 3],
    [0, 3],
    [0, 3],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);

  const maxCoeffIndex = decodeAtrac3TonePasses(state, 1, spectrum);

  assert.equal(maxCoeffIndex, 1);
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 50);
  assert.deepEqual(Array.from(spectrum.slice(0, 8)), [-3906, 0, 0, 0, 0, 0, 0, 0]);
});

test("decodeAtrac3ChannelPayload consumes dynamic tone selectors even for inactive passes", () => {
  const state = createPayloadState([
    [0, 3],
    [2, 5],
    [3, 2],
    [0, 1],
    [0, 3],
    [2, 3],
    [1, 1],
    [1, 1],
    [0, 3],
    [2, 3],
    [0, 1],
    [1, 3],
    [15, 6],
    [0, 6],
    [7, 3],
    [0, 3],
    [0, 3],
    [0, 3],
    [0, 5],
    [0, 1],
    [1, 3],
    [15, 6],
    [31, 5],
    [31, 5],
    [31, 5],
    [31, 5],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const framePairTables = createFramePairTables();

  const payload = decodeAtrac3ChannelPayload(state, 0, spectrum, framePairTables);

  assert.deepEqual(payload, {
    pairTableBlockCount: 0,
    spectrumBlockCount: 1,
    decodedBlockCount: 1,
  });
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 88);
  assert.deepEqual(
    Array.from(spectrum.slice(0, 8)),
    [-7161, -3255, -3255, -3255, -3255, -3255, -3255, -3255]
  );
});

test("decodeAtrac3TonePasses preserves the current invalid pass-mode fallback", () => {
  const state = createPayloadState([
    [1, 5],
    [2, 2],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);

  const maxCoeffIndex = decodeAtrac3TonePasses(state, 1, spectrum);

  assert.equal(maxCoeffIndex, 0);
  assert.equal(state.bitstream.flags, AT3_DEC_FLAG_ERROR);
  assert.equal(state.bitstream.bitpos, 7);
  assert.deepEqual(Array.from(spectrum.slice(0, 8)), new Array(8).fill(0));
});

test("decodeAtrac3ChannelPayload preserves grouped decoding after an invalid tone pass mode", () => {
  const state = createPayloadState([
    [0, 3],
    [1, 5],
    [2, 2],
    [0, 5],
    [0, 1],
    [1, 3],
    [15, 6],
    [31, 5],
    [31, 5],
    [31, 5],
    [31, 5],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const framePairTables = createFramePairTables();

  const payload = decodeAtrac3ChannelPayload(state, 0, spectrum, framePairTables);

  assert.deepEqual(payload, {
    pairTableBlockCount: 0,
    spectrumBlockCount: 1,
    decodedBlockCount: 1,
  });
  assert.equal(state.bitstream.flags, AT3_DEC_FLAG_ERROR);
  assert.equal(state.bitstream.bitpos, 45);
  assert.deepEqual(
    Array.from(spectrum.slice(0, 8)),
    [-3255, -3255, -3255, -3255, -3255, -3255, -3255, -3255]
  );
});

test("decodeAtrac3TonePasses aborts on invalid tone spcode selectors", () => {
  const state = createPayloadState([
    [1, 5],
    [0, 2],
    [1, 1],
    [0, 3],
    [1, 3],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);

  const maxCoeffIndex = decodeAtrac3TonePasses(state, 1, spectrum);

  assert.equal(maxCoeffIndex, null);
  assert.equal(state.bitstream.flags, AT3_DEC_FLAG_ERROR);
  assert.equal(state.bitstream.bitpos, 14);
  assert.deepEqual(Array.from(spectrum.slice(0, 8)), new Array(8).fill(0));
});

test("decodeAtrac3ChannelPayload aborts before grouped decoding on invalid tone spcode selectors", () => {
  const state = createPayloadState([
    [0, 3],
    [1, 5],
    [0, 2],
    [1, 1],
    [0, 3],
    [1, 3],
    [0, 5],
    [0, 1],
    [1, 3],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const framePairTables = createFramePairTables();

  const payload = decodeAtrac3ChannelPayload(state, 0, spectrum, framePairTables);

  assert.deepEqual(payload, {
    pairTableBlockCount: 0,
    spectrumBlockCount: 0,
    decodedBlockCount: 0,
  });
  assert.equal(state.bitstream.flags, AT3_DEC_FLAG_ERROR);
  assert.equal(state.bitstream.bitpos, 17);
  assert.deepEqual(
    framePairTables.map((pairTable) => pairTable[0]),
    [
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
    ]
  );
  assert.deepEqual(Array.from(spectrum.slice(0, 16)), new Array(16).fill(0));
});

test("stageAtrac3GainPairTables stages active units and neutral sentinels for the rest", () => {
  const state = createPayloadState([
    [1, 3],
    [2, 4],
    [3, 5],
    [0, 3],
  ]);
  const framePairTables = createFramePairTables();

  const stagedBlockCount = stageAtrac3GainPairTables(state, framePairTables, 2);

  assert.equal(stagedBlockCount, 1);
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 15);
  assert.deepEqual(framePairTables[0].slice(0, 2), [
    { start: 24, gain: 2 },
    { start: 0xff, gain: 4 },
  ]);
  assert.deepEqual(
    framePairTables.slice(1).map((pairTable) => pairTable[0]),
    [
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
    ]
  );
});

test("stageAtrac3GainPairTables keeps the inactive tail neutral when no units are active", () => {
  const state = createPayloadState([
    [7, 3],
    [31, 5],
  ]);
  const framePairTables = createFramePairTables();

  const stagedBlockCount = stageAtrac3GainPairTables(state, framePairTables, 0);

  assert.equal(stagedBlockCount, 0);
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 0);
  assert.deepEqual(
    framePairTables.map((pairTable) => pairTable[0]),
    [
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
      { start: 0xff, gain: 4 },
    ]
  );
});

test("stageAtrac3GainPairTables preserves ordering errors while leaving the sentinel in place", () => {
  const state = createPayloadState([
    [2, 3],
    [1, 4],
    [2, 5],
    [3, 4],
    [1, 5],
  ]);
  const framePairTables = createFramePairTables();

  const stagedBlockCount = stageAtrac3GainPairTables(state, framePairTables, 1);

  assert.equal(stagedBlockCount, 1);
  assert.equal(state.bitstream.flags, AT3_DEC_FLAG_ERROR);
  assert.equal(state.bitstream.bitpos, 21);
  assert.deepEqual(framePairTables[0].slice(0, 3), [
    { start: 16, gain: 1 },
    { start: 0, gain: 0 },
    { start: 0xff, gain: 4 },
  ]);
});

test("decodeAtrac3ChannelPayload keeps pair-table coverage explicit when it spans farther than spectrum", () => {
  const state = createPayloadState([
    [0, 3],
    [1, 3],
    [0, 4],
    [1, 5],
    [0, 5],
    [0, 5],
    [0, 1],
    [0, 3],
  ]);
  const spectrum = new Float32Array(ATRAC3_FRAME_SAMPLES);
  const framePairTables = createFramePairTables();

  const payload = decodeAtrac3ChannelPayload(state, 1, spectrum, framePairTables);

  assert.deepEqual(payload, {
    pairTableBlockCount: 2,
    spectrumBlockCount: 1,
    decodedBlockCount: 2,
  });
  assert.equal(state.bitstream.flags, 0);
  assert.equal(state.bitstream.bitpos, 29);
  assert.deepEqual(framePairTables[1].slice(0, 2), [
    { start: 8, gain: 0 },
    { start: 0xff, gain: 4 },
  ]);
});
