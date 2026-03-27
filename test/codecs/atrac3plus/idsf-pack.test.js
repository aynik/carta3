import assert from "node:assert/strict";
import test from "node:test";

import { at5PackStoreFromMsb } from "../../../src/atrac3plus/bitstream/bitstream.js";
import {
  calcNbitsForIdsfChAt5,
  packIdsfChannel,
} from "../../../src/atrac3plus/bitstream/idsf-internal.js";
import {
  AT5_IDSF_ERROR_CODES,
  createAt5IdsfChannelState,
  createAt5IdsfSharedState,
  unpackIdsf,
} from "../../../src/atrac3plus/bitstream/idsf.js";

function createPackChannel(values, { channelIndex = 0, bandCount, baseValues = null } = {}) {
  const shared = {
    idsfCount: values.length,
    bandCount: bandCount ?? Math.ceil(values.length / 3),
  };
  const channel = {
    channelIndex,
    shared,
    idsf: {
      values: Uint32Array.from(values),
    },
  };

  if (baseValues) {
    channel.block0 = {
      idsf: {
        values: Uint32Array.from(baseValues),
      },
    };
  }

  calcNbitsForIdsfChAt5(channel);
  return channel;
}

function roundtripIdsf(channel) {
  const frame = new Uint8Array(128);
  const packState = { bitpos: 0 };
  assert.equal(packIdsfChannel(channel, frame, packState), true);

  const shared = createAt5IdsfSharedState(channel.shared.idsfCount);
  let baseChannel = null;
  if ((channel.channelIndex | 0) !== 0) {
    baseChannel = createAt5IdsfChannelState(0, shared);
    baseChannel.idsf.values.set(channel.block0.idsf.values);
  }

  const unpacked = createAt5IdsfChannelState(channel.channelIndex, shared, baseChannel);
  const unpackState = { bitpos: 0 };
  assert.equal(unpackIdsf(unpacked, frame, unpackState, channel.idsfModeSelect), true);
  assert.equal(unpackState.bitpos, packState.bitpos);

  return { unpacked, bitpos: packState.bitpos >>> 0 };
}

function unpackDirectIdsf({ idsfCount, modeSelect, channelIndex = 0, baseValues = null, frame }) {
  const shared = createAt5IdsfSharedState(idsfCount);
  let baseChannel = null;
  if ((channelIndex | 0) !== 0 && baseValues) {
    baseChannel = createAt5IdsfChannelState(0, shared);
    baseChannel.idsf.values.set(baseValues);
  }

  const unpacked = createAt5IdsfChannelState(channelIndex, shared, baseChannel);
  const unpackState = { bitpos: 0 };
  const ok = unpackIdsf(unpacked, frame, unpackState, modeSelect);

  return { ok, unpacked, bitpos: unpackState.bitpos >>> 0 };
}

function packBits(fields) {
  const frame = new Uint8Array(16);
  const bitState = { bitpos: 0 };

  for (const [value, bitCount] of fields) {
    assert.equal(at5PackStoreFromMsb(value, bitCount, frame, bitState), true);
  }

  return { frame, bitpos: bitState.bitpos >>> 0 };
}

function unpackedValues(channel) {
  return Array.from(channel.idsf.values.slice(0, channel.shared.idsfCount));
}

test("packIdsfChannel round-trips primary mode 1 shape-coded payloads", () => {
  const channel = createPackChannel([37, 31, 43, 25, 24, 30, 25, 25]);
  assert.equal(channel.idsfModeSelect, 1);
  assert.equal(channel.idsf.mode2, 3);

  const { unpacked } = roundtripIdsf(channel);

  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
  assert.equal(unpacked.idsf.mode2, 3);
  assert.equal(unpacked.idsf.lead, channel.idsf.lead);
  assert.equal(unpacked.idsf.width, channel.idsf.width);
  assert.equal(unpacked.idsf.base, channel.idsf.base);
});

test("packIdsfChannel round-trips primary mode 1 direct payloads", () => {
  const channel = createPackChannel([31, 30, 31, 30, 31, 30]);
  assert.equal(channel.idsfModeSelect, 1);
  assert.equal(channel.idsf.mode2, 0);

  const { unpacked } = roundtripIdsf(channel);

  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
  assert.equal(unpacked.idsf.mode2, 0);
  assert.equal(unpacked.idsf.lead, channel.idsf.lead);
  assert.equal(unpacked.idsf.width, channel.idsf.width);
  assert.equal(unpacked.idsf.base, channel.idsf.base);
});

