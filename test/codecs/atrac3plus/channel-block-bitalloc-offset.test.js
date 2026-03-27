import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";
import { solveBitallocOffset } from "../../../src/atrac3plus/channel-block/bitalloc-offset.js";

function createBitallocOffsetFixture({
  channelCount = 1,
  bandCount = 1,
  bitLimit = 100,
  bitsTotal = 20,
  bitsTotalBase = 20,
  bitsIdwl = 0,
  idwlEnabled = 1,
  idwlInitialized = 0,
  bandLimit = 1,
} = {}) {
  const regularBlock = createAt5RegularBlockState(channelCount);
  regularBlock.shared.encodeFlags = 0;
  regularBlock.shared.sampleRateHz = 44100;
  regularBlock.shared.bandLimit = bandLimit;

  const channels = regularBlock.channels;
  const blocks = Array.from({ length: channelCount }, () => createChannelBlock());
  const hdr = createBitallocHeader(channelCount);

  hdr.bitsTotal = bitsTotal;
  hdr.bitsTotalBase = bitsTotalBase;
  hdr.bitsIdwl = bitsIdwl;
  hdr.idwlEnabled = idwlEnabled;
  hdr.idwlInitialized = idwlInitialized;
  hdr.tblIndex = 0;

  for (const block of blocks) {
    block.bitallocHeader = hdr;
    block.quantizedSpectrum = new Float32Array(2048);
    block.quantizedSpectrum.fill(0.25, 0, 16);
  }

  return { hdr, blocks, channels, bandCount, bitLimit };
}

test("solveBitallocOffset recomputes unchanged bands on the first pass when offsets are active", () => {
  const fixture = createBitallocOffsetFixture();
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 4;
  block.quantModeBaseByBand[0] = 10;
  block.quantModeByBand[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 1;
  block.normalizedBandPeaks[0] = 1;

  const sharedWork = block.idwlWork;
  solveBitallocOffset(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    1,
    fixture.bandCount,
    fixture.bitLimit,
    0
  );

  assert.equal(block.idwlScratch.work, sharedWork);
  assert.equal(channel.idwl.values[0], 4);
  assert.equal(block.hcspecWorkByCtx[0].bestIndexByBand[0], 0);
  assert.equal(block.hcspecWorkByCtx[0].costsByBand[0], 40);
  assert.equal(block.bitDeltaByCtx[0], 40);
  assert.equal(fixture.hdr.idwlInitialized, 1);
  assert.equal(fixture.hdr.bitsIdwl, 5);
  assert.equal(fixture.hdr.bitsTotalBase, 25);
  assert.equal(fixture.hdr.bitsTotal, 65);
});

test("solveBitallocOffset shares block-0 IDWL work across stereo channel scratches", () => {
  const fixture = createBitallocOffsetFixture({
    channelCount: 2,
    bandCount: 0,
    bitLimit: 0,
    bitsTotal: 0,
    bitsTotalBase: 0,
  });
  const [leftBlock, rightBlock] = fixture.blocks;
  const sharedWork = leftBlock.idwlWork;
  const rightWork = new Uint8Array(sharedWork.length);

  rightBlock.idwlWork = rightWork;
  rightBlock.idwlScratch.work = rightWork;

  solveBitallocOffset(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    2,
    fixture.bandCount,
    fixture.bitLimit,
    0
  );

  assert.equal(leftBlock.idwlScratch.work, sharedWork);
  assert.equal(rightBlock.idwlScratch.work, sharedWork);
  assert.notEqual(rightBlock.idwlScratch.work, rightWork);
});

test("solveBitallocOffset reuses cached band costs when unchanged bands keep zero offsets", () => {
  const fixture = createBitallocOffsetFixture({
    bitLimit: 100,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  fixture.channels[0].shared.encodeFlags = 0x04;
  channel.idwl.values[0] = 4;
  block.quantModeBaseByBand[0] = 10;
  block.quantModeByBand[0] = 1;
  block.maxQuantModeByBand[0] = 4;
  block.quantOffsetByBand[0] = 0;
  block.normalizedBandPeaks[0] = 1;
  block.hcspecWorkByCtx[0].bestIndexByBand[0] = 3;
  block.hcspecWorkByCtx[0].costsByBand.fill(200, 0, 8);
  block.hcspecWorkByCtx[0].costsByBand[3] = 55;

  solveBitallocOffset(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    1,
    fixture.bandCount,
    fixture.bitLimit,
    0
  );

  assert.equal(channel.idwl.values[0], 4);
  assert.equal(block.hcspecWorkByCtx[0].bestIndexByBand[0], 3);
  assert.equal(block.hcspecWorkByCtx[0].costsByBand[3], 55);
  assert.equal(block.bitDeltaByCtx[0], 55);
  assert.equal(fixture.hdr.bitsTotalBase, 25);
  assert.equal(fixture.hdr.bitsTotal, 80);
});

test("solveBitallocOffset clears cached best indexes when a band becomes inactive", () => {
  const fixture = createBitallocOffsetFixture();
  const [channel] = fixture.channels;
  const [block] = fixture.blocks;

  channel.idwl.values[0] = 3;
  block.quantModeByBand[0] = 0;
  block.hcspecWorkByCtx[0].bestIndexByBand[0] = 5;
  block.hcspecWorkByCtx[0].costsByBand[5] = 99;

  solveBitallocOffset(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    1,
    fixture.bandCount,
    fixture.bitLimit,
    0
  );

  assert.equal(channel.idwl.values[0], 0);
  assert.equal(block.hcspecWorkByCtx[0].bestIndexByBand[0], 0);
  assert.equal(block.bitDeltaByCtx[0], 0);
});

test("solveBitallocOffset seeds init config when IDWL is disabled", () => {
  const fixture = createBitallocOffsetFixture({
    bandCount: 0,
    bitLimit: 0,
    bitsTotal: 0,
    bitsTotalBase: 0,
    bitsIdwl: 10,
    idwlEnabled: 0,
    bandLimit: 3,
  });
  const [block] = fixture.blocks;

  solveBitallocOffset(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    1,
    fixture.bandCount,
    fixture.bitLimit,
    0
  );

  assert.equal(fixture.hdr.idwlInitialized, 0);
  assert.equal(block.idwlScratch.bestConfigSlot, 0);
  assert.deepEqual(Array.from(block.idwlScratch.slot0Config), [0, 0, 3, 0, 0]);
  assert.equal(fixture.hdr.bitsIdwl, 11);
  assert.equal(fixture.hdr.bitsTotalBase, 1);
  assert.equal(fixture.hdr.bitsTotal, 1);
});
