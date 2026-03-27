import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import { AT5_GH_ERROR_CODES, unpackGh } from "../../../src/atrac3plus/bitstream/gh.js";
import { packGhAt5 } from "../../../src/atrac3plus/bitstream/gh-internal.js";

function activeHeader(shared) {
  return shared.headers[shared.slotIndex & 1];
}

function currentSlot(channel, shared) {
  return channel.gh.slots[shared.slotIndex & 1];
}

function setEntryItem(entry, itemIndex, values) {
  Object.assign(entry.entries[itemIndex], values);
}

function packGhFrame(block, bytes = 256) {
  const frame = new Uint8Array(bytes);
  const state = { bitpos: 0 };
  assert.equal(packGhAt5(block, frame, state), true);
  return { frame, bitpos: state.bitpos >>> 0 };
}

function unpackGhFrame(block, frame) {
  const state = { bitpos: 0 };
  const ok = unpackGh(block, frame, state);
  return { ok, bitpos: state.bitpos >>> 0 };
}

function bandSnapshot(entry) {
  const count = entry.entryCount >>> 0;
  return {
    idlocFlag0: entry.idlocFlag0 >>> 0,
    idlocFlag1: entry.idlocFlag1 >>> 0,
    idlocValue0: entry.idlocValue0 >>> 0,
    idlocValue1: entry.idlocValue1 >>> 0,
    entryCount: count,
    items: Array.from({ length: count }, (_, index) => ({
      step: entry.entries[index].step >>> 0,
      sftIndex: entry.entries[index].sftIndex >>> 0,
      ampIndex: entry.entries[index].ampIndex >>> 0,
      phaseBase: entry.entries[index].phaseBase >>> 0,
    })),
  };
}

test("unpackGh clears stale current-slot runtime when GH is disabled", () => {
  const source = createAt5RegularBlockState(1);
  activeHeader(source.ghShared).enabled = 0;
  const { frame, bitpos } = packGhFrame(source, 8);

  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const header = activeHeader(block.ghShared);
  header.enabled = 1;
  header.mode = 1;
  header.bandCount = 3;
  channel.gh.modeIdloc = 1;
  channel.gh.modeNwavs = 2;
  channel.gh.modeFreq = 1;
  channel.gh.modeIdsf = 3;
  channel.gh.modeIdam = 2;
  channel.gh.presentFlags[0] = 1;
  channel.gh.freqFlags[0] = 1;
  const staleBand = currentSlot(channel, block.ghShared).entries[0];
  staleBand.idlocFlag0 = 1;
  staleBand.idlocValue0 = 9;
  staleBand.idlocFlag1 = 1;
  staleBand.idlocValue1 = 11;
  staleBand.entryCount = 2;
  setEntryItem(staleBand, 0, { step: 123, sftIndex: 7, ampIndex: 5, phaseBase: 4 });

  const result = unpackGhFrame(block, frame);

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(
    {
      enabled: header.enabled,
      mode: header.mode,
      bandCount: header.bandCount,
      modeIdloc: channel.gh.modeIdloc,
      modeNwavs: channel.gh.modeNwavs,
      modeFreq: channel.gh.modeFreq,
      modeIdsf: channel.gh.modeIdsf,
      modeIdam: channel.gh.modeIdam,
      presentFlags: Array.from(channel.gh.presentFlags.slice(0, 2)),
      freqFlags: Array.from(channel.gh.freqFlags.slice(0, 2)),
      band0: bandSnapshot(currentSlot(channel, block.ghShared).entries[0]),
    },
    {
      enabled: 0,
      mode: 0,
      bandCount: 0,
      modeIdloc: 0,
      modeNwavs: 0,
      modeFreq: 0,
      modeIdsf: 0,
      modeIdam: 0,
      presentFlags: [0, 0],
      freqFlags: [0, 0],
      band0: {
        idlocFlag0: 0,
        idlocFlag1: 0,
        idlocValue0: 0,
        idlocValue1: 0x20,
        entryCount: 0,
        items: [],
      },
    }
  );
});

