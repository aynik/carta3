import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  idwlWorkMode2SymbolsView,
  idwlWorkSetMode1Base,
  idwlWorkSetMode1Lead,
  idwlWorkSetMode1Width,
  idwlWorkSetMode2PairFlag,
  idwlWorkSetMode2ShapeBase,
  idwlWorkSetMode2ShapeShift,
} from "../../../src/atrac3plus/bitstream/idwl-work.js";
import { AT5_ISPS, AT5_NSPS } from "../../../src/atrac3plus/tables/unpack.js";
import {
  at5CopyIdwlState,
  initQuantOffsets,
} from "../../../src/atrac3plus/channel-block/internal.js";
import { at5InitQuantOffsets } from "../../../src/atrac3plus/channel-block/quant-bootstrap.js";
import {
  at5RecomputeMissingCtxCostsAndSelect,
  at5RecomputeTotalBits,
  at5TrimHighBandsToFit,
  selectBestHcspecCostForBand,
} from "../../../src/atrac3plus/channel-block/core.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";

function createIdwlScratch({
  bestConfigSlot = 0,
  cfg = [0, 0, 0, 0, 0],
  rowIndex = 0,
  rowValues = [],
} = {}) {
  const rowSeq = Array.from({ length: 4 }, () => new Int32Array(32));
  rowSeq[rowIndex].set(Int32Array.from(rowValues));
  const cfgBySlot = Array.from({ length: 4 }, () => new Int32Array(5));
  cfgBySlot[bestConfigSlot & 3] = Int32Array.from(cfg);

  return {
    bestConfigSlot,
    slot0Config: cfgBySlot[0],
    slot1Config: cfgBySlot[1],
    slot2Config: cfgBySlot[2],
    slot3Config: cfgBySlot[3],
    rowSeq,
  };
}

function createTrimSetup({
  channelCount = 2,
  band = 18,
  bandCount = band + 1,
  bitLimit = 150,
  bitsTotal = 400,
  baseBits = 100,
  mode3Masked = false,
  activeChannels = [0, 1],
} = {}) {
  const { channels } = createAt5RegularBlockState(channelCount);
  const hdr = createBitallocHeader(channelCount);
  hdr.bitsTotalBase = baseBits;
  hdr.bitsTotal = bitsTotal;
  hdr.mode3BandMask[band] = mode3Masked ? 1 : 0;

  const start = AT5_ISPS[band] >>> 0;
  const end = start + (AT5_NSPS[band] >>> 0);
  const blocks = Array.from({ length: channelCount }, () => createChannelBlock());
  const specs = Array.from({ length: channelCount }, () => new Float32Array(2048));

  for (let ch = 0; ch < channelCount; ch += 1) {
    const channel = channels[ch];
    const block = blocks[ch];
    block.bitallocHeader = hdr;
    block.quantizedSpectrum = specs[ch];
    block.bitDeltaByCtx[0] = 150;
    block.normalizedBandPeaks[band] = 1;
    channel.rebitallocCtxId = 0;
    if (activeChannels.includes(ch)) {
      channel.idwl.values[band] = 1;
    }
    specs[ch].fill(ch + 1, start, end);
  }

  return { band, bandCount, bitLimit, blocks, channels, hdr, specs, start };
}

test("at5CopyIdwlState preserves mode-1 work payload", () => {
  const idwlWork = new Uint8Array(16);
  idwlWorkSetMode1Lead(idwlWork, 3);
  idwlWorkSetMode1Width(idwlWork, 11);
  idwlWorkSetMode1Base(idwlWork, 27);

  const channel = {
    idwl: {
      encodeValues: null,
      encodeSymbols: null,
    },
  };
  const block = {
    idwlScratch: createIdwlScratch({
      bestConfigSlot: 1,
      cfg: [5, 4, 6, 2, 1],
      rowIndex: 1,
      rowValues: Array.from({ length: 32 }, (_, index) => 20 + index),
    }),
    idwlWork,
  };

  at5CopyIdwlState([block], [channel], 1);

  assert.equal(channel.idwlPackMode, 1);
  assert.equal(channel.idwl.wl, 5);
  assert.equal(channel.idwl.mode, 4);
  assert.equal(channel.idwl.count, 6);
  assert.equal(channel.idwl.extra, 2);
  assert.equal(channel.idwl.wlc, 1);
  assert.equal(channel.idwl.lead, 3);
  assert.equal(channel.idwl.width, 11);
  assert.equal(channel.idwl.base, 27);
  assert.deepEqual(Array.from(channel.idwl.encodeValues.slice(0, 4)), [20, 21, 22, 23]);
});

