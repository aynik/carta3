import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  computeBandScale,
  computeBitallocMode,
} from "../../../src/atrac3plus/channel-block/internal.js";
import {
  bootstrapChannelBlock,
  initializeChannelBlock,
  normalizeChannelBlock,
  seedInitialBitalloc,
  shouldScaleSpectrumFromEncodeFlags,
} from "../../../src/atrac3plus/channel-block/initial-bitalloc.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";
import {
  computeGainRecordRangeFlag,
  deriveScalefactorsFromSpectrumAt5,
} from "../../../src/atrac3plus/channel-block/metadata.js";
import { AT5_SFTBL } from "../../../src/atrac3plus/tables/decode.js";
import { AT5_ISPS } from "../../../src/atrac3plus/tables/unpack.js";

function createGainRecord(entries = 0, levels = [], locations = [], tlevFlag = 0) {
  return {
    entries,
    levels: Uint32Array.from(levels),
    locations: Uint32Array.from(locations),
    tlevFlag,
  };
}

function createEmptyRecords() {
  return Array.from({ length: 8 }, () => createGainRecord());
}

function createRuntimeBlock(channelCount) {
  const regularBlock = createAt5RegularBlockState(channelCount);
  const shared = regularBlock.shared;
  Object.assign(shared, {
    codedBandLimit: 10,
    mapSegmentCount: 3,
    coreMode: 0x0d,
    encodeFlags: 0,
    sampleRateHz: 44100,
  });

  return {
    channelsInBlock: channelCount,
    shared,
    channelEntries: regularBlock.channels,
    blockState: { encodeMode: 0, isMode4Block: 0 },
    quantizedSpectraByChannel: Array.from({ length: channelCount }, () => new Float32Array(2048)),
    bitallocSpectraByChannel: Array.from({ length: channelCount }, () => new Float32Array(2048)),
    aux: {},
  };
}

function createBlocks(channelCount) {
  return Array.from({ length: channelCount }, () => createChannelBlock());
}

function setBandSpectrum(spec, band, values) {
  const start = AT5_ISPS[band] >>> 0;
  const end = AT5_ISPS[band + 1] >>> 0;
  spec.fill(0, start, end);
  if (Array.isArray(values)) {
    for (let i = 0; i < values.length && start + i < end; i += 1) {
      spec[start + i] = values[i];
    }
    return;
  }
  spec.fill(values, start, end);
}

function assertAlmostEqual(actual, expected, epsilon = 1e-5) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function runInit(runtimeBlock) {
  const hdr = createBitallocHeader(runtimeBlock.channelsInBlock);
  const blocks = createBlocks(runtimeBlock.channelsInBlock);

  initializeChannelBlock({
    runtimeBlock,
    hdr,
    blocks,
    quantizedSpectraByChannel: runtimeBlock.quantizedSpectraByChannel,
    bitallocSpectraByChannel: runtimeBlock.bitallocSpectraByChannel,
  });

  return { hdr, blocks };
}

function runNorm(runtimeBlock, blocks, hdr, quantizedSpectraByChannel, mode) {
  normalizeChannelBlock({
    runtimeBlock,
    hdr,
    blocks,
    quantizedSpectraByChannel,
    mode,
  });
}

function runBootstrap(runtimeBlock, maxBits = 512, blockMode = 1) {
  const hdr = createBitallocHeader(runtimeBlock.channelsInBlock);
  const blocks = createBlocks(runtimeBlock.channelsInBlock);
  const total = bootstrapChannelBlock({
    runtimeBlock,
    hdr,
    blocks,
    quantizedSpectraByChannel: runtimeBlock.quantizedSpectraByChannel,
    bitallocSpectraByChannel: runtimeBlock.bitallocSpectraByChannel,
    blockMode,
    coreMode: runtimeBlock.shared.coreMode,
    maxBits,
  });
  return { hdr, blocks, total };
}