test("unpackGh applies stereo copy and swap flags after decoding channel data", () => {
  const source = createAt5RegularBlockState(2);
  const [left, right] = source.channels;
  const shared = source.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 2;
  header.c4Enable = 1;
  header.c5Mode = 1;
  header.c6Array[0] = 1;
  header.e8Enable = 1;
  header.e9Mode = 1;
  header.eaArray[1] = 1;

  left.gh.presentFlags[0] = 1;
  left.gh.presentFlags[1] = 1;
  right.gh.presentFlags[0] = 0;
  right.gh.presentFlags[1] = 1;

  left.gh.modeNwavs = 0;
  left.gh.modeFreq = 0;
  left.gh.modeIdsf = 0;
  left.gh.modeIdam = 0;
  right.gh.modeIdloc = 0;
  right.gh.modeNwavs = 0;
  right.gh.modeFreq = 0;
  right.gh.modeIdsf = 0;
  right.gh.modeIdam = 0;

  const leftBands = currentSlot(left, shared).entries;
  leftBands[0].idlocFlag0 = 1;
  leftBands[0].idlocValue0 = 1;
  leftBands[0].idlocFlag1 = 0;
  leftBands[0].idlocValue1 = 0x20;
  leftBands[0].entryCount = 1;
  setEntryItem(leftBands[0], 0, { step: 100, sftIndex: 12, ampIndex: 4, phaseBase: 9 });

  leftBands[1].idlocFlag0 = 1;
  leftBands[1].idlocValue0 = 2;
  leftBands[1].idlocFlag1 = 1;
  leftBands[1].idlocValue1 = 3;
  leftBands[1].entryCount = 1;
  setEntryItem(leftBands[1], 0, { step: 101, sftIndex: 13, ampIndex: 5, phaseBase: 10 });

  const rightBands = currentSlot(right, shared).entries;
  rightBands[1].idlocFlag0 = 1;
  rightBands[1].idlocValue0 = 4;
  rightBands[1].idlocFlag1 = 1;
  rightBands[1].idlocValue1 = 6;
  rightBands[1].entryCount = 1;
  setEntryItem(rightBands[1], 0, { step: 202, sftIndex: 21, ampIndex: 8, phaseBase: 14 });

  const { frame, bitpos } = packGhFrame(source);
  const decoded = createAt5RegularBlockState(2);
  const result = unpackGhFrame(decoded, frame);
  const decodedHeader = activeHeader(decoded.ghShared);
  const [decodedLeft, decodedRight] = decoded.channels;
  const decodedLeftBands = currentSlot(decodedLeft, decoded.ghShared).entries;
  const decodedRightBands = currentSlot(decodedRight, decoded.ghShared).entries;

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.deepEqual(
    {
      c6Array: Array.from(decodedHeader.c6Array.slice(0, 2)),
      eaArray: Array.from(decodedHeader.eaArray.slice(0, 2)),
      rightPresent: Array.from(decodedRight.gh.presentFlags.slice(0, 2)),
      leftBand0: bandSnapshot(decodedLeftBands[0]),
      rightBand0: bandSnapshot(decodedRightBands[0]),
      leftBand1: bandSnapshot(decodedLeftBands[1]),
      rightBand1: bandSnapshot(decodedRightBands[1]),
    },
    {
      c6Array: [1, 0],
      eaArray: [0, 1],
      rightPresent: [0, 1],
      leftBand0: {
        idlocFlag0: 1,
        idlocFlag1: 0,
        idlocValue0: 1,
        idlocValue1: 0x20,
        entryCount: 1,
        items: [{ step: 100, sftIndex: 12, ampIndex: 4, phaseBase: 9 }],
      },
      rightBand0: {
        idlocFlag0: 1,
        idlocFlag1: 0,
        idlocValue0: 1,
        idlocValue1: 0x20,
        entryCount: 1,
        items: [{ step: 100, sftIndex: 12, ampIndex: 4, phaseBase: 9 }],
      },
      leftBand1: {
        idlocFlag0: 1,
        idlocFlag1: 1,
        idlocValue0: 4,
        idlocValue1: 6,
        entryCount: 1,
        items: [{ step: 202, sftIndex: 21, ampIndex: 8, phaseBase: 14 }],
      },
      rightBand1: {
        idlocFlag0: 1,
        idlocFlag1: 1,
        idlocValue0: 2,
        idlocValue1: 3,
        entryCount: 1,
        items: [{ step: 101, sftIndex: 13, ampIndex: 5, phaseBase: 10 }],
      },
    }
  );
});