test("at5CopyIdwlState preserves mode-2 work payload and pair flags", () => {
  const idwlWork = new Uint8Array(0x9f8 - 0x768);
  idwlWorkMode2SymbolsView(idwlWork, 0).set([0, 0, 5, 0, 0, 0], 0);
  idwlWorkSetMode2ShapeShift(idwlWork, 0, 0x11223344);
  idwlWorkSetMode2ShapeBase(idwlWork, 0, 0x55667788);
  idwlWorkSetMode2PairFlag(idwlWork, 1);

  const channel = {
    idwl: {
      encodeValues: null,
      encodeSymbols: null,
    },
    idwlState: {
      shared: {
        pairCount: 0,
        pairFlags: new Uint32Array(16),
      },
    },
  };
  channel.idwlState.shared.pairFlags.fill(1);
  const block = {
    idwlScratch: createIdwlScratch({
      bestConfigSlot: 2,
      cfg: [7, 0, 6, 9, 2],
      rowIndex: 2,
      rowValues: Array.from({ length: 32 }, (_, index) => 100 + index),
    }),
    idwlWork,
  };

  at5CopyIdwlState([block], [channel], 1);

  assert.equal(channel.idwlPackMode, 2);
  assert.equal(channel.idwl.wl, 7);
  assert.equal(channel.idwl.mode, 0);
  assert.equal(channel.idwl.count, 6);
  assert.equal(channel.idwl.extra, 9);
  assert.equal(channel.idwl.wlc, 2);
  assert.deepEqual(Array.from(channel.idwl.encodeValues.slice(0, 4)), [100, 101, 102, 103]);
  assert.equal(channel.idwl.shapeShift, 0x11223344);
  assert.equal(channel.idwl.shapeBase, 0x55667788);
  assert.equal(channel.idwl.pairFlag, 1);
  assert.deepEqual(Array.from(channel.idwl.encodeSymbols.slice(0, 6)), [0, 0, 5, 0, 0, 0]);
  assert.equal(channel.idwlState.shared.pairCount, 3);
  assert.deepEqual(Array.from(channel.idwlState.shared.pairFlags.slice(0, 5)), [1, 0, 1, 0, 0]);
});

test("at5CopyIdwlState falls back to block0 shared mode-2 state", () => {
  const idwlWork = new Uint8Array(0x9f8 - 0x768);
  idwlWorkMode2SymbolsView(idwlWork, 0).set([0, 0, 5, 0], 0);
  idwlWorkSetMode2ShapeShift(idwlWork, 0, 0x01020304);
  idwlWorkSetMode2ShapeBase(idwlWork, 0, 0x05060708);
  idwlWorkSetMode2PairFlag(idwlWork, 1);

  const shared = {
    pairCount: 0,
    pairFlags: new Uint32Array(16),
  };
  shared.pairFlags.fill(9);

  const channel = {
    idwl: {
      encodeValues: null,
      encodeSymbols: null,
    },
    block0: {
      idwlState: { shared },
    },
  };
  const block = {
    idwlScratch: createIdwlScratch({
      bestConfigSlot: 2,
      cfg: [6, 0, 4, 3, 1],
      rowIndex: 1,
      rowValues: Array.from({ length: 32 }, (_, index) => 60 + index),
    }),
    idwlWork,
  };

  at5CopyIdwlState([block], [channel], 1);

  assert.equal(channel.idwlPackMode, 2);
  assert.equal(channel.idwl.shapeShift, 0x01020304);
  assert.equal(channel.idwl.shapeBase, 0x05060708);
  assert.equal(channel.idwl.pairFlag, 1);
  assert.deepEqual(Array.from(channel.idwl.encodeValues.slice(0, 4)), [60, 61, 62, 63]);
  assert.deepEqual(Array.from(channel.idwl.encodeSymbols.slice(0, 4)), [0, 0, 5, 0]);
  assert.equal(shared.pairCount, 2);
  assert.deepEqual(Array.from(shared.pairFlags.slice(0, 4)), [1, 0, 0, 0]);
});

