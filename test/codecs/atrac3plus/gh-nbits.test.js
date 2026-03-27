import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  calcNbitsForGhaAt5,
  calcNbitsForGhFreq0At5,
} from "../../../src/atrac3plus/bitstream/gh-internal.js";

function activeHeader(shared) {
  return shared.headers[shared.slotIndex & 1];
}

function currentSlot(channel, shared) {
  return channel.gh.slots[shared.slotIndex & 1];
}

function setBandEntry(entry, values) {
  entry.idlocFlag0 = values.idlocFlag0 ?? entry.idlocFlag0;
  entry.idlocFlag1 = values.idlocFlag1 ?? entry.idlocFlag1;
  entry.idlocValue0 = values.idlocValue0 ?? entry.idlocValue0;
  entry.idlocValue1 = values.idlocValue1 ?? entry.idlocValue1;
  entry.entryCount = values.entryCount ?? entry.entryCount;

  values.items?.forEach((item, index) => {
    Object.assign(entry.entries[index], item);
  });
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

test("calcNbitsForGhFreq0At5 selects reverse coding when it is cheaper", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const band = currentSlot(channel, block.ghShared).entries[0];

  channel.gh.presentFlags[0] = 1;
  setBandEntry(band, {
    entryCount: 2,
    items: [{ step: 0 }, { step: 1 }],
  });

  const bits = calcNbitsForGhFreq0At5(channel, block.ghShared, 1);

  assert.equal(bits, 12);
  assert.equal(channel.gh.freqFlags[0], 1);
});

test("calcNbitsForGhaAt5 selects the cheapest secondary GH reuse modes", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const header = activeHeader(block.ghShared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;

  const leftBand = currentSlot(left, block.ghShared).entries[0];
  setBandEntry(leftBand, {
    idlocFlag0: 1,
    idlocValue0: 5,
    idlocFlag1: 0,
    idlocValue1: 0x20,
    entryCount: 2,
    items: [
      { step: 0, sftIndex: 12, ampIndex: 4, phaseBase: 9 },
      { step: 1, sftIndex: 13, ampIndex: 5, phaseBase: 10 },
    ],
  });

  const rightBand = currentSlot(right, block.ghShared).entries[0];
  setBandEntry(rightBand, {
    idlocFlag0: 1,
    idlocValue0: 5,
    idlocFlag1: 0,
    idlocValue1: 0x20,
    entryCount: 2,
    items: [
      { step: 0, sftIndex: 12, ampIndex: 4, phaseBase: 11 },
      { step: 1, sftIndex: 13, ampIndex: 5, phaseBase: 12 },
    ],
  });

  const bits = calcNbitsForGhaAt5(block, 1);

  assert.equal(bits, 75);
  assert.deepEqual(
    {
      left: {
        modeIdloc: left.gh.modeIdloc,
        modeNwavs: left.gh.modeNwavs,
        modeFreq: left.gh.modeFreq,
        modeIdsf: left.gh.modeIdsf,
        modeIdam: left.gh.modeIdam,
      },
      right: {
        modeIdloc: right.gh.modeIdloc,
        modeNwavs: right.gh.modeNwavs,
        modeFreq: right.gh.modeFreq,
        modeIdsf: right.gh.modeIdsf,
        modeIdam: right.gh.modeIdam,
      },
      leftFreqFlags: Array.from(left.gh.freqFlags.slice(0, 1)),
      rightFreqFlags: Array.from(right.gh.freqFlags.slice(0, 1)),
    },
    {
      left: {
        modeIdloc: 0,
        modeNwavs: 1,
        modeFreq: 0,
        modeIdsf: 0,
        modeIdam: 0,
      },
      right: {
        modeIdloc: 1,
        modeNwavs: 3,
        modeFreq: 1,
        modeIdsf: 3,
        modeIdam: 3,
      },
      leftFreqFlags: [1],
      rightFreqFlags: [1],
    }
  );
});