test("unpackGh preserves primary mode-1 IDSF and IDAM Huffman payloads", () => {
  const source = createAt5RegularBlockState(1);
  const [channel] = source.channels;
  const shared = source.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 2;

  channel.gh.presentFlags[0] = 1;
  channel.gh.presentFlags[1] = 1;
  channel.gh.modeNwavs = 0;
  channel.gh.modeFreq = 0;
  channel.gh.modeIdsf = 1;
  channel.gh.modeIdam = 1;

  const bands = currentSlot(channel, shared).entries;

  bands[0].idlocFlag0 = 1;
  bands[0].idlocValue0 = 2;
  bands[0].idlocFlag1 = 0;
  bands[0].idlocValue1 = 0x20;
  bands[0].entryCount = 1;
  setEntryItem(bands[0], 0, { step: 100, sftIndex: 0x1a, ampIndex: 6, phaseBase: 9 });

  bands[1].idlocFlag0 = 1;
  bands[1].idlocValue0 = 4;
  bands[1].idlocFlag1 = 1;
  bands[1].idlocValue1 = 5;
  bands[1].entryCount = 2;
  setEntryItem(bands[1], 0, { step: 200, sftIndex: 0x1c, ampIndex: 1, phaseBase: 10 });
  setEntryItem(bands[1], 1, { step: 240, sftIndex: 0x1c, ampIndex: 7, phaseBase: 11 });

  const { frame, bitpos } = packGhFrame(source);
  const decoded = createAt5RegularBlockState(1);
  const result = unpackGhFrame(decoded, frame);
  const [decodedChannel] = decoded.channels;
  const decodedBands = currentSlot(decodedChannel, decoded.ghShared).entries;

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.equal(decodedChannel.gh.modeIdloc, 0);
  assert.equal(decodedChannel.gh.modeNwavs, 0);
  assert.equal(decodedChannel.gh.modeFreq, 0);
  assert.equal(decodedChannel.gh.modeIdsf, 1);
  assert.equal(decodedChannel.gh.modeIdam, 1);
  assert.deepEqual(bandSnapshot(decodedBands[0]), {
    idlocFlag0: 1,
    idlocFlag1: 0,
    idlocValue0: 2,
    idlocValue1: 0x20,
    entryCount: 1,
    items: [{ step: 100, sftIndex: 0x1a, ampIndex: 6, phaseBase: 9 }],
  });
  assert.deepEqual(bandSnapshot(decodedBands[1]), {
    idlocFlag0: 1,
    idlocFlag1: 1,
    idlocValue0: 4,
    idlocValue1: 5,
    entryCount: 2,
    items: [
      { step: 200, sftIndex: 0x1c, ampIndex: 1, phaseBase: 10 },
      { step: 240, sftIndex: 0x1c, ampIndex: 7, phaseBase: 11 },
    ],
  });
});