test("initializeChannelBlock preserves runtime gain and presence staging", () => {
  const runtimeBlock = createRuntimeBlock(2);
  const [left, right] = runtimeBlock.channelEntries;

  left.idct.values[0] = 3;
  left.idwl.values[0] = 2;
  left.idsf.values[0] = 4;
  right.idct.values[0] = 6;
  right.idwl.values[0] = 5;
  right.idsf.values[0] = 7;

  left.curBuf = {
    records: [
      createGainRecord(1, [6], [0], 0),
      createGainRecord(1, [6], [0], 1),
      createGainRecord(0),
    ],
    tlevFlagsCopy: Uint32Array.of(1, 0, 1),
  };
  left.prevBuf = { records: createEmptyRecords() };

  right.curBuf = {
    records: [
      createGainRecord(1, [6], [0], 1),
      createGainRecord(1, [6], [1], 1),
      createGainRecord(1, [6], [2], 1),
    ],
  };
  right.prevBuf = { records: createEmptyRecords() };

  const { hdr, blocks } = runInit(runtimeBlock);

  assert.equal(runtimeBlock.shared.gainModeFlag, 1);
  assert.equal(hdr.baseBits, 4);
  assert.equal(hdr.tblIndex, 1);
  assert.equal(left.gainEncActiveCount, 1);
  assert.equal(left.gainEncHasData, 1);
  assert.equal(left.gainEncUniqueCount, 2);
  assert.equal(left.gainEncHasDeltaFlag, 1);
  assert.equal(left.gain.hasData, 1);
  assert.equal(left.gain.activeCount, 1);
  assert.equal(left.gain.uniqueCount, 2);
  assert.equal(left.gain.hasDeltaFlag, 1);
  assert.equal(left.gain.records, left.curBuf.records);

  assert.equal(left.channelPresence.enabled, 1);
  assert.equal(left.channelPresence.mixed, 1);
  assert.deepEqual(Array.from(left.channelPresence.flags.slice(0, 4)), [1, 0, 1, 0]);
  assert.equal(right.channelPresence.enabled, 1);
  assert.equal(right.channelPresence.mixed, 0);
  assert.deepEqual(Array.from(right.channelPresence.flags.slice(0, 4)), [1, 1, 1, 0]);

  assert.equal(left.idct.values[0], 0);
  assert.equal(left.idwl.values[0], 0);
  assert.equal(left.idsf.values[0], 0);
  assert.equal(right.idct.values[0], 0);
  assert.equal(right.idwl.values[0], 0);
  assert.equal(right.idsf.values[0], 0);

  assert.equal(blocks[0].bitallocHeader, hdr);
  assert.equal(blocks[0].blockState, left.blockState ?? null);
  assert.equal(blocks[0].quantizedSpectrum, runtimeBlock.quantizedSpectraByChannel[0]);
  assert.equal(blocks[0].baseMaxQuantMode, 5);
  assert.equal(blocks[1].baseMaxQuantMode, 5);
});