test("calcNbitsForGhaAt5 flags and applies stereo swap when only the right band has entries", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const header = activeHeader(block.ghShared);

  header.enabled = 1;
  header.mode = 1;
  header.bandCount = 1;

  const leftBand = currentSlot(left, block.ghShared).entries[0];
  setBandEntry(leftBand, {
    idlocFlag0: 0,
    idlocFlag1: 0,
    entryCount: 0,
  });

  const rightBand = currentSlot(right, block.ghShared).entries[0];
  setBandEntry(rightBand, {
    idlocFlag0: 1,
    idlocValue0: 5,
    idlocFlag1: 1,
    idlocValue1: 6,
    entryCount: 1,
    items: [{ step: 100, sftIndex: 12, phaseBase: 9 }],
  });

  const bits = calcNbitsForGhaAt5(block, 1);

  assert.equal(bits, 53);
  assert.deepEqual(
    {
      eaArray: Array.from(header.eaArray.slice(0, 1)),
      leftBand: bandSnapshot(leftBand),
      rightBand: bandSnapshot(rightBand),
    },
    {
      eaArray: [1],
      leftBand: {
        idlocFlag0: 1,
        idlocFlag1: 1,
        idlocValue0: 5,
        idlocValue1: 6,
        entryCount: 1,
        items: [{ step: 100, sftIndex: 12, ampIndex: 0, phaseBase: 9 }],
      },
      rightBand: {
        idlocFlag0: 0,
        idlocFlag1: 0,
        idlocValue0: 0,
        idlocValue1: 0,
        entryCount: 0,
        items: [],
      },
    }
  );
});

test("calcNbitsForGhaAt5 selects secondary IDSF delta reuse for unmapped tail items", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const header = activeHeader(block.ghShared);

  header.enabled = 1;
  header.mode = 1;
  header.bandCount = 1;

  const leftBand = currentSlot(left, block.ghShared).entries[0];
  setBandEntry(leftBand, {
    idlocFlag0: 1,
    idlocValue0: 5,
    idlocFlag1: 0,
    idlocValue1: 0x20,
    entryCount: 1,
    items: [{ step: 100, sftIndex: 12, phaseBase: 9 }],
  });

  const rightBand = currentSlot(right, block.ghShared).entries[0];
  setBandEntry(rightBand, {
    idlocFlag0: 1,
    idlocValue0: 5,
    idlocFlag1: 0,
    idlocValue1: 0x20,
    entryCount: 2,
    items: [
      { step: 100, sftIndex: 13, phaseBase: 10 },
      { step: 300, sftIndex: 0x25, phaseBase: 11 },
    ],
  });

  const bits = calcNbitsForGhaAt5(block, 1);

  assert.equal(bits, 83);
  assert.deepEqual(
    {
      right: {
        modeIdloc: right.gh.modeIdloc,
        modeNwavs: right.gh.modeNwavs,
        modeFreq: right.gh.modeFreq,
        modeIdsf: right.gh.modeIdsf,
        modeIdam: right.gh.modeIdam,
      },
      rightFreqFlags: Array.from(right.gh.freqFlags.slice(0, 1)),
      itemMap: Array.from(block.ghShared.itemMap.slice(0, 2)),
    },
    {
      right: {
        modeIdloc: 1,
        modeNwavs: 2,
        modeFreq: 0,
        modeIdsf: 2,
        modeIdam: 0,
      },
      rightFreqFlags: [1],
      itemMap: [0, -1],
    }
  );
});

test("calcNbitsForGhaAt5 selects secondary IDAM delta reuse for unmapped tail items", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const header = activeHeader(block.ghShared);

  header.enabled = 1;
  header.mode = 0;
  header.bandCount = 1;

  const leftBand = currentSlot(left, block.ghShared).entries[0];
  setBandEntry(leftBand, {
    idlocFlag0: 1,
    idlocValue0: 5,
    idlocFlag1: 0,
    idlocValue1: 0x20,
    entryCount: 1,
    items: [{ step: 100, sftIndex: 12, ampIndex: 0, phaseBase: 9 }],
  });

  const rightBand = currentSlot(right, block.ghShared).entries[0];
  setBandEntry(rightBand, {
    idlocFlag0: 1,
    idlocValue0: 5,
    idlocFlag1: 0,
    idlocValue1: 0x20,
    entryCount: 2,
    items: [
      { step: 100, sftIndex: 17, ampIndex: 0, phaseBase: 10 },
      { step: 300, sftIndex: 17, ampIndex: 8, phaseBase: 11 },
    ],
  });

  const bits = calcNbitsForGhaAt5(block, 1);

  assert.equal(bits, 96);
  assert.deepEqual(
    {
      right: {
        modeIdloc: right.gh.modeIdloc,
        modeNwavs: right.gh.modeNwavs,
        modeFreq: right.gh.modeFreq,
        modeIdsf: right.gh.modeIdsf,
        modeIdam: right.gh.modeIdam,
      },
      rightFreqFlags: Array.from(right.gh.freqFlags.slice(0, 1)),
      itemMap: Array.from(block.ghShared.itemMap.slice(0, 2)),
    },
    {
      right: {
        modeIdloc: 1,
        modeNwavs: 2,
        modeFreq: 0,
        modeIdsf: 0,
        modeIdam: 2,
      },
      rightFreqFlags: [1],
      itemMap: [0, -1],
    }
  );
});