test("unpackGh preserves secondary header-mode-1 IDSF Huffman payloads", () => {
  const source = createAt5RegularBlockState(2);
  const [left, right] = source.channels;
  const shared = source.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 1;
  header.bandCount = 1;

  left.gh.presentFlags[0] = 1;
  right.gh.presentFlags[0] = 1;

  left.gh.modeNwavs = 0;
  left.gh.modeFreq = 0;
  left.gh.modeIdsf = 0;

  right.gh.modeIdloc = 1;
  right.gh.modeNwavs = 0;
  right.gh.modeFreq = 0;
  right.gh.modeIdsf = 1;

  const leftBand = currentSlot(left, shared).entries[0];
  leftBand.idlocFlag0 = 1;
  leftBand.idlocValue0 = 5;
  leftBand.idlocFlag1 = 0;
  leftBand.idlocValue1 = 0x20;
  leftBand.entryCount = 1;
  setEntryItem(leftBand, 0, { step: 100, sftIndex: 12, phaseBase: 9 });

  const rightBand = currentSlot(right, shared).entries[0];
  rightBand.idlocFlag0 = 1;
  rightBand.idlocValue0 = 5;
  rightBand.idlocFlag1 = 0;
  rightBand.idlocValue1 = 0x20;
  rightBand.entryCount = 2;
  setEntryItem(rightBand, 0, { step: 100, sftIndex: 0x15, phaseBase: 10 });
  setEntryItem(rightBand, 1, { step: 280, sftIndex: 0x1f, phaseBase: 11 });

  const { frame, bitpos } = packGhFrame(source);
  const decoded = createAt5RegularBlockState(2);
  const result = unpackGhFrame(decoded, frame);
  const decodedRight = decoded.channels[1];
  const decodedRightBand = currentSlot(decodedRight, decoded.ghShared).entries[0];

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.equal(decodedRight.gh.modeIdloc, 1);
  assert.equal(decodedRight.gh.modeNwavs, 0);
  assert.equal(decodedRight.gh.modeFreq, 0);
  assert.equal(decodedRight.gh.modeIdsf, 1);
  assert.equal(decodedRight.gh.modeIdam, 0);
  assert.deepEqual(bandSnapshot(decodedRightBand), {
    idlocFlag0: 1,
    idlocFlag1: 0,
    idlocValue0: 5,
    idlocValue1: 0x20,
    entryCount: 2,
    items: [
      { step: 100, sftIndex: 0x15, ampIndex: 0, phaseBase: 10 },
      { step: 280, sftIndex: 0x1f, ampIndex: 0, phaseBase: 11 },
    ],
  });
});

test("unpackGh rejects stereo channel data when combined entry count exceeds the limit", () => {
  const source = createAt5RegularBlockState(2);
  const [left, right] = source.channels;
  const shared = source.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 1;
  header.bandCount = 2;

  left.gh.presentFlags[0] = 1;
  left.gh.presentFlags[1] = 1;
  right.gh.presentFlags[0] = 1;
  right.gh.presentFlags[1] = 1;

  left.gh.modeNwavs = 0;
  left.gh.modeFreq = 0;
  left.gh.modeIdsf = 0;
  right.gh.modeIdloc = 1;
  right.gh.modeNwavs = 3;

  const leftBands = currentSlot(left, shared).entries;
  const rightBands = currentSlot(right, shared).entries;
  for (let band = 0; band < 2; band += 1) {
    leftBands[band].idlocFlag0 = 0;
    leftBands[band].idlocFlag1 = 0;
    leftBands[band].entryCount = 15;
    rightBands[band].entryCount = 15;
    for (let item = 0; item < 15; item += 1) {
      setEntryItem(leftBands[band], item, { step: 32 + item, sftIndex: 20, phaseBase: 7 });
    }
  }

  const { frame } = packGhFrame(source);
  const decoded = createAt5RegularBlockState(2);
  const result = unpackGhFrame(decoded, frame);
  const decodedLeftBands = currentSlot(decoded.channels[0], decoded.ghShared).entries;
  const decodedRightBands = currentSlot(decoded.channels[1], decoded.ghShared).entries;

  assert.equal(result.ok, false);
  assert.equal(decoded.channels[0].blockErrorCode, 0);
  assert.equal(decoded.channels[1].blockErrorCode, AT5_GH_ERROR_CODES.TOO_MANY_ENTRIES);
  assert.equal(decoded.channels[1].gh.modeIdloc, 1);
  assert.equal(decoded.channels[1].gh.modeNwavs, 3);
  assert.equal(decodedLeftBands[0].entryCount, 15);
  assert.equal(decodedLeftBands[1].entryCount, 15);
  assert.equal(decodedRightBands[0].entryCount, 15);
  assert.equal(decodedRightBands[1].entryCount, 15);
});