test("packIdsfChannel round-trips primary mode 2 shape-coded Huffman payloads", () => {
  const channel = createPackChannel([20, 20, 20, 23, 24, 20]);
  assert.equal(channel.idsfModeSelect, 2);

  const { unpacked } = roundtripIdsf(channel);

  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
  assert.equal(unpacked.idsf.mode, channel.idsf.mode);
  assert.equal(unpacked.idsf.baseValue, channel.idsf.baseValue);
  assert.equal(unpacked.idsf.cbIndex, channel.idsf.cbIndex);
});

test("packIdsfChannel round-trips primary mode 3 chained-delta payloads", () => {
  const channel = createPackChannel([39, 36, 34, 31, 39, 37, 32, 18]);
  assert.equal(channel.idsfModeSelect, 3);

  const { unpacked } = roundtripIdsf(channel);

  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
  assert.equal(unpacked.idsf.mode, channel.idsf.mode);
  assert.equal(unpacked.idsf.mode2, channel.idsf.mode2);
});

test("packIdsfChannel round-trips primary mode 3 shape-coded deltas", () => {
  const channel = createPackChannel([28, 24, 29, 24, 22, 27, 23, 23, 29, 21, 22]);
  assert.equal(channel.idsfModeSelect, 3);
  assert.equal(channel.idsf.mode2, 3);

  const { unpacked } = roundtripIdsf(channel);

  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
  assert.equal(unpacked.idsf.mode, channel.idsf.mode);
  assert.equal(unpacked.idsf.mode2, channel.idsf.mode2);
  assert.equal(unpacked.idsf.baseValue, channel.idsf.baseValue);
  assert.equal(unpacked.idsf.cbIndex, channel.idsf.cbIndex);
});

test("packIdsfChannel round-trips secondary chained-delta payloads against block0", () => {
  const channel = createPackChannel([21, 21, 21, 20, 20, 20], {
    channelIndex: 1,
    baseValues: [20, 20, 20, 20, 20, 20],
  });
  assert.equal(channel.idsfModeSelect, 2);

  const { unpacked } = roundtripIdsf(channel);

  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
  assert.equal(unpacked.idsf.mode, channel.idsf.mode);
});

test("packIdsfChannel round-trips secondary absolute-delta payloads against block0", () => {
  const channel = createPackChannel([19, 19, 19, 20, 19, 20], {
    channelIndex: 1,
    baseValues: [20, 20, 20, 20, 20, 20],
  });
  assert.equal(channel.idsfModeSelect, 1);

  const { unpacked } = roundtripIdsf(channel);

  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
  assert.equal(unpacked.idsf.mode, channel.idsf.mode);
});

test("unpackIdsf rejects width values above 6 in primary mode-1 direct payloads", () => {
  const { frame } = packBits([
    [0, 2],
    [0, 5],
    [7, 3],
  ]);

  const { ok, unpacked } = unpackDirectIdsf({
    idsfCount: 3,
    modeSelect: 1,
    frame,
  });

  assert.equal(ok, false);
  assert.equal(unpacked.blockErrorCode, AT5_IDSF_ERROR_CODES.WIDTH_TOO_LARGE);
});

test("unpackIdsf rejects oversized shape leads in primary mode-1 payloads", () => {
  const { frame } = packBits([
    [3, 2],
    [20, 6],
    [0, 6],
    [4, 5],
  ]);

  const { ok, unpacked } = unpackDirectIdsf({
    idsfCount: 3,
    modeSelect: 1,
    frame,
  });

  assert.equal(ok, false);
  assert.equal(unpacked.blockErrorCode, AT5_IDSF_ERROR_CODES.BAD_LEAD_MODE2_3);
});

test("packIdsfChannel keeps secondary copy mode as a zero-bit payload", () => {
  const channel = createPackChannel([20, 20, 20, 20, 20, 20], {
    channelIndex: 1,
    baseValues: [20, 20, 20, 20, 20, 20],
  });
  assert.equal(channel.idsfModeSelect, 3);

  const { unpacked, bitpos } = roundtripIdsf(channel);

  assert.equal(bitpos, 0);
  assert.deepEqual(unpackedValues(unpacked), unpackedValues(channel));
});
