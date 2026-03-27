import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  createBitallocHeader,
  createChannelBlock,
  createAt5IdwlScratch,
} from "../../../src/atrac3plus/channel-block/construction.js";
import {
  raiseIdwlModesWithinBudget,
  relaxQuantOffsetsWithinBudget,
  tryRaiseIdwlModeWithinBudget,
} from "../../../src/atrac3plus/channel-block/late-budget.js";

function createLateBudgetFixture({
  channelCount = 1,
  bandCount = 1,
  bitLimit = 100,
  bitsTotal = 20,
  bitsTotalBase = 20,
  bitsIdwl = 0,
  bitsIdct = 0,
  baseBits = 4,
  idwlInitialized = 0,
  bandLimit = bandCount,
} = {}) {
  const regularBlock = createAt5RegularBlockState(channelCount);
  regularBlock.shared.encodeFlags = 0;
  regularBlock.shared.sampleRateHz = 44100;
  regularBlock.shared.bandLimit = Math.max(1, bandLimit);

  const channels = regularBlock.channels;
  const blocks = Array.from({ length: channelCount }, () => createChannelBlock());
  const hdr = createBitallocHeader(channelCount);

  Object.assign(hdr, {
    bitsTotal,
    bitsTotalBase,
    bitsIdwl,
    bitsIdct,
    baseBits,
    idwlEnabled: 1,
    idwlInitialized,
    tblIndex: 0,
  });

  const sharedWork = blocks[0].idwlWork;
  for (let ch = 0; ch < channelCount; ch += 1) {
    const block = blocks[ch];
    block.bitallocHeader = hdr;
    block.quantizedSpectrum = new Float32Array(2048);
    block.quantizedSpectrum.fill(0.25, 0, 16);
    block.idwlScratch.work = sharedWork;
    hdr.hcspecTblA[ch] = block.hcspecWorkByCtx[0];
    hdr.hcspecTblB[ch] = block.hcspecWorkByCtx[0];

    channels[ch].rebitallocCtxId = 0;
    channels[ch].blockState = { encodeMode: 0 };
    channels[ch].sharedAux = { intensityBand: Int32Array.from([0]) };
  }

  return { hdr, blocks, channels, bandCount, bitLimit };
}

function createRaiseScratchLanes(blocks, channels) {
  const scratchWork = new Uint8Array(blocks[0]?.idwlWork?.length ?? 0x290);
  return {
    activeIdwlScratchByChannel: blocks.map((block) => block?.idwlScratch ?? null),
    rollbackIdwlScratchByChannel: channels.map((channel, index) =>
      channel && blocks[index] ? createAt5IdwlScratch(scratchWork) : null
    ),
  };
}

function createLateIdwlRaiseContext(fixture, overrides = {}) {
  return {
    hdr: fixture.hdr,
    blocks: fixture.blocks,
    channels: fixture.channels,
    channelCount: fixture.channels.length,
    bitBudget: fixture.bitLimit,
    rebasedIdctBitCount: 0,
    encodeMode: fixture.channels[0]?.blockState?.encodeMode ?? 0,
    ...createRaiseScratchLanes(fixture.blocks, fixture.channels),
    ...overrides,
  };
}

function runTryRaiseIdwlModeWithinBudget(fixture, band, channelIndex, overrides = {}) {
  return tryRaiseIdwlModeWithinBudget(
    createLateIdwlRaiseContext(fixture, overrides),
    band,
    channelIndex
  );
}

function runRaiseIdwlModesWithinBudget(fixture, overrides = {}) {
  return raiseIdwlModesWithinBudget(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    overrides.bandCount ?? fixture.bandCount,
    overrides.bitLimit ?? fixture.bitLimit,
    overrides.latePriority
  );
}

function runRelaxQuantOffsetsWithinBudget(fixture, overrides = {}) {
  return relaxQuantOffsetsWithinBudget(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    overrides.bandCount ?? fixture.bandCount,
    overrides.bitLimit ?? fixture.bitLimit,
    overrides.latePriority
  );
}

