import assert from "node:assert/strict";
import test from "node:test";

import { packIdwlChannel } from "../../../src/atrac3plus/bitstream/idwl-internal.js";
import { at5PackStoreFromMsb } from "../../../src/atrac3plus/bitstream/bitstream.js";
import {
  AT5_IDWL_ERROR_CODES,
  createAt5IdwlChannelState,
  createAt5IdwlSharedState,
  unpackIdwl,
} from "../../../src/atrac3plus/bitstream/idwl.js";
import {
  AT5_SG_SHAPE_INDEX,
  AT5_WLC_COEF,
  AT5_WLC_SG_CB,
} from "../../../src/atrac3plus/tables/unpack.js";

function idwlShapeValueMod8(index, count, base, shift) {
  if ((count | 0) <= 0) {
    return 0;
  }

  const shapeIndex = AT5_SG_SHAPE_INDEX[count - 1] | 0;
  const shapeCount = (shapeIndex + 1) | 0;
  const shapeSlot = AT5_SG_SHAPE_INDEX[index] | 0;
  if (shapeSlot <= 0 || shapeSlot >= shapeCount) {
    return base & 0x7;
  }

  const tableOffset = ((base | 0) * 144 + (shift | 0) * 9 + shapeSlot - 1) | 0;
  return (base - (AT5_WLC_SG_CB[tableOffset] | 0)) & 0x7;
}

function idwlWlcCoefficients(channelIndex, wlc, count) {
  const offset = ((wlc | 0) + (channelIndex | 0) * 3 - 1) * 32;
  return Array.from(AT5_WLC_COEF.slice(offset, offset + count));
}

function createPackIdwlChannel({
  bandLimit,
  channelIndex = 0,
  packMode,
  values,
  baseValues = null,
  pairFlags = null,
  idwl = {},
}) {
  const shared = createAt5IdwlSharedState(bandLimit);
  const channel = createAt5IdwlChannelState(channelIndex, shared);
  channel.idwlPackMode = packMode >>> 0;
  channel.idwl.values.set(values);
  Object.assign(channel.idwl, idwl);

  if (pairFlags) {
    shared.pairCount = pairFlags.length >>> 0;
    shared.pairFlags.set(pairFlags);
    channel.idwlState = { shared };
  }

  if (baseValues) {
    const baseChannel = createAt5IdwlChannelState(0, shared);
    baseChannel.idwl.values.set(baseValues);
    channel.block0 = baseChannel;
  }

  return channel;
}

function roundtripIdwl(channel, bandLimit) {
  const { frame, bitpos: packBitpos } = packIdwlFrame(channel, bandLimit);
  const { ok, unpacked, bitpos } = unpackDirectIdwl({
    bandLimit,
    packMode: channel.idwlPackMode,
    channelIndex: channel.channelIndex,
    baseValues: channel.block0?.idwl.values ?? null,
    frame,
  });
  assert.equal(ok, true);
  assert.equal(bitpos, packBitpos);

  return { unpacked, bitpos };
}

function packIdwlFrame(channel, bandLimit) {
  const frame = new Uint8Array(128);
  const packState = { bitpos: 0 };
  assert.equal(packIdwlChannel(channel, bandLimit, frame, packState), true);

  return { frame, bitpos: packState.bitpos >>> 0 };
}

function unpackDirectIdwl({ bandLimit, packMode, channelIndex = 0, baseValues = null, frame }) {
  const shared = createAt5IdwlSharedState(bandLimit);
  let baseChannel = null;
  if ((channelIndex | 0) !== 0 && baseValues) {
    baseChannel = createAt5IdwlChannelState(0, shared);
    baseChannel.idwl.values.set(baseValues);
  }

  const unpacked = createAt5IdwlChannelState(channelIndex, shared, baseChannel);
  const unpackState = { bitpos: 0 };
  const ok = unpackIdwl(unpacked, frame, unpackState, packMode);

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

function unpackedValues(channel, count) {
  return Array.from(channel.idwl.values.slice(0, count));
}

test("packIdwlChannel round-trips fixed-width IDWL payloads", () => {
  const bandLimit = 5;
  const channel = createPackIdwlChannel({
    bandLimit,
    packMode: 0,
    values: [0, 1, 7, 3, 2],
  });

  const { unpacked, bitpos } = roundtripIdwl(channel, bandLimit);

  assert.equal(bitpos, 15);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), [0, 1, 7, 3, 2]);
});

test("packIdwlChannel round-trips channel-0 width-coded mode-1 tails", () => {
  const bandLimit = 5;
  const channel = createPackIdwlChannel({
    bandLimit,
    packMode: 1,
    values: [2, 1, 3, 1, 0],
    idwl: {
      wlc: 0,
      mode: 3,
      count: 3,
      extra: 1,
      lead: 1,
      width: 2,
      base: 1,
    },
  });

  const { unpacked, bitpos } = roundtripIdwl(channel, bandLimit);

  assert.equal(bitpos, 28);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), [2, 1, 3, 1, 0]);
  assert.equal(unpacked.idwl.mode, 3);
  assert.equal(unpacked.idwl.count, 3);
  assert.equal(unpacked.idwl.extra, 1);
  assert.equal(unpacked.idwl.lead, 1);
  assert.equal(unpacked.idwl.width, 2);
  assert.equal(unpacked.idwl.base, 1);
});

