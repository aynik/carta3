import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_GAIN_ERROR_CODES,
  createAt5GainChannelState,
  unpackGainRecords,
} from "../../../src/atrac3plus/bitstream/gain.js";
import { packGainRecords } from "../../../src/atrac3plus/bitstream/gain-internal.js";

function setGainRecords(channel, records) {
  for (const record of channel.gain.records) {
    record.entries = 0;
    record.locations.fill(0);
    record.levels.fill(0);
  }

  records.forEach((record, index) => {
    const dst = channel.gain.records[index];
    dst.entries = record.locations.length >>> 0;

    record.locations.forEach((value, itemIndex) => {
      dst.locations[itemIndex] = value >>> 0;
    });
    record.levels.forEach((value, itemIndex) => {
      dst.levels[itemIndex] = value >>> 0;
    });
  });
}

function configureGainChannel(channel, config) {
  const gain = channel.gain;
  const {
    hasData = 0,
    hasDeltaFlag = 0,
    activeCount = 0,
    uniqueCount = activeCount,
    ngcMode = 0,
    idlevMode = 0,
    idlocMode = 0,
    n0 = 0,
    n1 = 0,
    idlevWidth = 0,
    idlevBase = 0,
    idlocStep = 0,
    idlocBase = 0,
    idlevFlags = [],
    idlocFlags = [],
    records = [],
  } = config;

  gain.hasData = hasData >>> 0;
  gain.hasDeltaFlag = hasDeltaFlag >>> 0;
  gain.activeCount = activeCount >>> 0;
  gain.uniqueCount = uniqueCount >>> 0;
  gain.ngcMode = ngcMode >>> 0;
  gain.idlevMode = idlevMode >>> 0;
  gain.idlocMode = idlocMode >>> 0;
  gain.n0 = n0 >>> 0;
  gain.n1 = n1 >>> 0;
  gain.idlevWidth = idlevWidth >>> 0;
  gain.idlevBase = idlevBase >>> 0;
  gain.idlocStep = idlocStep >>> 0;
  gain.idlocBase = idlocBase >>> 0;
  gain.idlevFlags.fill(0);
  gain.idlocFlags.fill(0);
  idlevFlags.forEach((flag, index) => {
    gain.idlevFlags[index] = flag >>> 0;
  });
  idlocFlags.forEach((flag, index) => {
    gain.idlocFlags[index] = flag >>> 0;
  });

  setGainRecords(channel, records);
}

function packGainFrame(channel, bytes = 64) {
  const frame = new Uint8Array(bytes);
  const state = { bitpos: 0 };
  assert.equal(packGainRecords(channel, frame, state), true);
  return { frame, bitpos: state.bitpos >>> 0 };
}

function unpackGainFrame(channel, frame) {
  const state = { bitpos: 0 };
  const ok = unpackGainRecords(channel, frame, state);
  return { ok, bitpos: state.bitpos >>> 0 };
}

function gainSnapshot(channel) {
  const gain = channel.gain;
  const recordCount = Math.max(gain.activeCount >>> 0, gain.uniqueCount >>> 0);

  return {
    hasData: gain.hasData >>> 0,
    hasDeltaFlag: gain.hasDeltaFlag >>> 0,
    activeCount: gain.activeCount >>> 0,
    uniqueCount: gain.uniqueCount >>> 0,
    ngcMode: gain.ngcMode >>> 0,
    idlevMode: gain.idlevMode >>> 0,
    idlocMode: gain.idlocMode >>> 0,
    n0: gain.n0 >>> 0,
    n1: gain.n1 >>> 0,
    idlevWidth: gain.idlevWidth >>> 0,
    idlevBase: gain.idlevBase >>> 0,
    idlocStep: gain.idlocStep >>> 0,
    idlocBase: gain.idlocBase >>> 0,
    idlevFlags: Array.from(gain.idlevFlags.slice(0, recordCount)),
    idlocFlags: Array.from(gain.idlocFlags.slice(0, recordCount)),
    records: Array.from({ length: recordCount }, (_, index) => {
      const record = gain.records[index];
      const entries = record.entries >>> 0;
      return {
        entries,
        locations: Array.from(record.locations.slice(0, entries)),
        levels: Array.from(record.levels.slice(0, entries)),
      };
    }),
  };
}