function createLatePriority({
  orderedBandSlots = new Int32Array(0),
  stereoBandsByPriority = new Int32Array(0),
} = {}) {
  return {
    bandScores: new Int32Array(Math.max(1, orderedBandSlots.length)),
    orderedBandSlots,
    stereoScores: new Int32Array(Math.max(1, stereoBandsByPriority.length)),
    stereoBandsByPriority,
    stereoBandCount: stereoBandsByPriority.length,
  };
}

test("tryRaiseIdwlModeWithinBudget restores the original mode and active work when the budget overflows", () => {
  const fixture = createLateBudgetFixture({ bitLimit: 30 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;
  fixture.hdr.hcspecTblA[0] = block.hcspecWorkByCtx[0];
  fixture.hdr.hcspecTblB[0] = block.hcspecWorkByCtx[1];
  block.hcspecWorkByCtx[0].costsByBand.set(Uint16Array.from([9, 8, 7, 6, 5, 4, 3, 2]), 0);
  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const changed = runTryRaiseIdwlModeWithinBudget(fixture, 0, 0);

  assert.equal(changed, false);
  assert.equal(channel.idwl.values[0], 1);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(block.rebitallocScratch.specIndexByBand[0], 0);
  assert.deepEqual(
    Array.from(block.hcspecWorkByCtx[0].costsByBand.slice(0, 8)),
    [9, 8, 7, 6, 5, 4, 3, 2]
  );
  assert.equal(block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsIdwl, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsTotal, 20);
});

test("tryRaiseIdwlModeWithinBudget applies candidate work tables when the raised mode fits", () => {
  const fixture = createLateBudgetFixture({ bitLimit: 61 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;
  fixture.hdr.hcspecTblA[0] = block.hcspecWorkByCtx[0];
  fixture.hdr.hcspecTblB[0] = block.hcspecWorkByCtx[1];
  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const changed = runTryRaiseIdwlModeWithinBudget(fixture, 0, 0);

  assert.equal(changed, true);
  assert.equal(channel.idwl.values[0], 2);
  assert.equal(channel.idct.values[0], 0);
  assert.deepEqual(
    Array.from(block.hcspecWorkByCtx[0].costsByBand.slice(0, 8)),
    Array.from(block.hcspecWorkByCtx[1].costsByBand.slice(0, 8))
  );
  assert.equal(block.bitDeltaByCtx[0], 36);
  assert.equal(fixture.hdr.bitsIdwl, 5);
  assert.equal(fixture.hdr.bitsTotalBase, 25);
  assert.equal(fixture.hdr.bitsTotal, 61);
});

test("tryRaiseIdwlModeWithinBudget keeps late-budget base bits anchored to the rebased IDCT total", () => {
  const fixture = createLateBudgetFixture({ bitLimit: 61 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;
  fixture.hdr.hcspecTblA[0] = block.hcspecWorkByCtx[0];
  fixture.hdr.hcspecTblB[0] = block.hcspecWorkByCtx[1];
  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const changed = runTryRaiseIdwlModeWithinBudget(fixture, 0, 0, {
    rebasedIdctBitCount: 3,
  });

  assert.equal(changed, true);
  assert.equal(channel.idwl.values[0], 2);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(block.bitDeltaByCtx[0], 33);
  assert.equal(fixture.hdr.bitsIdwl, 5);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 28);
  assert.equal(fixture.hdr.bitsTotal, 61);
});

test("tryRaiseIdwlModeWithinBudget only copies the accepted band's HCSPEC costs", () => {
  const fixture = createLateBudgetFixture({ bandCount: 2, bitLimit: 61 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;
  fixture.hdr.hcspecTblA[0] = block.hcspecWorkByCtx[0];
  fixture.hdr.hcspecTblB[0] = block.hcspecWorkByCtx[1];
  block.hcspecWorkByCtx[0].costsByBand.set(
    Uint16Array.from([9, 8, 7, 6, 5, 4, 3, 2, 19, 18, 17, 16, 15, 14, 13, 12]),
    0
  );
  block.hcspecWorkByCtx[1].costsByBand.set(
    Uint16Array.from([29, 28, 27, 26, 25, 24, 23, 22, 39, 38, 37, 36, 35, 34, 33, 32]),
    0
  );
  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const changed = runTryRaiseIdwlModeWithinBudget(fixture, 0, 0);

  assert.equal(changed, true);
  assert.deepEqual(
    Array.from(block.hcspecWorkByCtx[0].costsByBand.slice(0, 8)),
    Array.from(block.hcspecWorkByCtx[1].costsByBand.slice(0, 8))
  );
  assert.deepEqual(
    Array.from(block.hcspecWorkByCtx[0].costsByBand.slice(8, 16)),
    [19, 18, 17, 16, 15, 14, 13, 12]
  );
});

test("raiseIdwlModesWithinBudget keeps rejected IDWL increases rolled back", () => {
  const fixture = createLateBudgetFixture({ bitLimit: 30 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const total = runRaiseIdwlModesWithinBudget(fixture, {
    latePriority: createLatePriority({
      orderedBandSlots: Int32Array.from([0]),
      stereoBandsByPriority: Int32Array.from([0]),
    }),
  });

  assert.equal(total, 20);
  assert.equal(channel.idwl.values[0], 1);
  assert.equal(block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsIdwl, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsTotal, 20);
  assert.equal(fixture.hdr.idwlInitialized, 1);
});

test("raiseIdwlModesWithinBudget stops at the last fitting IDWL increase", () => {
  const fixture = createLateBudgetFixture({ bitLimit: 61 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const total = runRaiseIdwlModesWithinBudget(fixture, {
    latePriority: createLatePriority({
      orderedBandSlots: Int32Array.from([0]),
      stereoBandsByPriority: Int32Array.from([0]),
    }),
  });

  assert.equal(total, 61);
  assert.equal(channel.idwl.values[0], 2);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(block.bitDeltaByCtx[0], 36);
  assert.equal(fixture.hdr.bitsIdwl, 5);
  assert.equal(fixture.hdr.bitsTotalBase, 25);
  assert.equal(fixture.hdr.bitsTotal, 61);
  assert.equal(fixture.hdr.idwlInitialized, 1);
});

test("raiseIdwlModesWithinBudget primes the rebitalloc mirror from the current base indices", () => {
  const fixture = createLateBudgetFixture();
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idct.values[0] = 5;
  block.rebitallocScratch.specIndexByBand[0] = 1;

  const total = runRaiseIdwlModesWithinBudget(fixture, {
    latePriority: createLatePriority({
      orderedBandSlots: Int32Array.from([0]),
      stereoBandsByPriority: Int32Array.from([0]),
    }),
  });

  assert.equal(total, 20);
  assert.equal(block.rebitallocScratch.specIndexByBand[0], 5);
});

test("raiseIdwlModesWithinBudget rebalances a stereo pair toward the lower IDWL mode", () => {
  const fixture = createLateBudgetFixture({ channelCount: 2, bitLimit: 61 });
  const [left, right] = fixture.channels;
  const [leftBlock, rightBlock] = fixture.blocks;

  left.sharedAux = { intensityBand: Int32Array.from([1]) };
  left.idwl.values[0] = 2;
  right.idwl.values[0] = 1;
  left.idsf.values[0] = 10;
  right.idsf.values[0] = 6;
  leftBlock.maxQuantModeByBand[0] = 2;
  rightBlock.maxQuantModeByBand[0] = 2;
  leftBlock.quantOffsetByBand[0] = 1;
  rightBlock.quantOffsetByBand[0] = 1;
  leftBlock.normalizedBandPeaks[0] = 1;
  rightBlock.normalizedBandPeaks[0] = 1;

  const total = runRaiseIdwlModesWithinBudget(fixture, {
    latePriority: createLatePriority({
      orderedBandSlots: Int32Array.from([0, 1]),
      stereoBandsByPriority: Int32Array.from({ length: 8 }, () => 0),
    }),
  });

  assert.equal(total, 30);
  assert.equal(left.idwl.values[0], 2);
  assert.equal(right.idwl.values[0], 2);
  assert.equal(fixture.hdr.bitsIdwl, 10);
  assert.equal(fixture.hdr.bitsTotalBase, 30);
  assert.equal(fixture.hdr.bitsTotal, 30);
});

test("raiseIdwlModesWithinBudget skips stereo rebalance when the IDSF gap is too large", () => {
  const fixture = createLateBudgetFixture({ channelCount: 2, bitLimit: 61 });
  const [left, right] = fixture.channels;
  const [leftBlock, rightBlock] = fixture.blocks;

  left.sharedAux = { intensityBand: Int32Array.from([1]) };
  left.idwl.values[0] = 2;
  right.idwl.values[0] = 1;
  left.idsf.values[0] = 20;
  right.idsf.values[0] = 9;
  leftBlock.maxQuantModeByBand[0] = 2;
  rightBlock.maxQuantModeByBand[0] = 1;
  leftBlock.quantOffsetByBand[0] = 1;
  rightBlock.quantOffsetByBand[0] = 1;
  leftBlock.normalizedBandPeaks[0] = 1;
  rightBlock.normalizedBandPeaks[0] = 1;

  const total = runRaiseIdwlModesWithinBudget(fixture, {
    latePriority: createLatePriority({
      orderedBandSlots: Int32Array.from([0, 1]),
      stereoBandsByPriority: Int32Array.from({ length: 8 }, () => 0),
    }),
  });

  assert.equal(total, 20);
  assert.equal(left.idwl.values[0], 2);
  assert.equal(right.idwl.values[0], 1);
  assert.equal(fixture.hdr.bitsIdwl, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsTotal, 20);
});

test("raiseIdwlModesWithinBudget keeps scanning after an early band is ineligible", () => {
  const fixture = createLateBudgetFixture({ bandCount: 2, bitLimit: 70 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 0;
  channel.idwl.values[1] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.maxQuantModeByBand[1] = 4;
  block.quantOffsetByBand[0] = 1;
  block.quantOffsetByBand[1] = 1;
  block.normalizedBandPeaks[0] = 1;
  block.normalizedBandPeaks[1] = 1;

  const total = runRaiseIdwlModesWithinBudget(fixture, {
    latePriority: createLatePriority({
      orderedBandSlots: Int32Array.from([0, 1]),
      stereoBandsByPriority: Int32Array.from([0]),
    }),
  });

  assert.equal(total, 44);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.idwl.values[1], 4);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(channel.idct.values[1], 2);
  assert.equal(block.bitDeltaByCtx[0], 16);
  assert.equal(fixture.hdr.bitsIdwl, 8);
  assert.equal(fixture.hdr.bitsTotalBase, 28);
  assert.equal(fixture.hdr.bitsTotal, 44);
});

test("raiseIdwlModesWithinBudget blacklists a rejected band while later bands keep raising", () => {
  const fixture = createLateBudgetFixture({ bandCount: 2, bitLimit: 42 });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 1;
  channel.idwl.values[1] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.maxQuantModeByBand[1] = 4;
  block.quantOffsetByBand[0] = 1;
  block.quantOffsetByBand[1] = 1;
  block.normalizedBandPeaks[0] = 1;
  block.normalizedBandPeaks[1] = 1;

  const total = runRaiseIdwlModesWithinBudget(fixture, {
    latePriority: createLatePriority({
      orderedBandSlots: Int32Array.from([0, 1]),
      stereoBandsByPriority: Int32Array.from([0]),
    }),
  });

  assert.equal(total, 42);
  assert.equal(channel.idwl.values[0], 1);
  assert.equal(channel.idwl.values[1], 4);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(channel.idct.values[1], 2);
  assert.equal(block.bitDeltaByCtx[0], 16);
  assert.equal(fixture.hdr.bitsIdwl, 6);
  assert.equal(fixture.hdr.bitsTotalBase, 26);
  assert.equal(fixture.hdr.bitsTotal, 42);
});

test("relaxQuantOffsetsWithinBudget lowers quant offsets only when the rebitalloc delta fits", () => {
  const fixture = createLateBudgetFixture({
    bitLimit: 40,
    bitsIdwl: 5,
    idwlInitialized: 1,
  });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const total = runRelaxQuantOffsetsWithinBudget(fixture, {
    latePriority: createLatePriority({ orderedBandSlots: Int32Array.from([0]) }),
  });

  assert.equal(total, 21);
  assert.equal(block.quantOffsetByBand[0], 0);
  assert.equal(channel.idct.values[0], 3);
  assert.equal(block.bitDeltaByCtx[0], 1);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsTotal, 21);
});

test("relaxQuantOffsetsWithinBudget restores quant offsets when the delta would overflow", () => {
  const fixture = createLateBudgetFixture({
    bitLimit: 30,
    bitsTotal: 10,
    bitsTotalBase: 10,
    bitsIdwl: 5,
    idwlInitialized: 1,
  });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 4;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;
  block.rebitallocScratch.specIndexByBand[0] = 7;

  const total = runRelaxQuantOffsetsWithinBudget(fixture, {
    latePriority: createLatePriority({ orderedBandSlots: Int32Array.from([0]) }),
  });

  assert.equal(total, 10);
  assert.equal(block.quantOffsetByBand[0], 1);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(block.rebitallocScratch.specIndexByBand[0], 7);
  assert.equal(block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsTotal, 10);
});

test("relaxQuantOffsetsWithinBudget keeps scanning after an early band is rejected", () => {
  const fixture = createLateBudgetFixture({
    bandCount: 2,
    bitLimit: 24,
    bitsTotal: 20,
    bitsTotalBase: 20,
    bitsIdwl: 5,
    idwlInitialized: 1,
  });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 4;
  channel.idwl.values[1] = 1;
  block.quantOffsetByBand[0] = 1;
  block.quantOffsetByBand[1] = 1;
  block.normalizedBandPeaks[0] = 1;
  block.normalizedBandPeaks[1] = 1;
  block.rebitallocScratch.specIndexByBand[0] = 7;

  const total = runRelaxQuantOffsetsWithinBudget(fixture, {
    latePriority: createLatePriority({ orderedBandSlots: Int32Array.from([0, 1]) }),
  });

  assert.equal(total, 21);
  assert.equal(block.quantOffsetByBand[0], 1);
  assert.equal(block.quantOffsetByBand[1], 0);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(channel.idct.values[1], 3);
  assert.equal(block.rebitallocScratch.specIndexByBand[0], 7);
  assert.equal(block.rebitallocScratch.specIndexByBand[1], 3);
  assert.equal(block.bitDeltaByCtx[0], 1);
  assert.equal(fixture.hdr.bitsTotal, 21);
});

test("relaxQuantOffsetsWithinBudget keeps scanning after an early band is ineligible", () => {
  const fixture = createLateBudgetFixture({
    bandCount: 2,
    bitLimit: 40,
    bitsIdwl: 5,
    idwlInitialized: 1,
  });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 0;
  channel.idwl.values[1] = 1;
  block.quantOffsetByBand[0] = 1;
  block.quantOffsetByBand[1] = 1;
  block.normalizedBandPeaks[0] = 1;
  block.normalizedBandPeaks[1] = 1;

  const total = runRelaxQuantOffsetsWithinBudget(fixture, {
    latePriority: createLatePriority({ orderedBandSlots: Int32Array.from([0, 1]) }),
  });

  assert.equal(total, 21);
  assert.equal(block.quantOffsetByBand[0], 1);
  assert.equal(block.quantOffsetByBand[1], 0);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(channel.idct.values[1], 3);
  assert.equal(block.bitDeltaByCtx[0], 1);
  assert.equal(fixture.hdr.bitsTotal, 21);
});

test("relaxQuantOffsetsWithinBudget skips bands that do not have bit headroom", () => {
  const fixture = createLateBudgetFixture({
    bitLimit: 30,
    bitsTotal: 27,
    bitsTotalBase: 27,
    bitsIdwl: 5,
    idwlInitialized: 1,
  });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const total = runRelaxQuantOffsetsWithinBudget(fixture, {
    latePriority: createLatePriority({ orderedBandSlots: Int32Array.from([0]) }),
  });

  assert.equal(total, 27);
  assert.equal(block.quantOffsetByBand[0], 1);
  assert.equal(channel.idct.values[0], 0);
  assert.equal(block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsTotal, 27);
});