test("bootstrapChannelBlock preserves the staged initialize-normalize-seed flow", () => {
  const configureRuntimeBlock = (runtimeBlock) => {
    const [left, right] = runtimeBlock.channelEntries;
    runtimeBlock.shared.encodeFlags = 0x04;
    left.curBuf = {
      records: [createGainRecord(1, [6], [0], 1)],
      tlevFlagsCopy: Uint32Array.of(1, 0, 0),
    };
    left.prevBuf = { records: createEmptyRecords() };
    right.curBuf = {
      records: [createGainRecord(1, [5], [1], 1)],
      tlevFlagsCopy: Uint32Array.of(1, 0, 0),
    };
    right.prevBuf = { records: createEmptyRecords() };

    setBandSpectrum(runtimeBlock.quantizedSpectraByChannel[0], 0, [AT5_SFTBL[20], AT5_SFTBL[18]]);
    setBandSpectrum(runtimeBlock.bitallocSpectraByChannel[0], 0, [AT5_SFTBL[18], AT5_SFTBL[16]]);
    setBandSpectrum(runtimeBlock.quantizedSpectraByChannel[1], 0, [AT5_SFTBL[19], AT5_SFTBL[17]]);
    setBandSpectrum(runtimeBlock.bitallocSpectraByChannel[1], 0, [AT5_SFTBL[17], AT5_SFTBL[15]]);
  };
  const manualRuntimeBlock = createRuntimeBlock(2);
  configureRuntimeBlock(manualRuntimeBlock);
  const manual = runInit(manualRuntimeBlock);
  runNorm(
    manualRuntimeBlock,
    manual.blocks,
    manual.hdr,
    manualRuntimeBlock.quantizedSpectraByChannel,
    1
  );
  const manualTotal = seedInitialBitalloc({
    runtimeBlock: manualRuntimeBlock,
    hdr: manual.hdr,
    blocks: manual.blocks,
    quantizedSpectraByChannel: manualRuntimeBlock.quantizedSpectraByChannel,
    blockMode: 1,
    coreMode: manualRuntimeBlock.shared.coreMode,
    maxBits: 512,
  });

  const bootstrapRuntimeBlock = createRuntimeBlock(2);
  configureRuntimeBlock(bootstrapRuntimeBlock);
  const bootstrapped = runBootstrap(bootstrapRuntimeBlock);

  assert.equal(bootstrapped.total, manualTotal);
  assert.equal(bootstrapped.hdr.bitsTotalBase, manual.hdr.bitsTotalBase);
  assert.equal(bootstrapped.hdr.bitsGain, manual.hdr.bitsGain);
  assert.equal(bootstrapped.hdr.bitsIdsf, manual.hdr.bitsIdsf);
  assert.deepEqual(
    Array.from(bootstrapped.blocks[0].quantModeByBand.slice(0, 10)),
    Array.from(manual.blocks[0].quantModeByBand.slice(0, 10))
  );
  assert.deepEqual(
    Array.from(bootstrapped.blocks[1].quantModeByBand.slice(0, 10)),
    Array.from(manual.blocks[1].quantModeByBand.slice(0, 10))
  );
});

test("initializeChannelBlock preserves first-record wide-level extra mode boost", () => {
  const runtimeBlock = createRuntimeBlock(2);
  const [left, right] = runtimeBlock.channelEntries;

  runtimeBlock.shared.mapSegmentCount = 1;
  left.curBuf = {
    records: [createGainRecord(1, [4], [0], 1)],
  };
  left.prevBuf = { records: createEmptyRecords() };
  right.curBuf = {
    records: [createGainRecord(1, [6], [0], 0)],
  };
  right.prevBuf = { records: createEmptyRecords() };

  const { blocks } = runInit(runtimeBlock);

  assert.equal(blocks[0].wideGainBoostFlag, 1);
  assert.equal(blocks[1].wideGainBoostFlag, 0);
  assert.deepEqual(
    Array.from(blocks[0].maxQuantModeByBand.slice(0, 10)),
    [6, 6, 6, 6, 6, 6, 6, 6, 5, 5]
  );
  assert.deepEqual(
    Array.from(blocks[1].maxQuantModeByBand.slice(0, 10)),
    [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]
  );
});

test("initializeChannelBlock uses the mono cmode4 header-word override", () => {
  const runtimeBlock = createRuntimeBlock(1);
  runtimeBlock.blockState.isMode4Block = 1;

  const { blocks } = runInit(runtimeBlock);

  assert.equal(blocks[0].baseMaxQuantMode, 7);
});

test("shouldScaleSpectrumFromEncodeFlags preserves the current encode-flag transition cases", () => {
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x00), false);
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x04), true);
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x08), true);
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x10), true);
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x20), true);
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x40), true);
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x38), false);
  assert.equal(shouldScaleSpectrumFromEncodeFlags(0x7c), false);
});

test("initializeChannelBlock applies the stereo 0.891 scale path in place", () => {
  const runtimeBlock = createRuntimeBlock(2);
  runtimeBlock.shared.coreMode = 0x0b;
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.shared.mapSegmentCount = 0;

  runtimeBlock.quantizedSpectraByChannel[0][0] = 2;
  runtimeBlock.quantizedSpectraByChannel[1][1] = 4;
  runtimeBlock.bitallocSpectraByChannel[0][2] = 6;
  runtimeBlock.bitallocSpectraByChannel[1][3] = 8;

  runInit(runtimeBlock);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][0], Math.fround(2 * 0.8912659));
  assert.equal(runtimeBlock.quantizedSpectraByChannel[1][1], Math.fround(4 * 0.8912659));
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][2], Math.fround(6 * 0.8912659));
  assert.equal(runtimeBlock.bitallocSpectraByChannel[1][3], Math.fround(8 * 0.8912659));
});