test("at5CopyIdwlState copies scratch config for every channel but only channel 0 loads work", () => {
  const mode1Work = new Uint8Array(16);
  idwlWorkSetMode1Lead(mode1Work, 9);
  idwlWorkSetMode1Width(mode1Work, 13);
  idwlWorkSetMode1Base(mode1Work, 17);

  const ignoredMode2Work = new Uint8Array(0x9f8 - 0x768);
  idwlWorkMode2SymbolsView(ignoredMode2Work, 0).set([0, 0, 6, 0, 0, 0], 0);
  idwlWorkSetMode2ShapeShift(ignoredMode2Work, 0, 0x12345678);
  idwlWorkSetMode2ShapeBase(ignoredMode2Work, 0, 0x9abcdef0);
  idwlWorkSetMode2PairFlag(ignoredMode2Work, 1);

  const channels = [
    {
      idwl: {
        shapeShift: 0,
        shapeBase: 0,
        pairFlag: 0,
        encodeValues: null,
        encodeSymbols: null,
      },
    },
    {
      idwl: {
        shapeShift: 0,
        shapeBase: 0,
        pairFlag: 0,
        encodeValues: null,
        encodeSymbols: Uint32Array.from({ length: 32 }, (_, index) => 700 + index),
      },
      idwlState: {
        shared: {
          pairCount: 0,
          pairFlags: new Uint32Array(16),
        },
      },
    },
  ];
  channels[1].idwlState.shared.pairFlags.fill(7);

  const blocks = [
    {
      idwlScratch: createIdwlScratch({
        bestConfigSlot: 1,
        cfg: [3, 2, 4, 1, 1],
        rowIndex: 1,
        rowValues: Array.from({ length: 32 }, (_, index) => 40 + index),
      }),
      idwlWork: mode1Work,
    },
    {
      idwlScratch: createIdwlScratch({
        bestConfigSlot: 2,
        cfg: [8, 0, 6, 5, 2],
        rowIndex: 2,
        rowValues: Array.from({ length: 32 }, (_, index) => 140 + index),
      }),
      idwlWork: ignoredMode2Work,
    },
  ];

  at5CopyIdwlState(blocks, channels, 2);

  assert.equal(channels[0].idwlPackMode, 1);
  assert.equal(channels[0].idwl.lead, 9);
  assert.equal(channels[0].idwl.width, 13);
  assert.equal(channels[0].idwl.base, 17);
  assert.deepEqual(Array.from(channels[0].idwl.encodeValues.slice(0, 4)), [40, 41, 42, 43]);

  assert.equal(channels[1].idwlPackMode, 2);
  assert.equal(channels[1].idwl.wl, 8);
  assert.equal(channels[1].idwl.mode, 0);
  assert.equal(channels[1].idwl.count, 6);
  assert.equal(channels[1].idwl.extra, 5);
  assert.equal(channels[1].idwl.wlc, 2);
  assert.deepEqual(Array.from(channels[1].idwl.encodeValues.slice(0, 4)), [140, 141, 142, 143]);
  assert.equal(channels[1].idwl.shapeShift, 0);
  assert.equal(channels[1].idwl.shapeBase, 0);
  assert.equal(channels[1].idwl.pairFlag, 0);
  assert.deepEqual(Array.from(channels[1].idwl.encodeSymbols.slice(0, 4)), [700, 701, 702, 703]);
  assert.equal(channels[1].idwlState.shared.pairCount, 0);
  assert.deepEqual(Array.from(channels[1].idwlState.shared.pairFlags.slice(0, 4)), [7, 7, 7, 7]);
});

test("selectBestHcspecCostForBand keeps the first cheapest candidate on ties", () => {
  const work = {
    costsByBand: Uint16Array.from([9, 4, 4, 5, 0, 0, 0, 0]),
    bestIndexByBand: new Int32Array(1),
  };

  const bestCost = selectBestHcspecCostForBand(work, 0, 4);

  assert.equal(bestCost, 4);
  assert.equal(work.bestIndexByBand[0], 1);
});

test("at5TrimHighBandsToFit zeros both stereo spectra for masked mode-3 bands", () => {
  const { band, bandCount, bitLimit, blocks, channels, hdr, specs, start } = createTrimSetup({
    mode3Masked: true,
    bitLimit: 150,
  });

  at5TrimHighBandsToFit(blocks, specs, channels, hdr, 2, bandCount, bitLimit);

  assert.equal(blocks[0].quantOffsetByBand[band], 0x0f);
  assert.equal(blocks[1].quantOffsetByBand[band], 0x0f);
  assert.equal(specs[0][start], 0);
  assert.equal(specs[1][start], 0);
  assert.ok(hdr.bitsTotal <= bitLimit);
});

test("at5TrimHighBandsToFit clears a masked stereo pair even when only one channel is active", () => {
  const { band, bandCount, bitLimit, blocks, channels, hdr, specs, start } = createTrimSetup({
    mode3Masked: true,
    bitLimit: 300,
    activeChannels: [0],
  });

  at5TrimHighBandsToFit(blocks, specs, channels, hdr, 2, bandCount, bitLimit);

  assert.equal(blocks[0].quantOffsetByBand[band], 0x0f);
  assert.equal(blocks[1].quantOffsetByBand[band], 0x00);
  assert.equal(specs[0][start], 0);
  assert.equal(specs[1][start], 0);
  assert.ok(hdr.bitsTotal <= bitLimit);
});

