import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  at5AdjustQuantOffsetsRebitalloc,
  at5ShellSortDesc,
  prepareLatePriorityOrder,
} from "../../../src/atrac3plus/channel-block/internal.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";

function preparePriorityFixture({
  hdr,
  blocks,
  channels,
  channelCount,
  bandCount,
  latePriority = {
    bandScores: new Int32Array(channelCount * bandCount),
    orderedBandSlots: new Int32Array(channelCount * bandCount),
    stereoScores: new Int32Array(Math.max(1, bandCount)),
    stereoBandsByPriority: new Int32Array(Math.max(1, bandCount)),
    stereoBandCount: 0,
  },
}) {
  prepareLatePriorityOrder(hdr, blocks, channels, channelCount, bandCount, latePriority);
  return latePriority;
}

function sortedScoreForBand(bandScores, orderedBandSlots, band) {
  const slot = orderedBandSlots.indexOf(band);
  return slot >= 0 ? bandScores[slot] : null;
}

test("prepareLatePriorityOrder syncs active HCSPEC tables and mono base indices", () => {
  const active = { bestIndexByBand: Int32Array.from([4, 5, 6]) };
  const channel = {
    rebitallocCtxId: 1,
    idwl: { values: Uint32Array.from([1, 0, 1, 0]) },
    idct: { values: new Uint32Array(4) },
  };
  const block = {
    hcspecWorkByCtx: [{ bestIndexByBand: Int32Array.from([1, 2, 3]) }, active],
    rebitallocScratch: { specIndexByBand: new Int32Array(4) },
  };
  const hdr = { hcspecTblA: [null], hcspecTblB: [null] };

  const { orderedBandSlots } = preparePriorityFixture({
    hdr,
    blocks: [block],
    channels: [channel],
    channelCount: 1,
    bandCount: 4,
  });

  assert.equal(channel.idctTableCtx, 1);
  assert.equal(hdr.hcspecTblA[0], active);
  assert.equal(hdr.hcspecTblB[0], block.hcspecWorkByCtx[0]);
  assert.deepEqual(Array.from(channel.idct.values), [4, 0, 6, 0]);
  assert.deepEqual(Array.from(block.rebitallocScratch.specIndexByBand), [4, 5, 6, 0]);
  assert.deepEqual(Array.from(orderedBandSlots), [0, 1, 2, 3]);
});

test("prepareLatePriorityOrder still mirrors active HCSPEC state when scoring inputs are absent", () => {
  const active = { bestIndexByBand: Int32Array.from([4, 5, 6]) };
  const channel = {
    rebitallocCtxId: 1,
    idwl: { values: Uint32Array.from([1, 0, 1, 0]) },
    idct: { values: new Uint32Array(4) },
  };
  const block = {
    hcspecWorkByCtx: [{ bestIndexByBand: Int32Array.from([1, 2, 3]) }, active],
    rebitallocScratch: { specIndexByBand: new Int32Array(4) },
  };
  const hdr = { hcspecTblA: [null], hcspecTblB: [null] };

  const { bandScores } = preparePriorityFixture({
    hdr,
    blocks: [block],
    channels: [channel],
    channelCount: 1,
    bandCount: 4,
  });

  assert.deepEqual(Array.from(bandScores), [0, 0, 0, 0]);
  assert.equal(channel.idctTableCtx, 1);
  assert.equal(hdr.hcspecTblA[0], active);
  assert.equal(hdr.hcspecTblB[0], block.hcspecWorkByCtx[0]);
  assert.deepEqual(Array.from(channel.idct.values), [4, 0, 6, 0]);
  assert.deepEqual(Array.from(block.rebitallocScratch.specIndexByBand), [4, 5, 6, 0]);
});

