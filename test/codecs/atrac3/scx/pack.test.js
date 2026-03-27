import assert from "node:assert/strict";
import test from "node:test";

import {
  nbitsForAdjust,
  nbitsForComponent,
  nbitsForPackdata,
  nbitsForPackdataAt3,
  nbitsForSpectrum,
} from "../../../../src/atrac3/scx/pack-bits.js";
import { packMddataAt3, putChsunitAt3 } from "../../../../src/atrac3/scx/channel-unit.js";
import { createAtrac3ScxEncoderContext } from "../../../../src/atrac3/scx/context.js";
import {
  setAt3GainControlCount,
  setAt3GainControlEntry,
} from "../../../../src/atrac3/scx/gainc-layout.js";
import { AT3_NBITS_ERROR } from "../../../../src/atrac3/scx/tables.js";

function createChannelBlock() {
  return createAtrac3ScxEncoderContext().state.channelHistories[0].current;
}

function configureComponentEntry(ch) {
  ch.mddataEntryIndex = 1;
  ch.componentMode = 0;
  ch.componentGroupCount = 1;
  ch.mddataEntries[0].huffTableSetIndex = 0;
  ch.mddataEntries[0].huffTableBaseIndex = 2;
  ch.mddataEntries[0].twiddleId = 0;
  ch.mddataEntries[0].groupFlags[0] = 1;
  ch.mddataEntries[0].listCounts[0] = 1;
  ch.mddataEntries[0].lists[0][0] = 0;
  ch.tonePool[0].coefficients[0] = 1;
  return ch;
}

test("nbitsForComponent preserves current default and representative valid counts", () => {
  assert.equal(nbitsForComponent(createChannelBlock()), 5);

  const ch = configureComponentEntry(createChannelBlock());
  assert.equal(nbitsForComponent(ch), 41);
});

test("nbitsForComponent preserves current sticky tone-width behavior", () => {
  const ch = configureComponentEntry(createChannelBlock());
  ch.mddataEntries[0].twiddleId = 7;
  ch.mddataEntries[0].listCounts[0] = 2;
  ch.mddataEntries[0].lists[0][1] = 1;
  ch.tonePool[1].coefficients[0] = 1;

  ch.tonePool[0].start = 0;
  ch.tonePool[1].start = 0;
  assert.equal(nbitsForComponent(ch), 70);

  ch.tonePool[0].start = 1023;
  ch.tonePool[1].start = 0;
  assert.equal(nbitsForComponent(ch), 56);

  ch.tonePool[0].start = 0;
  ch.tonePool[1].start = 1023;
  assert.equal(nbitsForComponent(ch), 63);
});

test("packMddataAt3 preserves current sticky tone-width packing behavior", () => {
  const scenarios = [
    {
      start0: 0,
      start1: 0,
      bits: 174,
      bytes: [160, 1, 61, 32, 0, 128, 0, 2, 0, 0, 112, 0, 0, 0, 0, 0],
    },
    {
      start0: 1023,
      start1: 0,
      bits: 160,
      bytes: [160, 1, 61, 32, 63, 128, 1, 0, 28, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      start0: 0,
      start1: 1023,
      bits: 167,
      bytes: [160, 1, 61, 32, 0, 128, 0, 254, 0, 56, 0, 0, 0, 0, 0, 0],
    },
  ];

  for (const { start0, start1, bits, bytes } of scenarios) {
    const ch = configureComponentEntry(createChannelBlock());
    ch.mddataEntries[0].twiddleId = 7;
    ch.mddataEntries[0].listCounts[0] = 2;
    ch.mddataEntries[0].lists[0][1] = 1;
    ch.tonePool[1].coefficients[0] = 1;
    ch.tonePool[0].start = start0;
    ch.tonePool[1].start = start1;

    const totalBits = nbitsForPackdataAt3(ch);
    const out = new Uint8Array(Math.ceil(totalBits / 8));
    const packedBits = packMddataAt3(ch, out, totalBits);

    assert.equal(totalBits, bits);
    assert.equal(packedBits, bits);
    assert.equal(ch.toneCount, 2);
    assert.deepEqual(Array.from(out.slice(0, bytes.length)), bytes);
  }
});

test("packMddataAt3 preserves current multi-group component tone-list ordering", () => {
  const ch = configureComponentEntry(createChannelBlock());
  ch.componentGroupCount = 2;
  ch.mddataEntries[0].twiddleId = 7;
  ch.mddataEntries[0].groupFlags[1] = 1;
  ch.mddataEntries[0].listCounts[1] = 1;
  ch.mddataEntries[0].lists[1][0] = 1;
  ch.tonePool[1].coefficients[0] = 1;
  ch.tonePool[0].start = 1023;
  ch.tonePool[1].start = 0;

  const totalBits = nbitsForPackdataAt3(ch);
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  const packedBits = packMddataAt3(ch, out, totalBits);

  assert.equal(nbitsForComponent(ch), 69);
  assert.equal(totalBits, 176);
  assert.equal(packedBits, 176);
  assert.equal(ch.toneCount, 2);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [161, 0, 39, 209, 3, 248, 64, 2, 0, 0, 28, 0, 0, 0, 0, 0]
  );
});

