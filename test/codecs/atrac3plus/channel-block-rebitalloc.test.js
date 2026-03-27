import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  at5AdjustQuantOffsetsRebitalloc,
  applyRebitallocChoice,
  planRebitallocChoice,
  refineRebitallocOffsets,
  restoreRebitallocState,
  snapshotRebitallocState,
  tryApplyRebitallocChoice,
} from "../../../src/atrac3plus/channel-block/rebitalloc.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";

function createRebitallocFixture({
  band = 0,
  mode = 1,
  quantOffset = 0,
  baseIdx = 0,
  bitsIdct = 0,
  bitsTotal = 20,
  bitsTotalBase = 20,
  fill = 0.25,
} = {}) {
  const regularBlock = createAt5RegularBlockState(1);
  regularBlock.shared.encodeFlags = 0;
  regularBlock.shared.sampleRateHz = 44100;
  regularBlock.shared.bandLimit = band + 1;

  const channels = regularBlock.channels;
  const [channel] = channels;
  const block = createChannelBlock();
  const hdr = createBitallocHeader(1);

  Object.assign(hdr, {
    bitsIdct,
    bitsTotal,
    bitsTotalBase,
    tblIndex: 0,
    hcspecTblA: [block.hcspecWorkByCtx[0]],
    hcspecTblB: [block.hcspecWorkByCtx[1]],
  });

  block.bitallocHeader = hdr;
  block.quantizedSpectrum = new Float32Array(2048);
  block.quantizedSpectrum.fill(fill);

  channel.rebitallocCtxId = 0;
  channel.idwl.values[band] = mode;
  channel.idct.values[band] = baseIdx;

  block.rebitallocScratch.specIndexByBand[band] = baseIdx;
  block.quantOffsetByBand[band] = quantOffset;
  block.normalizedBandPeaks[band] = 1;

  return { hdr, block, channel, blocks: [block], channels };
}

test("planRebitallocChoice returns improved HCSPEC indices when they lower the score", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 0,
  });

  const result = planRebitallocChoice(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    0,
    0,
    1,
    0
  );

  assert.deepEqual(result, { bitDelta: 1, hcspecIndex: 3, idctBitCount: 0 });
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 3);
  assert.deepEqual(Array.from(fixture.hdr.hcspecTblB[0].costsByBand.slice(0, 4)), [4, 8, 4, 1]);
});

test("planRebitallocChoice restores tied alternate indices after probing them", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 2,
    quantOffset: 0,
    baseIdx: 1,
  });

  const result = planRebitallocChoice(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    0,
    0,
    2,
    1
  );

  assert.deepEqual(result, { bitDelta: 36, hcspecIndex: 1, idctBitCount: 0 });
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 1);
  assert.equal(fixture.channel.idct.values[0], 1);
  assert.deepEqual(Array.from(fixture.hdr.hcspecTblB[0].costsByBand.slice(0, 4)), [36, 36, 40, 48]);
});

test("planRebitallocChoice keeps the current index when work tables are missing", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 2,
    bitsIdct: 9,
  });

  fixture.hdr.hcspecTblA[0] = null;

  const result = planRebitallocChoice(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    0,
    0,
    1,
    2
  );

  assert.deepEqual(result, { bitDelta: 0, hcspecIndex: 2, idctBitCount: 0 });
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 2);
});

test("planRebitallocChoice still probes valid candidates when the base index is outside the search range", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 7,
    bitsIdct: 9,
  });

  const result = planRebitallocChoice(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    0,
    0,
    1,
    7
  );

  assert.deepEqual(result, { bitDelta: -8, hcspecIndex: 3, idctBitCount: 0 });
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 3);
});

test("applyRebitallocChoice updates IDCT totals and preserves the variable delta split", () => {
  const fixture = createRebitallocFixture({
    bitsIdct: 10,
    bitsTotal: 40,
    bitsTotalBase: 25,
  });

  fixture.block.bitDeltaByCtx[0] = 6;
  fixture.hdr.hcspecTblB[0].costsByBand.set(Uint16Array.from([9, 8, 7, 6, 5, 4, 3, 2]), 0);

  const total = applyRebitallocChoice(
    fixture.hdr,
    fixture.block,
    fixture.channel,
    0,
    0,
    { bitDelta: 5, hcspecIndex: 3, idctBitCount: 12 },
    fixture.channel.idct.values
  );

  assert.equal(total, 45);
  assert.equal(fixture.hdr.bitsTotalBase, 27);
  assert.equal(fixture.hdr.bitsIdct, 12);
  assert.equal(fixture.hdr.bitsTotal, 45);
  assert.equal(fixture.block.bitDeltaByCtx[0], 9);
  assert.equal(fixture.channel.idct.values[0], 3);
  assert.deepEqual(
    Array.from(fixture.hdr.hcspecTblA[0].costsByBand.slice(0, 8)),
    [9, 8, 7, 6, 5, 4, 3, 2]
  );
});

