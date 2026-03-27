import assert from "node:assert/strict";
import test from "node:test";

import {
  packIdctChannel,
  setIdctTypes as setIdctBandTypes,
} from "../../../src/atrac3plus/bitstream/idct-internal.js";
import {
  createAt5IdctChannelState,
  createAt5IdctSharedState,
  unpackIdct,
} from "../../../src/atrac3plus/bitstream/idct.js";

function createPackIdctChannel({
  modeSelect,
  bandCount,
  currentIdwl,
  values,
  count = bandCount,
  flag = 0,
  gainModeFlag = 0,
  channelIndex = 0,
  baseIdwl = null,
  baseValues = null,
}) {
  const channel = {
    channelIndex,
    shared: { gainModeFlag },
    idctModeSelect: modeSelect,
    idwl: { values: Uint32Array.from(currentIdwl) },
    idct: {
      flag,
      count,
      types: new Uint32Array(32),
      values: new Uint32Array(32),
    },
  };
  channel.idct.values.set(values);

  if (baseIdwl || baseValues) {
    channel.block0 = {
      idwl: { values: Uint32Array.from(baseIdwl ?? currentIdwl) },
      idct: { values: Uint32Array.from(baseValues ?? values) },
    };
  }

  setIdctBandTypes(channel, bandCount);
  return channel;
}

function roundtripIdct(channel, bandCount) {
  const frame = new Uint8Array(128);
  const packState = { bitpos: 0 };
  assert.equal(packIdctChannel(channel, bandCount, frame, packState), true);

  const shared = createAt5IdctSharedState({
    fixIdx: channel.shared.gainModeFlag,
    maxCount: bandCount,
    gainModeFlag: channel.shared.gainModeFlag,
  });
  let baseChannel = null;
  if ((channel.channelIndex | 0) !== 0) {
    baseChannel = createAt5IdctChannelState(0, shared);
    baseChannel.idct.values.set(channel.block0.idct.values);
  }

  const unpacked = createAt5IdctChannelState(channel.channelIndex, shared, baseChannel);
  unpacked.idct.types.set(channel.idct.types);

  const unpackState = { bitpos: 0 };
  assert.equal(unpackIdct(unpacked, frame, unpackState, channel.idctModeSelect), true);
  assert.equal(unpackState.bitpos, packState.bitpos);

  return { unpacked, bitpos: packState.bitpos >>> 0 };
}

function unpackedValues(channel, count) {
  return Array.from(channel.idct.values.slice(0, count));
}

test("createAt5IdctSharedState treats null options as defaults", () => {
  assert.deepEqual(createAt5IdctSharedState(null), {
    fixIdx: 0,
    maxCount: 0,
    gainModeFlag: 0,
  });
});

test("setIdctTypes marks secondary carry-over bands as type-2", () => {
  const bandCount = 5;
  const channel = createPackIdctChannel({
    modeSelect: 3,
    bandCount,
    channelIndex: 1,
    currentIdwl: [0, 1, 0, 0, 0],
    baseIdwl: [1, 0, 1, 0, 0],
    values: [0, 0, 0, 0, 0],
    baseValues: [0, 0, 0, 0, 0],
  });

  assert.deepEqual(Array.from(channel.idct.types.slice(0, bandCount)), [2, 1, 2, 0, 0]);
});

test("packIdctChannel round-trips fixed-width primary payloads", () => {
  const bandCount = 5;
  const channel = createPackIdctChannel({
    modeSelect: 0,
    bandCount,
    currentIdwl: [1, 0, 1, 0, 0],
    values: [3, 0, 2, 0, 0],
    count: 3,
    flag: 1,
  });

  const { unpacked } = roundtripIdct(channel, bandCount);

  assert.deepEqual(unpackedValues(unpacked, bandCount), [3, 0, 2, 0, 0]);
  assert.equal(unpacked.idct.flag, 1);
  assert.equal(unpacked.idct.count, 3);
});

test("packIdctChannel round-trips direct-Huffman primary payloads", () => {
  const bandCount = 5;
  const channel = createPackIdctChannel({
    modeSelect: 1,
    bandCount,
    currentIdwl: [1, 0, 1, 1, 0],
    values: [7, 0, 3, 1, 0],
    count: 4,
    flag: 1,
    gainModeFlag: 1,
  });

  const { unpacked } = roundtripIdct(channel, bandCount);

  assert.deepEqual(unpackedValues(unpacked, bandCount), [7, 0, 3, 1, 0]);
  assert.equal(unpacked.idct.flag, 1);
  assert.equal(unpacked.idct.count, 4);
});

test("packIdctChannel round-trips chained primary IDCT deltas", () => {
  const bandCount = 5;
  const channel = createPackIdctChannel({
    modeSelect: 2,
    bandCount,
    currentIdwl: [1, 0, 1, 1, 0],
    values: [2, 0, 5, 6, 0],
    count: 4,
    flag: 1,
    gainModeFlag: 1,
  });

  const { unpacked } = roundtripIdct(channel, bandCount);

  assert.deepEqual(unpackedValues(unpacked, bandCount), [2, 0, 5, 6, 0]);
  assert.equal(unpacked.idct.flag, 1);
  assert.equal(unpacked.idct.count, 4);
});

test("packIdctChannel round-trips paired channel-1 IDCT payloads against block0", () => {
  const bandCount = 5;
  const channel = createPackIdctChannel({
    modeSelect: 3,
    bandCount,
    channelIndex: 1,
    currentIdwl: [0, 1, 0, 0, 0],
    baseIdwl: [1, 0, 1, 1, 0],
    values: [1, 3, 0, 1, 0],
    baseValues: [0, 0, 1, 0, 0],
    count: 4,
    flag: 1,
    gainModeFlag: 1,
  });

  const { unpacked } = roundtripIdct(channel, bandCount);

  assert.deepEqual(unpackedValues(unpacked, bandCount), [1, 3, 0, 1, 0]);
  assert.equal(unpacked.idct.flag, 1);
  assert.equal(unpacked.idct.count, 4);
});

test("packIdctChannel keeps the primary zero-bit copy mode empty", () => {
  const bandCount = 5;
  const channel = createPackIdctChannel({
    modeSelect: 3,
    bandCount,
    currentIdwl: [1, 0, 1, 0, 0],
    values: [0, 0, 0, 0, 0],
  });

  const { unpacked, bitpos } = roundtripIdct(channel, bandCount);

  assert.equal(bitpos, 0);
  assert.deepEqual(unpackedValues(unpacked, bandCount), [0, 0, 0, 0, 0]);
});