test("unpackGh preserves secondary mode-3 IDSF and IDAM reuse paths", () => {
  const source = createAt5RegularBlockState(2);
  const [left, right] = source.channels;
  const shared = source.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;

  left.gh.presentFlags[0] = 1;
  right.gh.presentFlags[0] = 1;

  left.gh.modeNwavs = 0;
  left.gh.modeFreq = 0;
  left.gh.modeIdsf = 0;
  left.gh.modeIdam = 0;

  right.gh.modeIdloc = 1;
  right.gh.modeNwavs = 3;
  right.gh.modeFreq = 1;
  right.gh.modeIdsf = 3;
  right.gh.modeIdam = 3;

  const leftBand = currentSlot(left, shared).entries[0];
  leftBand.idlocFlag0 = 1;
  leftBand.idlocValue0 = 5;
  leftBand.idlocFlag1 = 0;
  leftBand.idlocValue1 = 0x20;
  leftBand.entryCount = 1;
  setEntryItem(leftBand, 0, { step: 100, sftIndex: 12, ampIndex: 4, phaseBase: 9 });

  const rightBand = currentSlot(right, shared).entries[0];
  rightBand.idlocFlag0 = 1;
  rightBand.idlocValue0 = 5;
  rightBand.idlocFlag1 = 0;
  rightBand.idlocValue1 = 0x20;
  rightBand.entryCount = 1;
  setEntryItem(rightBand, 0, { step: 100, sftIndex: 12, ampIndex: 4, phaseBase: 14 });

  const { frame, bitpos } = packGhFrame(source);
  const decoded = createAt5RegularBlockState(2);
  const result = unpackGhFrame(decoded, frame);
  const decodedRight = decoded.channels[1];
  const decodedRightBand = currentSlot(decodedRight, decoded.ghShared).entries[0];

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.equal(decodedRight.gh.modeIdloc, 1);
  assert.equal(decodedRight.gh.modeNwavs, 3);
  assert.equal(decodedRight.gh.modeFreq, 1);
  assert.equal(decodedRight.gh.modeIdsf, 3);
  assert.equal(decodedRight.gh.modeIdam, 3);
  assert.deepEqual(bandSnapshot(decodedRightBand), {
    idlocFlag0: 1,
    idlocFlag1: 0,
    idlocValue0: 5,
    idlocValue1: 0x20,
    entryCount: 1,
    items: [{ step: 100, sftIndex: 12, ampIndex: 4, phaseBase: 14 }],
  });
});