test("applyRebitallocChoice updates the active context even without a committed-index mirror", () => {
  const fixture = createRebitallocFixture({
    bitsIdct: 10,
    bitsTotal: 40,
    bitsTotalBase: 25,
  });

  fixture.channel.rebitallocCtxId = 1;
  fixture.block.bitDeltaByCtx.set([6, 7]);
  fixture.hdr.hcspecTblB[0].costsByBand.set(Uint16Array.from([9, 8, 7, 6, 5, 4, 3, 2]), 0);

  const total = applyRebitallocChoice(fixture.hdr, fixture.block, fixture.channel, 0, 0, {
    bitDelta: 5,
    hcspecIndex: 3,
    idctBitCount: 12,
  });

  assert.equal(total, 45);
  assert.equal(fixture.hdr.bitsTotalBase, 27);
  assert.equal(fixture.hdr.bitsIdct, 12);
  assert.equal(fixture.hdr.bitsTotal, 45);
  assert.deepEqual(Array.from(fixture.block.bitDeltaByCtx), [6, 10]);
  assert.equal(fixture.channel.idct.values[0], 3);
});

test("snapshotRebitallocState restores rebitalloc scratch and IDCT metadata fields", () => {
  const fixture = createRebitallocFixture({ band: 1, baseIdx: 5 });

  fixture.block.rebitallocScratch.specIndexByBand[0] = 3;
  fixture.block.rebitallocScratch.specIndexByBand[1] = 5;
  fixture.channel.idctModeSelect = 2;
  fixture.channel.idct.modeSelect = 2;
  fixture.channel.idct.flag = 1;
  fixture.channel.idct.count = 9;

  const snapshot = snapshotRebitallocState(fixture.blocks, fixture.channels, 1);

  fixture.block.rebitallocScratch.specIndexByBand[0] = 7;
  fixture.block.rebitallocScratch.specIndexByBand[1] = 1;
  fixture.channel.idctModeSelect = 6;
  fixture.channel.idct.modeSelect = 6;
  fixture.channel.idct.flag = 0;
  fixture.channel.idct.count = 1;

  restoreRebitallocState(fixture.blocks, fixture.channels, snapshot);

  assert.deepEqual(Array.from(fixture.block.rebitallocScratch.specIndexByBand.slice(0, 2)), [3, 5]);
  assert.equal(fixture.channel.idctModeSelect, 2);
  assert.equal(fixture.channel.idct.modeSelect, 2);
  assert.equal(fixture.channel.idct.flag, 1);
  assert.equal(fixture.channel.idct.count, 9);
});

test("tryApplyRebitallocChoice restores probed state when the bit budget still overflows", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 0,
    bitsTotal: 20,
  });

  const total = tryApplyRebitallocChoice(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    0,
    0,
    1,
    0,
    {
      requireImprovement: false,
      maxTotalBits: 20,
      committedHcspecIndexByBand: fixture.channel.idct.values,
    }
  );

  assert.equal(total, null);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 0);
  assert.equal(fixture.channel.idct.values[0], 0);
  assert.equal(fixture.hdr.bitsTotal, 20);
  assert.deepEqual(Array.from(fixture.hdr.hcspecTblA[0].costsByBand.slice(0, 4)), [0, 0, 0, 0]);
});

test("tryApplyRebitallocChoice can spend bits when improvement gating is disabled", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 2,
    quantOffset: 0,
    baseIdx: 1,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });

  const total = tryApplyRebitallocChoice(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    0,
    0,
    2,
    1,
    {
      requireImprovement: false,
      maxTotalBits: 60,
      committedHcspecIndexByBand: fixture.channel.idct.values,
    }
  );

  assert.equal(total, 56);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 1);
  assert.equal(fixture.channel.idct.values[0], 1);
  assert.equal(fixture.block.bitDeltaByCtx[0], 36);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotal, 56);
  assert.deepEqual(Array.from(fixture.hdr.hcspecTblA[0].costsByBand.slice(0, 4)), [36, 36, 40, 48]);
});

test("tryApplyRebitallocChoice restores probed state when improvement gating rejects the change", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 2,
    quantOffset: 0,
    baseIdx: 1,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });

  const total = tryApplyRebitallocChoice(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    fixture.channels.length,
    0,
    0,
    2,
    1,
    {
      committedHcspecIndexByBand: fixture.channel.idct.values,
    }
  );

  assert.equal(total, null);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 1);
  assert.equal(fixture.channel.idct.values[0], 1);
  assert.equal(fixture.block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotal, 20);
  assert.deepEqual(Array.from(fixture.hdr.hcspecTblA[0].costsByBand.slice(0, 4)), [0, 0, 0, 0]);
});