test("at5TrimHighBandsToFit only clears the active unmasked channel", () => {
  const { band, bandCount, bitLimit, blocks, channels, hdr, specs, start } = createTrimSetup({
    mode3Masked: false,
    bitLimit: 300,
    activeChannels: [0],
  });

  at5TrimHighBandsToFit(blocks, specs, channels, hdr, 2, bandCount, bitLimit);

  assert.equal(blocks[0].quantOffsetByBand[band], 0x0f);
  assert.equal(blocks[1].quantOffsetByBand[band], 0x00);
  assert.equal(specs[0][start], 0);
  assert.equal(specs[1][start], 2);
  assert.ok(hdr.bitsTotal <= bitLimit);
});

test("at5TrimHighBandsToFit skips inactive tail bands before trimming a lower active band", () => {
  const { band, bandCount, bitLimit, blocks, channels, hdr, specs, start } = createTrimSetup({
    mode3Masked: false,
    bitLimit: 300,
    activeChannels: [0],
    bandCount: 20,
  });
  const inactiveBandStart = AT5_ISPS[bandCount - 1] >>> 0;

  specs[0][inactiveBandStart] = 9;
  specs[1][inactiveBandStart] = 8;

  at5TrimHighBandsToFit(blocks, specs, channels, hdr, 2, bandCount, bitLimit);

  assert.equal(blocks[0].quantOffsetByBand[band], 0x0f);
  assert.equal(blocks[1].quantOffsetByBand[band], 0x00);
  assert.equal(specs[0][start], 0);
  assert.equal(specs[1][start], 2);
  assert.equal(specs[0][inactiveBandStart], 9);
  assert.equal(specs[1][inactiveBandStart], 8);
  assert.ok(hdr.bitsTotal <= bitLimit);
});

test("at5RecomputeTotalBits preserves active-context accumulation", () => {
  const hdr = { bitsTotalBase: 100, bitsTotal: 0 };
  const blocks = [
    { bitDeltaByCtx: Uint16Array.from([10, 20]) },
    { bitDeltaByCtx: Uint16Array.from([30, 40]) },
  ];
  const channels = [{ rebitallocCtxId: 1 }, { rebitallocCtxId: 0 }];

  const total = at5RecomputeTotalBits(hdr, blocks, channels, 2);

  assert.equal(total, 150);
  assert.equal(hdr.bitsTotal, 150);
});

test("at5RecomputeMissingCtxCostsAndSelect only recomputes the alternate context", () => {
  const hdr = createBitallocHeader(1);
  hdr.tblIndex = 99;

  const [firstChannel] = createAt5RegularBlockState(1).channels;
  firstChannel.rebitallocCtxId = 1;
  const firstBlock = createChannelBlock();
  firstBlock.bitallocHeader = hdr;
  firstBlock.quantizedSpectrum = new Float32Array(2048);
  firstBlock.bitDeltaByCtx.set([123, 9]);

  const [secondChannel] = createAt5RegularBlockState(1).channels;
  secondChannel.rebitallocCtxId = 0;
  const secondBlock = createChannelBlock();
  secondBlock.bitallocHeader = hdr;
  secondBlock.quantizedSpectrum = new Float32Array(2048);
  secondBlock.bitDeltaByCtx.set([0, 123]);

  at5RecomputeMissingCtxCostsAndSelect(
    [firstBlock, secondBlock],
    [firstChannel, secondChannel],
    2,
    8
  );

  assert.equal(firstBlock.bitDeltaByCtx[0], 0);
  assert.equal(firstBlock.bitDeltaByCtx[1], 9);
  assert.equal(firstChannel.rebitallocCtxId, 0);

  assert.equal(secondBlock.bitDeltaByCtx[0], 0);
  assert.equal(secondBlock.bitDeltaByCtx[1], 0);
  assert.equal(secondChannel.rebitallocCtxId, 0);
});