test("packIdwlChannel round-trips channel-1 absolute stereo deltas with tail bits", () => {
  const bandLimit = 5;
  const channel = createPackIdwlChannel({
    bandLimit,
    channelIndex: 1,
    packMode: 1,
    values: [2, 1, 4, 1, 0],
    baseValues: [1, 2, 3, 0, 1],
    idwl: {
      mode: 2,
      count: 3,
      wl: 0,
    },
  });

  const { unpacked, bitpos } = roundtripIdwl(channel, bandLimit);

  assert.equal(bitpos, 17);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), [2, 1, 4, 1, 0]);
  assert.equal(unpacked.idwl.mode, 2);
  assert.equal(unpacked.idwl.count, 3);
  assert.equal(unpacked.idwl.wl, 0);
});

test("unpackIdwl treats zero count in primary mode-1 payloads as a full-band run", () => {
  const bandLimit = 4;
  const { frame, bitpos } = packBits([
    [0, 2],
    [1, 2],
    [0, 5],
    [1, 5],
    [0, 2],
    [5, 3],
    [3, 3],
  ]);

  const {
    ok,
    unpacked,
    bitpos: unpackBitpos,
  } = unpackDirectIdwl({
    bandLimit,
    packMode: 1,
    frame,
  });

  assert.equal(ok, true);
  assert.equal(unpackBitpos, bitpos);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), [3, 5, 5, 5]);
  assert.equal(unpacked.idwl.mode, 1);
  assert.equal(unpacked.idwl.count, bandLimit);
  assert.equal(unpacked.idwl.lead, 1);
  assert.equal(unpacked.idwl.width, 0);
  assert.equal(unpacked.idwl.base, 5);
});

test("packIdwlChannel round-trips channel-0 shaped pair-flag payloads", () => {
  const bandLimit = 5;
  const shapeBase = 3;
  const shapeShift = 1;
  const values = Array.from({ length: bandLimit }, (_, index) =>
    idwlShapeValueMod8(index, bandLimit, shapeBase, shapeShift)
  );
  const channel = createPackIdwlChannel({
    bandLimit,
    packMode: 2,
    values,
    pairFlags: [1, 0],
    idwl: {
      mode: 0,
      count: bandLimit,
      wl: 1,
      pairFlag: 1,
      shapeBase,
      shapeShift,
    },
  });

  const { unpacked, bitpos } = roundtripIdwl(channel, bandLimit);

  assert.equal(bitpos, 16);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), values);
  assert.equal(unpacked.idwl.pairFlag, 1);
  assert.equal(unpacked.idwl.shapeBase, shapeBase);
  assert.equal(unpacked.idwl.shapeShift, shapeShift);
});

test("packIdwlChannel round-trips channel-1 delta stereo mode-2 payloads", () => {
  const bandLimit = 5;
  const channel = createPackIdwlChannel({
    bandLimit,
    channelIndex: 1,
    packMode: 2,
    values: [2, 3, 5, 1, 0],
    baseValues: [1, 2, 3, 0, 1],
    idwl: {
      mode: 2,
      count: 3,
      wl: 1,
    },
  });

  const { unpacked, bitpos } = roundtripIdwl(channel, bandLimit);

  assert.equal(bitpos, 18);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), [2, 3, 5, 1, 0]);
  assert.equal(unpacked.idwl.mode, 2);
  assert.equal(unpacked.idwl.count, 3);
  assert.equal(unpacked.idwl.wl, 1);
});

test("packIdwlChannel round-trips channel-1 sequential mode-3 payloads with WLC", () => {
  const bandLimit = 5;
  const coefficients = idwlWlcCoefficients(1, 1, bandLimit);
  const values = [2, 1, 1, 1, 0].map((value, index) => value + coefficients[index]);
  const channel = createPackIdwlChannel({
    bandLimit,
    channelIndex: 1,
    packMode: 3,
    values,
    idwl: {
      wlc: 1,
      mode: 3,
      count: 1,
      extra: 3,
      wl: 0,
    },
  });

  const { unpacked, bitpos } = roundtripIdwl(channel, bandLimit);

  assert.equal(bitpos, 16);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), values);
  assert.equal(unpacked.idwl.wlc, 1);
  assert.equal(unpacked.idwl.mode, 3);
  assert.equal(unpacked.idwl.count, 1);
  assert.equal(unpacked.idwl.extra, 3);
});

test("packIdwlChannel keeps channel-0 sequential mode-2 tails implicit", () => {
  const bandLimit = 5;
  const channel = createPackIdwlChannel({
    bandLimit,
    packMode: 3,
    values: [4, 4, 5, 1, 1],
    idwl: {
      wlc: 0,
      mode: 2,
      count: 3,
      wl: 0,
    },
  });

  const { unpacked, bitpos } = roundtripIdwl(channel, bandLimit);

  assert.equal(bitpos, 17);
  assert.deepEqual(unpackedValues(unpacked, bandLimit), [4, 4, 5, 1, 1]);
  assert.equal(unpacked.idwl.mode, 2);
  assert.equal(unpacked.idwl.count, 3);
  assert.equal(unpacked.idwl.wl, 0);
});

test("unpackIdwl rejects channel-1 mode-3 tails that overrun the band limit", () => {
  const bandLimit = 4;
  const source = createPackIdwlChannel({
    bandLimit,
    channelIndex: 1,
    packMode: 1,
    values: [2, 1, 4, 0],
    baseValues: [1, 0, 3, 0],
    idwl: {
      mode: 3,
      count: 2,
      extra: 5,
      wl: 0,
    },
  });
  const { frame } = packIdwlFrame(source, bandLimit);

  const { ok, unpacked } = unpackDirectIdwl({
    bandLimit,
    packMode: 1,
    channelIndex: 1,
    baseValues: source.block0.idwl.values,
    frame,
  });

  assert.equal(ok, false);
  assert.equal(unpacked.blockErrorCode, AT5_IDWL_ERROR_CODES.BAD_MODE3_END_CHN);
});