test("unpackGh preserves secondary header-mode-1 IDSF delta mapping for unmapped tail items", () => {
  const source = createAt5RegularBlockState(2);
  const [left, right] = source.channels;
  const shared = source.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 1;
  header.bandCount = 1;
  shared.itemMap.set([0, -1]);

  left.gh.presentFlags[0] = 1;
  right.gh.presentFlags[0] = 1;

  left.gh.modeNwavs = 0;
  left.gh.modeFreq = 0;
  left.gh.modeIdsf = 0;

  right.gh.modeIdloc = 1;
  right.gh.modeNwavs = 0;
  right.gh.modeFreq = 0;
  right.gh.modeIdsf = 2;

  const leftBand = currentSlot(left, shared).entries[0];
  leftBand.idlocFlag0 = 1;
  leftBand.idlocValue0 = 5;
  leftBand.idlocFlag1 = 0;
  leftBand.idlocValue1 = 0x20;
  leftBand.entryCount = 1;
  setEntryItem(leftBand, 0, { step: 100, sftIndex: 12, phaseBase: 9 });

  const rightBand = currentSlot(right, shared).entries[0];
  rightBand.idlocFlag0 = 1;
  rightBand.idlocValue0 = 5;
  rightBand.idlocFlag1 = 0;
  rightBand.idlocValue1 = 0x20;
  rightBand.entryCount = 2;
  setEntryItem(rightBand, 0, { step: 100, sftIndex: 13, phaseBase: 10 });
  setEntryItem(rightBand, 1, { step: 300, sftIndex: 0x25, phaseBase: 11 });

  const { frame, bitpos } = packGhFrame(source);
  const decoded = createAt5RegularBlockState(2);
  const result = unpackGhFrame(decoded, frame);
  const decodedRight = decoded.channels[1];
  const decodedRightBand = currentSlot(decodedRight, decoded.ghShared).entries[0];

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.equal(decodedRight.gh.modeIdloc, 1);
  assert.equal(decodedRight.gh.modeNwavs, 0);
  assert.equal(decodedRight.gh.modeFreq, 0);
  assert.equal(decodedRight.gh.modeIdsf, 2);
  assert.equal(decodedRight.gh.modeIdam, 0);
  assert.deepEqual(bandSnapshot(decodedRightBand), {
    idlocFlag0: 1,
    idlocFlag1: 0,
    idlocValue0: 5,
    idlocValue1: 0x20,
    entryCount: 2,
    items: [
      { step: 100, sftIndex: 13, ampIndex: 0, phaseBase: 10 },
      { step: 300, sftIndex: 0x25, ampIndex: 0, phaseBase: 11 },
    ],
  });
});

test("packGhAt5 rejects invalid primary mode selections", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const header = activeHeader(block.ghShared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;

  channel.gh.presentFlags[0] = 1;
  channel.gh.modeNwavs = 2;

  const band = currentSlot(channel, block.ghShared).entries[0];
  band.idlocFlag0 = 0;
  band.idlocFlag1 = 0;
  band.entryCount = 0;

  const frame = new Uint8Array(64);
  const state = { bitpos: 0 };
  assert.equal(packGhAt5(block, frame, state), false);
});

test("packGhAt5 rejects out-of-range secondary mode values", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const shared = block.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;

  left.gh.presentFlags[0] = 1;
  right.gh.presentFlags[0] = 1;

  right.gh.modeIdloc = 1;
  right.gh.modeIdsf = 4;

  const leftBand = currentSlot(left, shared).entries[0];
  leftBand.idlocFlag0 = 0;
  leftBand.idlocFlag1 = 0;
  leftBand.entryCount = 0;

  const rightBand = currentSlot(right, shared).entries[0];
  rightBand.idlocFlag0 = 0;
  rightBand.idlocFlag1 = 0;
  rightBand.entryCount = 0;

  const frame = new Uint8Array(64);
  const state = { bitpos: 0 };
  assert.equal(packGhAt5(block, frame, state), false);
});

test("packGhAt5 rejects NWAVS delta values outside the signed-3-bit window", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const shared = block.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;

  left.gh.presentFlags[0] = 1;
  right.gh.presentFlags[0] = 1;

  right.gh.modeIdloc = 1;
  right.gh.modeNwavs = 2;

  const leftBand = currentSlot(left, shared).entries[0];
  leftBand.idlocFlag0 = 0;
  leftBand.idlocFlag1 = 0;
  leftBand.entryCount = 0;

  const rightBand = currentSlot(right, shared).entries[0];
  rightBand.idlocFlag0 = 0;
  rightBand.idlocFlag1 = 0;
  rightBand.entryCount = 10;

  const frame = new Uint8Array(64);
  const state = { bitpos: 0 };
  assert.equal(packGhAt5(block, frame, state), false);
});