test("prepareLatePriorityOrder keeps mirroring the codec prefix beyond the live band count", () => {
  const active = { bestIndexByBand: Int32Array.from([4, 5, 6, 7, 8, 9]) };
  const channel = {
    rebitallocCtxId: 1,
    idwl: { values: Uint32Array.from([1, 0]) },
    idct: { values: new Uint32Array(6) },
  };
  const block = {
    hcspecWorkByCtx: [{ bestIndexByBand: Int32Array.from([1, 2, 3, 4, 5, 6]) }, active],
    rebitallocScratch: { specIndexByBand: new Int32Array(6) },
  };

  preparePriorityFixture({
    hdr: { hcspecTblA: [null], hcspecTblB: [null] },
    blocks: [block],
    channels: [channel],
    channelCount: 1,
    bandCount: 2,
  });

  assert.deepEqual(Array.from(channel.idct.values), [4, 0, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(block.rebitallocScratch.specIndexByBand), [4, 5, 6, 7, 8, 9]);
});

test("prepareLatePriorityOrder preserves stereo delta flags while clearing inactive pairs", () => {
  const channels = [
    {
      sharedAux: { intensityBand: Uint32Array.from([2]) },
      idct: { values: Uint32Array.from([9, 9, 9]) },
      idwl: { values: Uint32Array.from([1, 0, 1]) },
      idsf: { values: Int32Array.from([12, 8, 6]) },
      rebitallocCtxId: 0,
    },
    {
      sharedAux: { intensityBand: Uint32Array.from([2]) },
      idct: { values: Uint32Array.from([9, 9, 9]) },
      idwl: { values: Uint32Array.from([1, 0, 0]) },
      idsf: { values: Int32Array.from([11, 7, 0]) },
      rebitallocCtxId: 0,
    },
  ];
  const blocks = [
    {
      bandLevels: new Float32Array(3),
      hcspecWorkByCtx: [{ bestIndexByBand: Int32Array.from([9, 9, 9]) }],
      rebitallocScratch: { specIndexByBand: new Int32Array(3) },
    },
    {
      bandLevels: new Float32Array(3),
      hcspecWorkByCtx: [{ bestIndexByBand: Int32Array.from([9, 9, 9]) }],
      rebitallocScratch: { specIndexByBand: new Int32Array(3) },
    },
  ];

  const { stereoBandCount } = preparePriorityFixture({
    hdr: {
      hcspecTblA: [null, null],
      hcspecTblB: [null, null],
      mode3DeltaFlags: Uint32Array.from([1, 0, 1]),
    },
    blocks,
    channels,
    channelCount: 2,
    bandCount: 3,
  });

  assert.deepEqual(Array.from(channels[0].idct.values), [9, 0, 9]);
  assert.deepEqual(Array.from(channels[1].idct.values), [1, 0, 1]);
  assert.equal(stereoBandCount, 3);
});

test("prepareLatePriorityOrder derives stereo scores from unsorted left-right pairs", () => {
  const channels = [
    {
      sharedAux: { intensityBand: Uint32Array.from([2]) },
      idct: { values: Uint32Array.from([7, 7]) },
      idwl: { values: Uint32Array.from([1, 1]) },
      idsf: { values: Int32Array.from([100, 2]) },
      rebitallocCtxId: 0,
    },
    {
      sharedAux: { intensityBand: Uint32Array.from([2]) },
      idct: { values: Uint32Array.from([7, 7]) },
      idwl: { values: Uint32Array.from([1, 1]) },
      idsf: { values: Int32Array.from([99, 98]) },
      rebitallocCtxId: 0,
    },
  ];
  const blocks = [
    {
      bandLevels: new Float32Array(2),
      hcspecWorkByCtx: [{ bestIndexByBand: Int32Array.from([7, 7]) }],
      rebitallocScratch: { specIndexByBand: new Int32Array(2) },
    },
    {
      bandLevels: new Float32Array(2),
      hcspecWorkByCtx: [{ bestIndexByBand: Int32Array.from([7, 7]) }],
      rebitallocScratch: { specIndexByBand: new Int32Array(2) },
    },
  ];

  const { stereoScores, stereoBandsByPriority, bandScores } = preparePriorityFixture({
    hdr: { hcspecTblA: [null, null], hcspecTblB: [null, null] },
    blocks,
    channels,
    channelCount: 2,
    bandCount: 2,
  });

  assert.deepEqual(Array.from(stereoScores.slice(0, 2)), [199, 100]);
  assert.deepEqual(Array.from(stereoBandsByPriority.slice(0, 2)), [0, 1]);
  assert.deepEqual(Array.from(bandScores), [100, 99, 98, 2]);
});

test("prepareLatePriorityOrder clears stale scores when channel inputs are missing", () => {
  const { bandScores } = preparePriorityFixture({
    hdr: { hcspecTblA: [null], hcspecTblB: [null] },
    blocks: [null],
    channels: [null],
    channelCount: 1,
    bandCount: 4,
    latePriority: {
      bandScores: Int32Array.from([9, 9, 9, 9]),
      orderedBandSlots: new Int32Array(4),
      stereoScores: new Int32Array(4),
      stereoBandsByPriority: new Int32Array(4),
      stereoBandCount: 0,
    },
  });

  assert.deepEqual(Array.from(bandScores), [0, 0, 0, 0]);
});

test("prepareLatePriorityOrder adds the high-band ramp bonus in the same scoring pass", () => {
  const channel = {
    rebitallocCtxId: 0,
    idsf: { values: Int32Array.from({ length: 13 }, (_, band) => band * 5) },
    idwl: { values: new Uint32Array(13) },
    idct: { values: new Uint32Array(13) },
  };
  const block = {
    bandLevels: Float32Array.from({ length: 13 }, (_, band) => (band === 12 ? 1.75 : 0)),
    hcspecWorkByCtx: [{ bestIndexByBand: new Int32Array(13) }],
    rebitallocScratch: { specIndexByBand: new Int32Array(13) },
  };

  const { bandScores, orderedBandSlots } = preparePriorityFixture({
    hdr: { hcspecTblA: [null], hcspecTblB: [null] },
    blocks: [block],
    channels: [channel],
    channelCount: 1,
    bandCount: 13,
  });

  assert.equal(sortedScoreForBand(bandScores, orderedBandSlots, 11), 54);
  assert.equal(sortedScoreForBand(bandScores, orderedBandSlots, 12), 61);
});

test("prepareLatePriorityOrder drops the high-band ramp bonus when the slope reverses", () => {
  const channel = {
    rebitallocCtxId: 0,
    idsf: { values: Int32Array.from([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 30]) },
    idwl: { values: new Uint32Array(13) },
    idct: { values: new Uint32Array(13) },
  };
  const block = {
    bandLevels: new Float32Array(13),
    hcspecWorkByCtx: [{ bestIndexByBand: new Int32Array(13) }],
    rebitallocScratch: { specIndexByBand: new Int32Array(13) },
  };
  const { bandScores, orderedBandSlots } = preparePriorityFixture({
    hdr: { hcspecTblA: [null], hcspecTblB: [null] },
    blocks: [block],
    channels: [channel],
    channelCount: 1,
    bandCount: 13,
  });

  assert.equal(sortedScoreForBand(bandScores, orderedBandSlots, 12), 28);
});

test("at5ShellSortDesc keeps float values and indices aligned", () => {
  const values = Float32Array.from([0.4, -0.2, 1.0, 0.401, 0.4]);
  const indices = Int32Array.from([0, 1, 2, 3, 4]);

  at5ShellSortDesc(values, indices, values.length);

  assert.deepEqual(Array.from(values), Array.from(Float32Array.from([1, 0.401, 0.4, 0.4, -0.2])));
  assert.deepEqual(Array.from(indices), [2, 3, 0, 4, 1]);
});

test("at5ShellSortDesc keeps equal integer values stable", () => {
  const values = Int32Array.from([4, 4, 2, 4]);
  const indices = Int32Array.from([0, 1, 2, 3]);

  at5ShellSortDesc(values, indices, values.length);

  assert.deepEqual(Array.from(values), [4, 4, 4, 2]);
  assert.deepEqual(Array.from(indices), [0, 1, 3, 2]);
});

test("at5AdjustQuantOffsetsRebitalloc recomputes stale totals before mutating offsets", () => {
  const hdr = {
    bitsTotalBase: 5,
    bitsTotal: 20,
    cbIterLimit: 2,
    cbStartBand: 0,
  };
  const block = {
    bitDeltaByCtx: Uint16Array.from([0, 0]),
    quantOffsetByBand: Int32Array.from([1]),
  };
  const channel = {
    rebitallocCtxId: 0,
    idwl: { values: Int32Array.from([1]) },
  };

  at5AdjustQuantOffsetsRebitalloc([block], [channel], hdr, 1, 1, 0, 10);

  assert.equal(block.quantOffsetByBand[0], 1);
  assert.equal(hdr.bitsTotal, 5);
});

test("at5AdjustQuantOffsetsRebitalloc keeps extended-core low bands pinned at offset 3", () => {
  const hdr = {
    bitsTotalBase: 20,
    bitsTotal: 20,
    cbIterLimit: 4,
    cbStartBand: 0,
  };
  const block = {
    bitDeltaByCtx: Uint16Array.from([0, 0]),
    quantOffsetByBand: Int32Array.from([3]),
  };
  const channel = {
    rebitallocCtxId: 0,
    idwl: { values: Int32Array.from([1]) },
  };

  at5AdjustQuantOffsetsRebitalloc([block], [channel], hdr, 1, 1, 9, 10);

  assert.equal(block.quantOffsetByBand[0], 3);
  assert.equal(hdr.bitsTotal, 20);
});

test("at5AdjustQuantOffsetsRebitalloc keeps simple-core low bands advancing beyond offset 3", () => {
  const hdr = {
    bitsTotalBase: 20,
    bitsTotal: 20,
    cbIterLimit: 4,
    cbStartBand: 0,
  };
  const block = {
    bitDeltaByCtx: Uint16Array.from([0, 0]),
    bitallocHeader: { tblIndex: -1 },
    quantOffsetByBand: Int32Array.from([3]),
    normalizedBandPeaks: Float32Array.from([0]),
  };
  const channel = {
    rebitallocCtxId: 0,
    idwl: { values: Int32Array.from([1]) },
    scratchSpectra: new Int32Array(0),
  };

  at5AdjustQuantOffsetsRebitalloc([block], [channel], hdr, 1, 1, 8, 10);

  assert.equal(block.quantOffsetByBand[0], 4);
  assert.equal(block.bitDeltaByCtx[0], 0);
  assert.equal(hdr.bitsTotal, 20);
});

test("at5AdjustQuantOffsetsRebitalloc keeps the high-band saturation clamp behavior", () => {
  const hdr = {
    bitsTotalBase: 20,
    bitsTotal: 20,
    cbIterLimit: 0x11,
    cbStartBand: 8,
  };
  const block = {
    bitDeltaByCtx: Uint16Array.from([0, 0]),
    quantOffsetByBand: Int32Array.from({ length: 9 }, (_, index) => (index === 8 ? 0x10 : 0)),
  };
  const channel = {
    rebitallocCtxId: 0,
    idwl: { values: Int32Array.from({ length: 9 }, (_, index) => (index === 8 ? 1 : 0)) },
  };

  at5AdjustQuantOffsetsRebitalloc([block], [channel], hdr, 1, 9, 0, 10);

  assert.equal(block.quantOffsetByBand[8], 0x0f);
  assert.equal(hdr.bitsTotal, 20);
});

test("at5AdjustQuantOffsetsRebitalloc walks overflow recovery from the highest band downward", () => {
  const runtimeBlock = createAt5RegularBlockState(1);
  const channel = runtimeBlock.channels[0];
  const hdr = {
    ...createBitallocHeader(1),
    bitsTotalBase: 5,
    bitsTotal: 20,
    cbIterLimit: 1,
    cbStartBand: 0,
  };
  hdr.tblIndex = -1;

  const block = createChannelBlock();
  block.bitallocHeader = hdr;
  block.bitDeltaByCtx[0] = 15;
  block.quantOffsetByBand[0] = 0;
  block.quantOffsetByBand[1] = 0;
  channel.idwl.values[0] = 1;
  channel.idwl.values[1] = 1;

  at5AdjustQuantOffsetsRebitalloc([block], [channel], hdr, 1, 2, 0, 10);

  assert.deepEqual(Array.from(block.quantOffsetByBand.slice(0, 2)), [0, 1]);
  assert.equal(hdr.bitsTotal, 5);
});

test("at5AdjustQuantOffsetsRebitalloc stops after the first accepted channel change fits the budget", () => {
  const hdr = {
    bitsTotalBase: 0,
    bitsTotal: 12,
    cbIterLimit: 4,
    cbStartBand: 0,
  };
  const blocks = Array.from({ length: 2 }, () => ({
    bitDeltaByCtx: Uint16Array.from([6, 0]),
    bitallocHeader: { tblIndex: -1 },
    quantOffsetByBand: Int32Array.from([0]),
    normalizedBandPeaks: Float32Array.from([0]),
  }));
  const channels = Array.from({ length: 2 }, () => ({
    rebitallocCtxId: 0,
    idwl: { values: Int32Array.from([1]) },
    scratchSpectra: new Int32Array(0),
  }));

  at5AdjustQuantOffsetsRebitalloc(blocks, channels, hdr, 2, 1, 0, 10);

  assert.equal(blocks[0].quantOffsetByBand[0], 1);
  assert.equal(blocks[1].quantOffsetByBand[0], 0);
  assert.equal(hdr.bitsTotal, 6);
});