test("initializeChannelBlock applies the 0.94 encode-flag scale path in place", () => {
  const runtimeBlock = createRuntimeBlock(1);
  runtimeBlock.shared.encodeFlags = 0x04;
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.shared.mapSegmentCount = 0;

  runtimeBlock.quantizedSpectraByChannel[0][0] = 3;
  runtimeBlock.bitallocSpectraByChannel[0][1] = 5;

  runInit(runtimeBlock);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][0], Math.fround(3 * 0.94));
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][1], Math.fround(5 * 0.94));
});

test("initializeChannelBlock applies both spectrum scale paths sequentially", () => {
  const runtimeBlock = createRuntimeBlock(2);
  runtimeBlock.shared.coreMode = 0x0b;
  runtimeBlock.shared.encodeFlags = 0x04;
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.shared.mapSegmentCount = 0;

  runtimeBlock.quantizedSpectraByChannel[0][0] = 3;
  runtimeBlock.bitallocSpectraByChannel[1][1] = 5;

  runInit(runtimeBlock);

  assert.equal(
    runtimeBlock.quantizedSpectraByChannel[0][0],
    Math.fround(Math.fround(3 * 0.8912659) * 0.94)
  );
  assert.equal(
    runtimeBlock.bitallocSpectraByChannel[1][1],
    Math.fround(Math.fround(5 * 0.8912659) * 0.94)
  );
});

test("initializeChannelBlock zeros the 44.1 kHz spectrum tail for late groups", () => {
  const runtimeBlock = createRuntimeBlock(1);
  runtimeBlock.shared.coreMode = 0x0d;
  runtimeBlock.shared.codedBandLimit = 0x18;
  runtimeBlock.shared.mapSegmentCount = 0;

  runtimeBlock.quantizedSpectraByChannel[0].fill(7);
  runtimeBlock.bitallocSpectraByChannel[0].fill(9);

  runInit(runtimeBlock);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][1007], 7);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][1007], 9);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][1008], 0);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][1008], 0);
});

test("initializeChannelBlock preserves the current highest late-group tail boundary", () => {
  const runtimeBlock = createRuntimeBlock(1);
  const bandCount = 0x1f;
  runtimeBlock.shared.coreMode = 0x0d;
  runtimeBlock.shared.codedBandLimit = bandCount;
  runtimeBlock.shared.mapSegmentCount = 0;

  runtimeBlock.quantizedSpectraByChannel[0].fill(7);
  runtimeBlock.bitallocSpectraByChannel[0].fill(9);

  runInit(runtimeBlock);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][1855], 7);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][1855], 9);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][1856], 0);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][1856], 0);
});

test("initializeChannelBlock swaps mapped stereo spectrum segments in both working buffers", () => {
  const runtimeBlock = createRuntimeBlock(2);
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.shared.mapSegmentCount = 3;
  runtimeBlock.shared.swapMap = Uint32Array.of(0, 1, 0);

  runtimeBlock.quantizedSpectraByChannel[0].fill(10);
  runtimeBlock.quantizedSpectraByChannel[1].fill(20);
  runtimeBlock.bitallocSpectraByChannel[0].fill(30);
  runtimeBlock.bitallocSpectraByChannel[1].fill(40);

  runInit(runtimeBlock);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][127], 10);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[1][127], 20);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][127], 30);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[1][127], 40);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][128], 20);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[1][128], 10);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][128], 40);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[1][128], 30);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][255], 20);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[1][255], 10);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][255], 40);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[1][255], 30);

  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][256], 10);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[1][256], 20);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][256], 30);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[1][256], 40);
});