test("unpackGainRecords preserves channel-0 mode-3 metadata and repeated unique records", () => {
  const source = createAt5GainChannelState(0);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 1,
    activeCount: 2,
    uniqueCount: 4,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    n0: 1,
    n1: 2,
    idlevWidth: 3,
    idlevBase: 1,
    idlocStep: 2,
    idlocBase: 0,
    records: [
      { locations: [0, 2], levels: [1, 3] },
      { locations: [1, 3, 5], levels: [2, 4, 6] },
    ],
  });

  const { frame, bitpos } = packGainFrame(source);
  const decoded = createAt5GainChannelState(0);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 1,
    hasDeltaFlag: 1,
    activeCount: 2,
    uniqueCount: 4,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    n0: 1,
    n1: 2,
    idlevWidth: 3,
    idlevBase: 1,
    idlocStep: 2,
    idlocBase: 0,
    idlevFlags: [0, 0, 0, 0],
    idlocFlags: [0, 0, 0, 0],
    records: [
      { entries: 2, locations: [0, 2], levels: [1, 3] },
      { entries: 3, locations: [1, 3, 5], levels: [2, 4, 6] },
      { entries: 3, locations: [1, 3, 5], levels: [2, 4, 6] },
      { entries: 3, locations: [1, 3, 5], levels: [2, 4, 6] },
    ],
  });
});

test("unpackGainRecords preserves channel-0 compact mode-3 constant payloads", () => {
  const source = createAt5GainChannelState(0);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    n0: 0,
    n1: 1,
    idlevWidth: 0,
    idlevBase: 5,
    idlocStep: 1,
    idlocBase: 3,
    records: [
      { locations: [3], levels: [5] },
      { locations: [4], levels: [5] },
    ],
  });

  const { frame, bitpos } = packGainFrame(source);
  const decoded = createAt5GainChannelState(0);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    n0: 0,
    n1: 1,
    idlevWidth: 0,
    idlevBase: 5,
    idlocStep: 1,
    idlocBase: 3,
    idlevFlags: [0, 0],
    idlocFlags: [0, 0],
    records: [
      { entries: 1, locations: [3], levels: [5] },
      { entries: 1, locations: [4], levels: [5] },
    ],
  });
});

test("unpackGainRecords preserves channel-1 selective reuse flags against the base channel", () => {
  const base = createAt5GainChannelState(0);
  configureGainChannel(base, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [0, 4], levels: [2, 5] },
      { locations: [2, 7], levels: [4, 9] },
    ],
  });

  const source = createAt5GainChannelState(1, base);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 2,
    idlevMode: 2,
    idlocMode: 2,
    idlevFlags: [0, 1],
    idlocFlags: [0, 1],
    records: [
      { locations: [0, 4], levels: [2, 5] },
      { locations: [1, 3], levels: [3, 6] },
    ],
  });

  const { frame, bitpos } = packGainFrame(source);
  const decodedBase = createAt5GainChannelState(0);
  configureGainChannel(decodedBase, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [0, 4], levels: [2, 5] },
      { locations: [2, 7], levels: [4, 9] },
    ],
  });
  const decoded = createAt5GainChannelState(1, decodedBase);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 2,
    idlevMode: 2,
    idlocMode: 2,
    n0: 0,
    n1: 0,
    idlevWidth: 0,
    idlevBase: 0,
    idlocStep: 0,
    idlocBase: 0,
    idlevFlags: [0, 1],
    idlocFlags: [0, 1],
    records: [
      { entries: 2, locations: [0, 4], levels: [2, 5] },
      { entries: 2, locations: [1, 3], levels: [3, 6] },
    ],
  });
});