test("packMddataAt3 preserves current multi-entry component ordering", () => {
  const ch = createChannelBlock();
  ch.mddataEntryIndex = 2;
  ch.componentMode = 0;
  ch.componentGroupCount = 1;

  for (const [entryIndex, tonePoolIndex] of [
    [0, 0],
    [1, 1],
  ]) {
    const entry = ch.mddataEntries[entryIndex];
    entry.huffTableSetIndex = 0;
    entry.huffTableBaseIndex = 2;
    entry.twiddleId = 0;
    entry.groupFlags[0] = 1;
    entry.listCounts[0] = 1;
    entry.lists[0][0] = tonePoolIndex;
    ch.tonePool[tonePoolIndex].coefficients[0] = 1;
  }

  const totalBits = nbitsForPackdataAt3(ch);
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  const packedBits = packMddataAt3(ch, out, totalBits);

  assert.equal(nbitsForComponent(ch), 75);
  assert.equal(totalBits, 179);
  assert.equal(packedBits, 179);
  assert.equal(ch.toneCount, 2);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [160, 2, 33, 16, 0, 128, 8, 68, 0, 32, 3, 128, 0, 0, 0, 0]
  );
});

test("packMddataAt3 preserves current spectrum-only packing behavior", () => {
  const scenarios = [
    {
      setup: (ch) => ch,
      bits: 115,
      bytes: [162, 0, 3, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      setup: (ch) => {
        ch.specTableIndex = 0;
        ch.idwl[0] = 1;
        return ch;
      },
      bits: 125,
      bytes: [162, 0, 3, 130, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  ];

  for (const { setup, bits, bytes } of scenarios) {
    const ch = setup(createChannelBlock());
    const totalBits = nbitsForPackdataAt3(ch);
    const out = new Uint8Array(Math.ceil(totalBits / 8));
    const packedBits = packMddataAt3(ch, out, totalBits);

    assert.equal(totalBits, bits);
    assert.equal(packedBits, bits);
    assert.deepEqual(Array.from(out.slice(0, bytes.length)), bytes);
  }
});

test("packMddataAt3 preserves current gain-control preamble ordering", () => {
  const ch = createChannelBlock();
  ch.componentGroupCount = 2;
  setAt3GainControlCount(ch.gaincParams[0], 2);
  setAt3GainControlEntry(ch.gaincParams[0], 0, 3, 6);
  setAt3GainControlEntry(ch.gaincParams[0], 1, 5, 9);
  setAt3GainControlCount(ch.gaincParams[1], 1);
  setAt3GainControlEntry(ch.gaincParams[1], 0, 4, 7);

  const totalBits = nbitsForPackdataAt3(ch);
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  const packedBits = packMddataAt3(ch, out, totalBits);

  assert.equal(totalBits, 139);
  assert.equal(packedBits, 139);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [161, 76, 57, 41, 114, 3, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("SCX pack bit accounting supports both explicit and gain-control layouts", () => {
  assert.equal(
    nbitsForAdjust({
      adjustEntries: Uint8Array.of(1, 2, 3),
      adjustBlockCount: 3,
    }),
    63
  );

  assert.equal(
    nbitsForAdjust({
      gaincParams: [Uint8Array.of(2), Uint8Array.of(1)],
      componentGroupCount: 2,
    }),
    33
  );

  assert.equal(
    nbitsForPackdata(
      {
        scratchFlag: 1,
        adjustEntries: Uint8Array.of(1),
        adjustBlockCount: 1,
      },
      20,
      30
    ),
    78
  );
  assert.equal(
    nbitsForPackdata({ adjustEntries: Uint8Array.of(1), adjustBlockCount: 1 }, AT3_NBITS_ERROR, 30),
    AT3_NBITS_ERROR
  );

  assert.throws(
    () =>
      nbitsForAdjust({
        adjustEntries: Uint8Array.of(1),
        adjustBlockCount: 2,
      }),
    /adjustBlockCount exceeds adjustEntries length/
  );
});

test("putChsunitAt3 preserves current output-offset advance behavior", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const ch = ctx.state.channelHistories[0].current;
  const totalBits = nbitsForPackdataAt3(ch);

  const referenceCtx = createAtrac3ScxEncoderContext();
  const reference = new Uint8Array(Math.ceil(totalBits / 8));
  assert.equal(
    packMddataAt3(referenceCtx.state.channelHistories[0].current, reference, totalBits),
    totalBits
  );

  const out = new Uint8Array(384);
  assert.equal(putChsunitAt3(ch, totalBits, out), totalBits);
  assert.equal(ch.packedNbytes, 15);
  assert.equal(ctx.state.outputOffset, ch.unitBytes);
  assert.deepEqual(Array.from(out.slice(0, reference.length)), Array.from(reference));
});

test("putChsunitAt3 preserves the current post-pack rejection for time2freq mode 2", () => {
  const ctx = createAtrac3ScxEncoderContext();
  ctx.state.time2freqMode = 2;
  const ch = ctx.state.channelHistories[0].current;
  const totalBits = nbitsForPackdataAt3(ch);

  const referenceCtx = createAtrac3ScxEncoderContext();
  const reference = new Uint8Array(Math.ceil(totalBits / 8));
  assert.equal(
    packMddataAt3(referenceCtx.state.channelHistories[0].current, reference, totalBits),
    totalBits
  );

  const out = new Uint8Array(384);
  assert.equal(putChsunitAt3(ch, totalBits, out), -1);
  assert.equal(ch.packedNbytes, 15);
  assert.equal(ctx.state.outputOffset, 0);
  assert.deepEqual(Array.from(out.slice(0, reference.length)), Array.from(reference));
});

test("putChsunitAt3 preserves current invalid output-offset rejection", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const ch = ctx.state.channelHistories[0].current;
  const totalBits = nbitsForPackdataAt3(ch);
  const out = new Uint8Array(384);

  ctx.state.outputOffset = out.length;

  assert.equal(putChsunitAt3(ch, totalBits, out), -1);
  assert.equal(ch.packedNbytes, 15);
  assert.equal(ctx.state.outputOffset, out.length);
  assert.deepEqual(Array.from(out.slice(0, 16)), new Array(16).fill(0));
});

test("putChsunitAt3 preserves current scratch-frame rejection state", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const ch = ctx.state.channelHistories[0].current;
  ch.scratchFlag = 1;
  const totalBits = nbitsForPackdataAt3(ch);

  const out = new Uint8Array(64);
  assert.equal(putChsunitAt3(ch, totalBits, out), -1);
  assert.equal(ch.packedNbytes, 16);
  assert.equal(ctx.state.outputOffset, 0);
  assert.deepEqual(Array.from(out.slice(0, 16)), new Array(16).fill(0));
});

test("nbitsForComponent preserves current invalid input contracts", () => {
  const invalidMode = createChannelBlock();
  invalidMode.mddataEntryIndex = 1;
  invalidMode.componentMode = 3;
  assert.equal(nbitsForComponent(invalidMode), -32768);

  const invalidTableSet = configureComponentEntry(createChannelBlock());
  invalidTableSet.mddataEntries[0].huffTableSetIndex = 2;
  assert.equal(nbitsForComponent(invalidTableSet), -32768);

  const invalidSlot = configureComponentEntry(createChannelBlock());
  invalidSlot.mddataEntries[0].lists[0][0] = 64;
  assert.equal(nbitsForComponent(invalidSlot), -32768);

  const invalidTwiddle = configureComponentEntry(createChannelBlock());
  invalidTwiddle.mddataEntries[0].twiddleId = 99;
  assert.equal(nbitsForComponent(invalidTwiddle), -32768);

  const missingEntries = createChannelBlock();
  missingEntries.mddataEntryIndex = 1;
  missingEntries.mddataEntries = null;
  assert.throws(() => nbitsForComponent(missingEntries), /mddataEntries must be an array/);
});

test("packMddataAt3 preserves current invalid component packing contract", () => {
  const invalidMode = createChannelBlock();
  invalidMode.mddataEntryIndex = 1;
  invalidMode.componentMode = 3;
  assert.equal(packMddataAt3(invalidMode, new Uint8Array(64), 256), -1);

  const invalidTableSet = configureComponentEntry(createChannelBlock());
  invalidTableSet.mddataEntries[0].huffTableSetIndex = 2;
  assert.equal(packMddataAt3(invalidTableSet, new Uint8Array(64), 256), -1);

  const invalidSlot = configureComponentEntry(createChannelBlock());
  invalidSlot.mddataEntries[0].lists[0][0] = 64;

  assert.equal(packMddataAt3(invalidSlot, new Uint8Array(64), 256), -1);
});

test("packMddataAt3 preserves current later component-header preflight rejection", () => {
  const ch = createChannelBlock();
  ch.mddataEntryIndex = 2;
  ch.componentMode = 0;
  ch.componentGroupCount = 1;

  for (const [entryIndex, tonePoolIndex] of [
    [0, 0],
    [1, 1],
  ]) {
    const entry = ch.mddataEntries[entryIndex];
    entry.huffTableSetIndex = 0;
    entry.huffTableBaseIndex = 2;
    entry.twiddleId = 0;
    entry.groupFlags[0] = 1;
    entry.listCounts[0] = 1;
    entry.lists[0][0] = tonePoolIndex;
    ch.tonePool[tonePoolIndex].coefficients[0] = 1;
  }

  ch.mddataEntries[1].huffTableSetIndex = 2;

  const out = new Uint8Array(32);
  assert.equal(packMddataAt3(ch, out, 256), -1);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [160, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("packMddataAt3 preserves current missing gain-control contract", () => {
  const ch = createChannelBlock();
  ch.gaincParams[0] = null;

  assert.equal(packMddataAt3(ch, new Uint8Array(64), 256), -1);
});

test("packMddataAt3 preserves current later gain-control preflight rejection", () => {
  const ch = createChannelBlock();
  ch.componentGroupCount = 2;
  setAt3GainControlCount(ch.gaincParams[0], 1);
  setAt3GainControlEntry(ch.gaincParams[0], 0, 4, 7);
  ch.gaincParams[1] = { 0: 2, 1: 3, 2: 5, 8: 6, 9: "bad" };

  const out = new Uint8Array(32);
  assert.equal(packMddataAt3(ch, out, 256), -1);
  assert.ok(ch.mddataPackError instanceof Error);
  assert.match(ch.mddataPackError.message, /array-like numeric buffer/);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [161, 46, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("packMddataAt3 preserves current missing component entries contract", () => {
  const ch = createChannelBlock();
  ch.mddataEntryIndex = 1;
  ch.mddataEntries = null;

  assert.equal(packMddataAt3(ch, new Uint8Array(64), 256), -1);
});

test("packMddataAt3 preserves current missing spectrum metadata contract", () => {
  const ch = createChannelBlock();
  ch.quidsf = null;

  assert.equal(packMddataAt3(ch, new Uint8Array(64), 256), -1);
});

test("packMddataAt3 preserves current invalid spectrum packing contract", () => {
  const invalidIdwl = createChannelBlock();
  invalidIdwl.idwl[0] = -1;
  assert.equal(packMddataAt3(invalidIdwl, new Uint8Array(64), 256), -1);

  const invalidBandWidth = createChannelBlock();
  invalidBandWidth.idwl[0] = 8;
  assert.equal(packMddataAt3(invalidBandWidth, new Uint8Array(64), 256), -1);

  const invalidTable = createChannelBlock();
  invalidTable.specTableIndex = 9;
  assert.equal(packMddataAt3(invalidTable, new Uint8Array(64), 256), -1);
});

test("packMddataAt3 preserves current spectrum header writes before invalid-band rejection", () => {
  const invalidIdwl = createChannelBlock();
  invalidIdwl.idwl[0] = -1;
  const invalidIdwlOut = new Uint8Array(16);

  assert.equal(packMddataAt3(invalidIdwl, invalidIdwlOut, 256), -1);
  assert.deepEqual(
    Array.from(invalidIdwlOut),
    [162, 0, 3, 142, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );

  const invalidBandWidth = createChannelBlock();
  invalidBandWidth.idwl[0] = 8;
  const invalidBandWidthOut = new Uint8Array(16);

  assert.equal(packMddataAt3(invalidBandWidth, invalidBandWidthOut, 256), -1);
  assert.deepEqual(
    Array.from(invalidBandWidthOut),
    [162, 0, 3, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("packMddataAt3 preserves current scratch-frame rejection", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 1;

  assert.equal(packMddataAt3(ch, new Uint8Array(64), 256), -1);
});

test("nbitsForSpectrum and nbitsForPackdataAt3 preserve current default bit counts", () => {
  const ch = createChannelBlock();

  assert.equal(nbitsForSpectrum(ch), 93);
  assert.equal(nbitsForPackdataAt3(ch), 115);
});

test("nbitsForSpectrum preserves current active-band bit counting", () => {
  const ch = createChannelBlock();
  ch.specTableIndex = 0;
  ch.idwl[0] = 1;

  assert.equal(nbitsForSpectrum(ch), 103);
  assert.equal(nbitsForPackdataAt3(ch), 125);
});

test("packMddataAt3 preserves current sparse multi-band spectrum ordering", () => {
  const ch = createChannelBlock();
  ch.specTableIndex = 0;
  ch.idwl[0] = 1;
  ch.idwl[2] = 2;

  const totalBits = nbitsForPackdataAt3(ch);
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  const packedBits = packMddataAt3(ch, out, totalBits);

  assert.equal(nbitsForSpectrum(ch), 117);
  assert.equal(totalBits, 139);
  assert.equal(packedBits, 139);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [162, 0, 3, 130, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("packMddataAt3 preserves sparse spectrum scalefactor and payload ordering", () => {
  const ch = createChannelBlock();
  ch.specTableIndex = 0;
  ch.idwl[0] = 1;
  ch.idwl[2] = 2;
  ch.quidsf[0] = 5;
  ch.quidsf[2] = 17;
  ch.quantSpecs[0] = 1;
  ch.quantSpecs[16] = 1;

  const totalBits = nbitsForPackdataAt3(ch);
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  const packedBits = packMddataAt3(ch, out, totalBits);

  assert.equal(nbitsForSpectrum(ch), 122);
  assert.equal(totalBits, 144);
  assert.equal(packedBits, 144);
  assert.deepEqual(
    Array.from(out.slice(0, 18)),
    [162, 0, 3, 130, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 163, 130, 0]
  );
});

test("nbitsForSpectrum preserves current invalid input contracts", () => {
  const invalidIdwl = createChannelBlock();
  invalidIdwl.idwl[0] = -1;
  assert.equal(nbitsForSpectrum(invalidIdwl), -32768);

  const invalidBandWidth = createChannelBlock();
  invalidBandWidth.idwl[0] = 8;
  assert.equal(nbitsForSpectrum(invalidBandWidth), -32768);

  const invalidTable = createChannelBlock();
  invalidTable.specTableIndex = 9;
  assert.equal(nbitsForSpectrum(invalidTable), -32768);
  assert.equal(nbitsForPackdataAt3(invalidTable), -32768);

  const missingIdwl = createChannelBlock();
  missingIdwl.idwl = null;
  assert.throws(() => nbitsForSpectrum(missingIdwl), /idwl must be present/);
});