test("initializeChannelBlock equalizes adjacent stereo bitalloc modes", () => {
  const runtimeBlock = createRuntimeBlock(2);
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.shared.mapSegmentCount = 0;

  runtimeBlock.bitallocSpectraByChannel[0].fill(0);
  runtimeBlock.bitallocSpectraByChannel[1].fill(0);

  runtimeBlock.bitallocSpectraByChannel[0].fill(8, 0, 0x10);
  runtimeBlock.bitallocSpectraByChannel[1].fill(8, 0, 0x10);
  runtimeBlock.bitallocSpectraByChannel[0].fill(1, 0x10, 0x80);
  runtimeBlock.bitallocSpectraByChannel[1].fill(1, 0x10, 0x80);
  runtimeBlock.bitallocSpectraByChannel[0].fill(2, 0x80, 0x100);
  runtimeBlock.bitallocSpectraByChannel[1].fill(1.5, 0x80, 0x100);

  const gainRangeFlag = computeGainRecordRangeFlag(null, null);
  const expectedLeft = computeBitallocMode(runtimeBlock.bitallocSpectraByChannel[0], gainRangeFlag);
  const expectedRight = computeBitallocMode(
    runtimeBlock.bitallocSpectraByChannel[1],
    gainRangeFlag
  );
  const { blocks } = runInit(runtimeBlock);

  assert.equal(Math.abs(expectedLeft - expectedRight), 1);
  assert.equal(blocks[0].bitallocMode, Math.max(expectedLeft, expectedRight));
  assert.equal(blocks[1].bitallocMode, Math.max(expectedLeft, expectedRight));
});

test("initializeChannelBlock stages scalefactor-derived band levels and quant units from runtime buffers", () => {
  const runtimeBlock = createRuntimeBlock(1);
  const [channel] = runtimeBlock.channelEntries;
  runtimeBlock.shared.codedBandLimit = 2;
  runtimeBlock.shared.mapSegmentCount = 0;
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.aux.intensityBand = Uint32Array.of(1);

  setBandSpectrum(runtimeBlock.quantizedSpectraByChannel[0], 0, [4, ...Array(15).fill(1)]);
  setBandSpectrum(runtimeBlock.quantizedSpectraByChannel[0], 1, 0);
  setBandSpectrum(runtimeBlock.bitallocSpectraByChannel[0], 0, [2, ...Array(15).fill(0.5)]);
  setBandSpectrum(runtimeBlock.bitallocSpectraByChannel[0], 1, [1.5, ...Array(15).fill(0.25)]);

  channel.curBuf = {
    scaleFactorIndices: new Int32Array(32),
    bandScales: Float32Array.from({ length: 32 }, () => 99),
  };
  channel.prevBuf = {
    scaleFactorIndices: Int32Array.of(7, 5),
    bandScales: Float32Array.of(2.5, 6.0),
  };

  const expectedScaleFactorIndices = new Uint32Array(32);
  const expectedMax = new Float32Array(32);
  deriveScalefactorsFromSpectrumAt5(
    runtimeBlock.quantizedSpectraByChannel[0],
    expectedScaleFactorIndices,
    expectedMax,
    2
  );

  const expectedBitallocScaleFactorIndices = new Int32Array(32);
  const expectedAltMax = new Float32Array(32);
  deriveScalefactorsFromSpectrumAt5(
    runtimeBlock.bitallocSpectraByChannel[0],
    expectedBitallocScaleFactorIndices,
    expectedAltMax,
    2
  );

  const band0Start = AT5_ISPS[0] >>> 0;
  const band0Count = (AT5_ISPS[1] >>> 0) - band0Start;
  const expectedScale0 = Math.fround(
    computeBandScale(
      expectedMax[0],
      runtimeBlock.quantizedSpectraByChannel[0],
      band0Start,
      band0Count
    )
  );
  const expectedBandLevels = [
    Math.fround((expectedScale0 + 2.5) * 0.5),
    Math.fround((1.0 + 6.0) * 0.5),
  ];
  const expectedQuantUnits = [
    Math.trunc(((expectedBitallocScaleFactorIndices[0] | 0) + 7) * 0.5 + 0.5),
    Math.trunc(((expectedBitallocScaleFactorIndices[1] | 0) + 5) * 0.5 + 0.5),
  ];

  const { blocks } = runInit(runtimeBlock);

  assert.deepEqual(
    Array.from(channel.idsf.values.slice(0, 2)),
    Array.from(expectedScaleFactorIndices.slice(0, 2))
  );
  assert.deepEqual(
    Array.from(channel.curBuf.scaleFactorIndices.slice(0, 2)),
    Array.from(expectedBitallocScaleFactorIndices.slice(0, 2))
  );
  assert.deepEqual(
    Array.from(blocks[0].bandPeaks.slice(0, 2)),
    Array.from(expectedMax.slice(0, 2))
  );
  assert.deepEqual(
    Array.from(blocks[0].bitallocBandPeaks.slice(0, 2)),
    Array.from(expectedAltMax.slice(0, 2))
  );

  assert.equal(channel.curBuf.bandScales[0], expectedScale0);
  assert.equal(channel.curBuf.bandScales[1], 1);
  assert.deepEqual(Array.from(blocks[0].quantUnitsByBand.slice(0, 2)), expectedQuantUnits);
  assert.deepEqual(Array.from(blocks[0].bandLevels.slice(0, 2)), expectedBandLevels);
  assert.equal(blocks[0].avgBandLevel, (expectedBandLevels[0] + expectedBandLevels[1]) * 0.5);
  assert.equal(
    blocks[0].bitallocScale,
    Math.fround((blocks[0].baseMaxQuantMode * 10.0) / Math.max(1, ...expectedQuantUnits))
  );
});