test("unpackGainRecords preserves channel-1 base-relative levels and copied location prefixes", () => {
  const base = createAt5GainChannelState(0);
  configureGainChannel(base, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [2, 6], levels: [3, 5] },
      { locations: [4], levels: [6] },
    ],
  });

  const source = createAt5GainChannelState(1, base);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 0,
    idlevMode: 1,
    idlocMode: 3,
    records: [
      { locations: [2, 6, 9], levels: [3, 7, 8] },
      { locations: [4, 7], levels: [6, 10] },
    ],
  });

  const { frame, bitpos } = packGainFrame(source);
  const decodedBase = createAt5GainChannelState(0);
  configureGainChannel(decodedBase, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [2, 6], levels: [3, 5] },
      { locations: [4], levels: [6] },
    ],
  });
  const decoded = createAt5GainChannelState(1, decodedBase);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 0,
    idlevMode: 1,
    idlocMode: 3,
    n0: 0,
    n1: 0,
    idlevWidth: 0,
    idlevBase: 0,
    idlocStep: 0,
    idlocBase: 0,
    idlevFlags: [0, 0],
    idlocFlags: [0, 0],
    records: [
      { entries: 3, locations: [2, 6, 9], levels: [3, 7, 8] },
      { entries: 2, locations: [4, 7], levels: [6, 10] },
    ],
  });
});

test("unpackGainRecords preserves channel-1 mode-1 base-relative IDLOC branches", () => {
  const base = createAt5GainChannelState(0);
  configureGainChannel(base, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [2, 6], levels: [4, 8] },
      { locations: [1, 5, 9], levels: [3, 7, 10] },
    ],
  });

  const source = createAt5GainChannelState(1, base);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 0,
    idlevMode: 0,
    idlocMode: 1,
    records: [
      { locations: [3, 6, 10], levels: [4, 9, 6] },
      { locations: [2, 8, 10], levels: [4, 2, 5] },
    ],
  });

  const { frame, bitpos } = packGainFrame(source);
  const decodedBase = createAt5GainChannelState(0);
  configureGainChannel(decodedBase, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [2, 6], levels: [4, 8] },
      { locations: [1, 5, 9], levels: [3, 7, 10] },
    ],
  });
  const decoded = createAt5GainChannelState(1, decodedBase);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 0,
    idlevMode: 0,
    idlocMode: 1,
    n0: 0,
    n1: 0,
    idlevWidth: 0,
    idlevBase: 0,
    idlocStep: 0,
    idlocBase: 0,
    idlevFlags: [0, 0],
    idlocFlags: [0, 0],
    records: [
      { entries: 3, locations: [3, 6, 10], levels: [4, 9, 6] },
      { entries: 3, locations: [2, 8, 10], levels: [4, 2, 5] },
    ],
  });
});

test("unpackGainRecords preserves channel-1 base-prefix overrides for rising levels", () => {
  const base = createAt5GainChannelState(0);
  configureGainChannel(base, {
    hasData: 1,
    activeCount: 1,
    uniqueCount: 1,
    records: [{ locations: [2, 6], levels: [4, 8] }],
  });

  const source = createAt5GainChannelState(1, base);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 1,
    uniqueCount: 1,
    ngcMode: 0,
    idlevMode: 0,
    idlocMode: 1,
    records: [{ locations: [3, 7], levels: [4, 9] }],
  });

  const { frame, bitpos } = packGainFrame(source);
  const decodedBase = createAt5GainChannelState(0);
  configureGainChannel(decodedBase, {
    hasData: 1,
    activeCount: 1,
    uniqueCount: 1,
    records: [{ locations: [2, 6], levels: [4, 8] }],
  });
  const decoded = createAt5GainChannelState(1, decodedBase);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 1,
    uniqueCount: 1,
    ngcMode: 0,
    idlevMode: 0,
    idlocMode: 1,
    n0: 0,
    n1: 0,
    idlevWidth: 0,
    idlevBase: 0,
    idlocStep: 0,
    idlocBase: 0,
    idlevFlags: [0],
    idlocFlags: [0],
    records: [{ entries: 2, locations: [3, 7], levels: [4, 9] }],
  });
});