test("packGhAt5 rejects mode-3 NWAVS copy when entry counts diverge", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const shared = block.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;

  left.gh.presentFlags[0] = 1;
  right.gh.presentFlags[0] = 1;

  right.gh.modeIdloc = 1;
  right.gh.modeNwavs = 3;

  const leftBand = currentSlot(left, shared).entries[0];
  leftBand.idlocFlag0 = 0;
  leftBand.idlocFlag1 = 0;
  leftBand.entryCount = 1;

  const rightBand = currentSlot(right, shared).entries[0];
  rightBand.idlocFlag0 = 0;
  rightBand.idlocFlag1 = 0;
  rightBand.entryCount = 2;

  const frame = new Uint8Array(64);
  const state = { bitpos: 0 };
  assert.equal(packGhAt5(block, frame, state), false);
});

test("unpackGh preserves secondary IDAM delta mapping for unmapped tail items", () => {
  const source = createAt5RegularBlockState(2);
  const [left, right] = source.channels;
  const shared = source.ghShared;
  const header = activeHeader(shared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;
  shared.itemMap.set([0, -1]);

  left.gh.presentFlags[0] = 1;
  right.gh.presentFlags[0] = 1;

  left.gh.modeNwavs = 0;
  left.gh.modeFreq = 0;
  left.gh.modeIdsf = 0;
  left.gh.modeIdam = 0;

  right.gh.modeIdloc = 1;
  right.gh.modeNwavs = 0;
  right.gh.modeFreq = 0;
  right.gh.modeIdsf = 0;
  right.gh.modeIdam = 2;

  const leftBand = currentSlot(left, shared).entries[0];
  leftBand.idlocFlag0 = 1;
  leftBand.idlocValue0 = 5;
  leftBand.idlocFlag1 = 0;
  leftBand.idlocValue1 = 0x20;
  leftBand.entryCount = 1;
  setEntryItem(leftBand, 0, { step: 100, sftIndex: 12, ampIndex: 4, phaseBase: 9 });

  const rightBand = currentSlot(right, shared).entries[0];
  rightBand.idlocFlag0 = 1;
  rightBand.idlocValue0 = 5;
  rightBand.idlocFlag1 = 0;
  rightBand.idlocValue1 = 0x20;
  rightBand.entryCount = 2;
  setEntryItem(rightBand, 0, { step: 100, sftIndex: 17, ampIndex: 6, phaseBase: 10 });
  setEntryItem(rightBand, 1, { step: 300, sftIndex: 17, ampIndex: 9, phaseBase: 11 });

  const { frame, bitpos } = packGhFrame(source);
  const decoded = createAt5RegularBlockState(2);
  const result = unpackGhFrame(decoded, frame);
  const decodedRight = decoded.channels[1];
  const decodedRightBand = currentSlot(decodedRight, decoded.ghShared).entries[0];

  assert.equal(result.ok, true);
  assert.equal(result.bitpos, bitpos);
  assert.equal(decodedRight.gh.modeIdloc, 1);
  assert.equal(decodedRight.gh.modeNwavs, 0);
  assert.equal(decodedRight.gh.modeFreq, 0);
  assert.equal(decodedRight.gh.modeIdsf, 0);
  assert.equal(decodedRight.gh.modeIdam, 2);
  assert.deepEqual(bandSnapshot(decodedRightBand), {
    idlocFlag0: 1,
    idlocFlag1: 0,
    idlocValue0: 5,
    idlocValue1: 0x20,
    entryCount: 2,
    items: [
      { step: 100, sftIndex: 17, ampIndex: 6, phaseBase: 10 },
      { step: 300, sftIndex: 17, ampIndex: 9, phaseBase: 11 },
    ],
  });
});