test("initializeChannelBlock falls back to previous staging data when current buffers are missing", () => {
  const runtimeBlock = createRuntimeBlock(1);
  const [channel] = runtimeBlock.channelEntries;
  runtimeBlock.shared.codedBandLimit = 2;
  runtimeBlock.shared.mapSegmentCount = 0;
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.aux.intensityBand = Uint32Array.of(1);

  channel.prevBuf = {
    scaleFactorIndices: Int32Array.of(7, 5),
    bandScales: Float32Array.of(2.5, 6.0),
  };

  const { blocks } = runInit(runtimeBlock);

  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 2)), [0, 0]);
  assert.deepEqual(Array.from(blocks[0].quantUnitsByBand.slice(0, 2)), [4, 3]);
  assert.deepEqual(Array.from(blocks[0].bandLevels.slice(0, 2)), [1.25, 3]);
  assert.equal(blocks[0].avgBandLevel, 2.125);
  assert.equal(blocks[0].bitallocScale, 15);
});

test("initializeChannelBlock falls back independently when the current scale table is missing", () => {
  const runtimeBlock = createRuntimeBlock(1);
  const [channel] = runtimeBlock.channelEntries;
  runtimeBlock.shared.codedBandLimit = 2;
  runtimeBlock.shared.mapSegmentCount = 0;
  runtimeBlock.shared.sampleRateHz = 48000;
  runtimeBlock.aux.intensityBand = Uint32Array.of(1);

  setBandSpectrum(runtimeBlock.quantizedSpectraByChannel[0], 0, [4, ...Array(15).fill(1)]);
  setBandSpectrum(runtimeBlock.quantizedSpectraByChannel[0], 1, 0);
  setBandSpectrum(runtimeBlock.bitallocSpectraByChannel[0], 0, [2, ...Array(15).fill(0.5)]);
  setBandSpectrum(runtimeBlock.bitallocSpectraByChannel[0], 1, [1.5, ...Array(15).fill(0.25)]);

  channel.curBuf = {
    scaleFactorIndices: new Int32Array(32),
  };
  channel.prevBuf = {
    scaleFactorIndices: Int32Array.of(7, 5),
    bandScales: Float32Array.of(2.5, 6.0),
  };

  const expectedBitallocScaleFactorIndices = new Int32Array(32);
  const expectedAltMax = new Float32Array(32);
  deriveScalefactorsFromSpectrumAt5(
    runtimeBlock.bitallocSpectraByChannel[0],
    expectedBitallocScaleFactorIndices,
    expectedAltMax,
    2
  );

  const expectedQuantUnits = [
    Math.trunc(((expectedBitallocScaleFactorIndices[0] | 0) + 7) * 0.5 + 0.5),
    Math.trunc(((expectedBitallocScaleFactorIndices[1] | 0) + 5) * 0.5 + 0.5),
  ];

  const { blocks } = runInit(runtimeBlock);

  assert.deepEqual(
    Array.from(channel.curBuf.scaleFactorIndices.slice(0, 2)),
    Array.from(expectedBitallocScaleFactorIndices.slice(0, 2))
  );
  assert.deepEqual(
    Array.from(blocks[0].bitallocBandPeaks.slice(0, 2)),
    Array.from(expectedAltMax.slice(0, 2))
  );
  assert.deepEqual(Array.from(blocks[0].quantUnitsByBand.slice(0, 2)), expectedQuantUnits);
  assert.deepEqual(Array.from(blocks[0].bandLevels.slice(0, 2)), [1.25, 3]);
  assert.equal(blocks[0].avgBandLevel, 2.125);
  assert.equal(
    blocks[0].bitallocScale,
    Math.fround((blocks[0].baseMaxQuantMode * 10.0) / Math.max(1, ...expectedQuantUnits))
  );
});