test("packGainRecords keeps channel-1 full reuse modes header-only", () => {
  const base = createAt5GainChannelState(0);
  configureGainChannel(base, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [1, 4], levels: [2, 6] },
      { locations: [3, 7, 10], levels: [4, 8, 11] },
    ],
  });

  const source = createAt5GainChannelState(1, base);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    records: [
      { locations: [1, 4], levels: [2, 6] },
      { locations: [3, 7, 10], levels: [4, 8, 11] },
    ],
  });

  const { frame, bitpos } = packGainFrame(source);
  const decodedBase = createAt5GainChannelState(0);
  configureGainChannel(decodedBase, {
    hasData: 1,
    activeCount: 2,
    uniqueCount: 2,
    records: [
      { locations: [1, 4], levels: [2, 6] },
      { locations: [3, 7, 10], levels: [4, 8, 11] },
    ],
  });
  const decoded = createAt5GainChannelState(1, decodedBase);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(bitpos, 12);
  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 2,
    uniqueCount: 2,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    n0: 0,
    n1: 0,
    idlevWidth: 0,
    idlevBase: 0,
    idlocStep: 0,
    idlocBase: 0,
    idlevFlags: [0, 0],
    idlocFlags: [0, 0],
    records: [
      { entries: 2, locations: [1, 4], levels: [2, 6] },
      { entries: 3, locations: [3, 7, 10], levels: [4, 8, 11] },
    ],
  });
});

test("unpackGainRecords clears stale gain payload but preserves prior mode selectors", () => {
  const channel = createAt5GainChannelState(0);
  configureGainChannel(channel, {
    hasData: 0,
  });

  const { frame, bitpos } = packGainFrame(channel);
  const decoded = createAt5GainChannelState(0);
  configureGainChannel(decoded, {
    hasData: 1,
    hasDeltaFlag: 1,
    activeCount: 2,
    uniqueCount: 3,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    n0: 9,
    n1: 8,
    idlevWidth: 7,
    idlevBase: 6,
    idlocStep: 5,
    idlocBase: 4,
    idlevFlags: [1, 1, 1],
    idlocFlags: [1, 1, 1],
    records: [
      { locations: [1], levels: [2] },
      { locations: [3], levels: [4] },
    ],
  });

  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(gainSnapshot(decoded), {
    hasData: 0,
    hasDeltaFlag: 0,
    activeCount: 0,
    uniqueCount: 0,
    ngcMode: 3,
    idlevMode: 3,
    idlocMode: 3,
    n0: 0,
    n1: 0,
    idlevWidth: 0,
    idlevBase: 0,
    idlocStep: 0,
    idlocBase: 0,
    idlevFlags: [],
    idlocFlags: [],
    records: [],
  });
});

test("unpackGainRecords reports duplicate IDLEV values after unpacking", () => {
  const source = createAt5GainChannelState(0);
  configureGainChannel(source, {
    hasData: 1,
    hasDeltaFlag: 0,
    activeCount: 1,
    uniqueCount: 1,
    ngcMode: 0,
    idlevMode: 0,
    idlocMode: 0,
    records: [{ locations: [1, 2], levels: [3, 3] }],
  });

  const { frame } = packGainFrame(source);
  const decoded = createAt5GainChannelState(0);
  const result = unpackGainFrame(decoded, frame);

  assert.equal(result.ok, false);
  assert.equal(decoded.blockErrorCode, AT5_GAIN_ERROR_CODES.IDLEV_DUP);
});