test("at5InitQuantOffsets shares the exact-path seed logic before live high-band boosts", () => {
  const bandCount = 20;
  const seededIdwlModesByBand = new Int32Array(32);
  const quantUnitsByBand = new Int32Array(32);
  seededIdwlModesByBand[6] = 1;
  seededIdwlModesByBand[18] = 1;
  quantUnitsByBand[6] = 6;
  quantUnitsByBand[18] = 13;

  const runtimeBlock = {
    channelsInBlock: 1,
    shared: {
      coreMode: 0,
      sampleRateHz: 44100,
    },
  };
  const [expected] = initQuantOffsets(runtimeBlock, bandCount, {
    bootstrapByChannel: [{ seededIdwlModesByBand, quantUnitsByBand }],
  });

  const hdr = createBitallocHeader(1);
  const [channel] = createAt5RegularBlockState(1).channels;
  const block = createChannelBlock();
  channel.idwl.values.set(seededIdwlModesByBand);
  block.quantUnitsByBand.set(quantUnitsByBand);
  block.hcspecWorkByCtx[0].bestIndexByBand[18] = 3;
  block.hcspecWorkByCtx[0].costsByBand[(18 << 3) + 3] = 0x47;

  at5InitQuantOffsets([block], [channel], hdr, 1, bandCount, 0, 44100);

  assert.deepEqual(
    Array.from(block.quantOffsetByBand.slice(0, 0x12)),
    Array.from(expected.slice(0, 0x12))
  );
  assert.equal(block.quantOffsetByBand[18], Math.min(0x0f, expected[18] + 1));
});

test("at5InitQuantOffsets preserves high-band boost thresholds across quant-unit ranges", () => {
  const bandCount = 25;
  const seededIdwlModesByBand = new Int32Array(32);
  const quantUnitsByBand = new Int32Array(32);
  seededIdwlModesByBand[18] = seededIdwlModesByBand[22] = seededIdwlModesByBand[24] = 1;
  quantUnitsByBand[18] = 12;
  quantUnitsByBand[22] = 15;
  quantUnitsByBand[24] = 18;

  const runtimeBlock = {
    channelsInBlock: 1,
    shared: {
      coreMode: 0,
      sampleRateHz: 44100,
    },
  };
  const [expected] = initQuantOffsets(runtimeBlock, bandCount, {
    bootstrapByChannel: [{ seededIdwlModesByBand, quantUnitsByBand }],
  });

  const hdr = createBitallocHeader(1);
  const [channel] = createAt5RegularBlockState(1).channels;
  const block = createChannelBlock();
  channel.idwl.values.set(seededIdwlModesByBand);
  block.quantUnitsByBand.set(quantUnitsByBand);
  block.hcspecWorkByCtx[0].bestIndexByBand[18] = 1;
  block.hcspecWorkByCtx[0].costsByBand[(18 << 3) + 1] = 0x3d;
  block.hcspecWorkByCtx[0].bestIndexByBand[22] = 2;
  block.hcspecWorkByCtx[0].costsByBand[(22 << 3) + 2] = 0x47;
  block.hcspecWorkByCtx[0].bestIndexByBand[24] = 3;
  block.hcspecWorkByCtx[0].costsByBand[(24 << 3) + 3] = 0x51;

  at5InitQuantOffsets([block], [channel], hdr, 1, bandCount, 0, 44100);

  assert.equal(block.quantOffsetByBand[18], Math.min(0x0f, expected[18] + 2));
  assert.equal(block.quantOffsetByBand[22], Math.min(0x0f, expected[22] + 2));
  assert.equal(block.quantOffsetByBand[24], Math.min(0x0f, expected[24] + 2));
});

test("at5InitQuantOffsets skips live high-band boosts in higher core modes", () => {
  const bandCount = 20;
  const coreMode = 0x10;
  const seededIdwlModesByBand = new Int32Array(32);
  const quantUnitsByBand = new Int32Array(32);
  seededIdwlModesByBand[18] = 1;
  quantUnitsByBand[18] = 12;

  const runtimeBlock = {
    channelsInBlock: 1,
    shared: {
      coreMode,
      sampleRateHz: 44100,
    },
  };
  const [expected] = initQuantOffsets(runtimeBlock, bandCount, {
    bootstrapByChannel: null,
  });

  const hdr = createBitallocHeader(1);
  const [channel] = createAt5RegularBlockState(1).channels;
  const block = createChannelBlock();
  channel.idwl.values.set(seededIdwlModesByBand);
  block.quantUnitsByBand.set(quantUnitsByBand);
  block.hcspecWorkByCtx[0].bestIndexByBand[18] = 1;
  block.hcspecWorkByCtx[0].costsByBand[(18 << 3) + 1] = 0x7f;

  at5InitQuantOffsets([block], [channel], hdr, 1, bandCount, coreMode, 44100);

  assert.deepEqual(
    Array.from(block.quantOffsetByBand.slice(0, bandCount)),
    Array.from(expected.slice(0, bandCount))
  );
});