test("normalizeChannelBlock seeds mode-3 header IDsF from the stereo difference spectrum", () => {
  const runtimeBlock = createRuntimeBlock(2);
  runtimeBlock.shared.codedBandLimit = 2;
  const hdr = createBitallocHeader(2);
  const blocks = createBlocks(2);
  const left = new Float32Array(2048);
  const right = new Float32Array(2048);

  setBandSpectrum(left, 0, [4, ...Array(15).fill(1)]);
  setBandSpectrum(right, 0, [1, ...Array(15).fill(0.25)]);
  setBandSpectrum(left, 1, [2, ...Array(15).fill(0.5)]);
  setBandSpectrum(right, 1, [0.5, ...Array(15).fill(0.125)]);

  const differenceSpectrum = new Float32Array(AT5_ISPS[2] >>> 0);
  for (let i = 0; i < differenceSpectrum.length; i += 1) {
    differenceSpectrum[i] = left[i] - right[i];
  }

  const expectedIdsf = new Uint32Array(32);
  const expectedMax = new Float32Array(32);
  deriveScalefactorsFromSpectrumAt5(differenceSpectrum, expectedIdsf, expectedMax, 2);

  runNorm(runtimeBlock, blocks, hdr, [left, right], 3);

  assert.deepEqual(Array.from(hdr.idsfValues.slice(0, 2)), Array.from(expectedIdsf.slice(0, 2)));
});

test("normalizeChannelBlock clamps normalized high-IDSF bands and refreshes scaled factors", () => {
  const runtimeBlock = createRuntimeBlock(1);
  runtimeBlock.shared.codedBandLimit = 2;
  const [channel] = runtimeBlock.channelEntries;
  const hdr = createBitallocHeader(1);
  const [block] = createBlocks(1);
  const quantizedSpectrum = new Float32Array(2048);
  const clampLimit = 1.12200927734375;
  const hotScale = AT5_SFTBL[0x3f];
  const coolScale = AT5_SFTBL[1];

  channel.idsf.values[0] = 0x3f;
  channel.idsf.values[1] = 1;
  block.bandPeaks[0] = 12;
  block.bandPeaks[1] = 6;

  setBandSpectrum(quantizedSpectrum, 0, [
    hotScale * 1.5,
    hotScale * -1.75,
    ...Array(14).fill(hotScale * 0.5),
  ]);
  setBandSpectrum(quantizedSpectrum, 1, [coolScale * 0.75, ...Array(15).fill(coolScale * 0.25)]);

  runNorm(runtimeBlock, [block], hdr, [quantizedSpectrum], 0);

  const band0Start = AT5_ISPS[0] >>> 0;
  const band1Start = AT5_ISPS[1] >>> 0;
  assert.equal(quantizedSpectrum[band0Start], clampLimit);
  assert.equal(quantizedSpectrum[band0Start + 1], -clampLimit);
  assertAlmostEqual(quantizedSpectrum[band0Start + 2], 0.5);
  assertAlmostEqual(quantizedSpectrum[band1Start], 0.75);
  assertAlmostEqual(block.normalizedBandPeaks[0], block.bandPeaks[0] / hotScale);
  assertAlmostEqual(block.normalizedBandPeaks[1], block.bandPeaks[1] / coolScale);
});