test("at5AdjustQuantOffsetsRebitalloc caps low-band retries at offset 3 in higher core modes", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 7,
    bitsIdct: 9,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });

  fixture.hdr.cbIterLimit = 15;
  fixture.hdr.cbStartBand = 0;

  at5AdjustQuantOffsetsRebitalloc(fixture.blocks, fixture.channels, fixture.hdr, 1, 1, 9, 19);

  assert.equal(fixture.block.quantOffsetByBand[0], 3);
});

test("at5AdjustQuantOffsetsRebitalloc leaves saturated high-band offsets unchanged", () => {
  const fixture = createRebitallocFixture({
    band: 8,
    mode: 1,
    quantOffset: 15,
    baseIdx: 7,
    bitsIdct: 9,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });

  fixture.hdr.cbIterLimit = 15;
  fixture.hdr.cbStartBand = 0;

  at5AdjustQuantOffsetsRebitalloc(fixture.blocks, fixture.channels, fixture.hdr, 1, 9, 0, 19);

  assert.equal(fixture.block.quantOffsetByBand[8], 15);
});

test("refineRebitallocOffsets applies a quant-offset increase when it lowers the bit total", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 7,
    bitsIdct: 9,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });
  fixture.hdr.cbStartBand = 0;

  refineRebitallocOffsets(fixture.hdr, fixture.blocks, fixture.channels, 1, 0, 19, 1);

  assert.equal(fixture.block.quantOffsetByBand[0], 1);
  assert.equal(fixture.channel.idct.values[0], 3);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 3);
  assert.equal(fixture.block.bitDeltaByCtx[0], 1);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 11);
  assert.equal(fixture.hdr.bitsTotal, 12);
});

test("refineRebitallocOffsets keeps aging rejected probes into a larger offset jump", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 1,
    bitsIdct: 9,
    bitsTotal: 20,
    bitsTotalBase: 20,
    fill: 0.5,
  });
  fixture.hdr.cbStartBand = 0;

  refineRebitallocOffsets(fixture.hdr, fixture.blocks, fixture.channels, 1, 0, 19, 1);

  assert.equal(fixture.block.quantOffsetByBand[0], 5);
  assert.equal(fixture.channel.idct.values[0], 3);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 3);
  assert.equal(fixture.block.bitDeltaByCtx[0], 1);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 11);
  assert.equal(fixture.hdr.bitsTotal, 12);
});

test("refineRebitallocOffsets restores quant offsets when the probe does not reduce bits", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 0,
    bitsIdct: 0,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });
  fixture.hdr.cbStartBand = 0;

  refineRebitallocOffsets(fixture.hdr, fixture.blocks, fixture.channels, 1, 0, 19, 1);

  assert.equal(fixture.block.quantOffsetByBand[0], 0);
  assert.equal(fixture.channel.idct.values[0], 0);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 0);
  assert.equal(fixture.block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsTotal, 20);
});

test("refineRebitallocOffsets keeps guarded low-band offsets intact at higher core modes", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 3,
    baseIdx: 7,
    bitsIdct: 9,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });
  fixture.hdr.cbStartBand = 0;

  refineRebitallocOffsets(fixture.hdr, fixture.blocks, fixture.channels, 1, 9, 19, 1);

  assert.equal(fixture.block.quantOffsetByBand[0], 3);
  assert.equal(fixture.channel.idct.values[0], 7);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 7);
  assert.equal(fixture.block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsIdct, 9);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsTotal, 20);
});

test("refineRebitallocOffsets still ages guarded low bands from lower committed offsets", () => {
  const fixture = createRebitallocFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 0,
    bitsIdct: 9,
    bitsTotal: 20,
    bitsTotalBase: 20,
    fill: 0.5,
  });
  fixture.hdr.cbStartBand = 0;

  refineRebitallocOffsets(fixture.hdr, fixture.blocks, fixture.channels, 1, 9, 19, 1);

  assert.equal(fixture.block.quantOffsetByBand[0], 5);
  assert.equal(fixture.channel.idct.values[0], 3);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 3);
  assert.equal(fixture.block.bitDeltaByCtx[0], 1);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 11);
  assert.equal(fixture.hdr.bitsTotal, 12);
});

test("refineRebitallocOffsets only backtracks two bands below cbStartBand", () => {
  const fixture = createRebitallocFixture({
    band: 1,
    mode: 1,
    quantOffset: 0,
    baseIdx: 7,
    bitsIdct: 9,
    bitsTotal: 20,
    bitsTotalBase: 20,
  });
  fixture.hdr.cbStartBand = 4;

  refineRebitallocOffsets(fixture.hdr, fixture.blocks, fixture.channels, 1, 0, 19, 4);

  assert.equal(fixture.block.quantOffsetByBand[1], 0);
  assert.equal(fixture.channel.idct.values[1], 7);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[1], 7);
  assert.equal(fixture.block.bitDeltaByCtx[0], 0);
  assert.equal(fixture.hdr.bitsIdct, 9);
  assert.equal(fixture.hdr.bitsTotalBase, 20);
  assert.equal(fixture.hdr.bitsTotal, 20);
});
