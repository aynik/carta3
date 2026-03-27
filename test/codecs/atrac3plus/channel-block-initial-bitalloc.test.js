import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  initializeQuantModes,
  normalizeBandLimit,
  seedInitialBitalloc,
  selectGainCodingMode,
} from "../../../src/atrac3plus/channel-block/initial-bitalloc.js";
import { createAt5SigprocAux } from "../../../src/atrac3plus/sigproc/aux.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";

function createInitialBitallocFixture(channelCount) {
  const runtimeBlock = createAt5RegularBlockState(channelCount);
  runtimeBlock.shared.codedBandLimit = 0;
  runtimeBlock.shared.mapSegmentCount = 0;
  runtimeBlock.shared.sampleRateHz = 44100;
  runtimeBlock.shared.encodeFlags = 0;

  const hdr = createBitallocHeader(channelCount);
  const blocks = Array.from({ length: channelCount }, () => createChannelBlock());
  for (const block of blocks) {
    block.bitallocHeader = hdr;
  }

  return { runtimeBlock, hdr, blocks, channels: runtimeBlock.channels };
}

function applyGainRecords(channel, records) {
  const gain = channel.gain;
  gain.hasData = records.length > 0 ? 1 : 0;
  gain.hasDeltaFlag = 0;
  gain.activeCount = records.length;
  gain.uniqueCount = records.length;

  for (const record of gain.records) {
    record.entries = 0;
    record.locations.fill(0);
    record.levels.fill(0);
  }

  for (const [index, srcRecord] of records.entries()) {
    const dstRecord = gain.records[index];
    dstRecord.entries = srcRecord.locations.length;
    for (let i = 0; i < dstRecord.entries; i += 1) {
      dstRecord.locations[i] = srcRecord.locations[i];
      dstRecord.levels[i] = srcRecord.levels[i];
    }
  }
}

function runInitialBitalloc(fixture, coreMode = 0, { maxBits = 1000 } = {}) {
  return seedInitialBitalloc({
    runtimeBlock: fixture.runtimeBlock,
    hdr: fixture.hdr,
    blocks: fixture.blocks,
    quantizedSpectraByChannel: Array.from(
      { length: fixture.channels.length },
      () => new Float32Array(2048)
    ),
    channels: fixture.channels,
    blockMode: 0,
    coreMode,
    maxBits,
  });
}

function assertApprox(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

test("initializeQuantModes preserves stereo mode-3 masking and delta flags", () => {
  const fixture = createInitialBitallocFixture(2);
  const [, rightBlock] = fixture.blocks;
  const [leftChannel, rightChannel] = fixture.channels;

  leftChannel.idwl.values[0] = 2;
  leftChannel.idwl.values[1] = 2;
  fixture.hdr.mode3BandMask[0] = 1;
  fixture.hdr.mode3BandMask[1] = 1;

  rightBlock.quantModeBaseByBand[0] = 2.1;
  rightBlock.quantModeBaseByBand[1] = 2.1;
  rightBlock.quantUnitsByBand[0] = 1;
  rightBlock.quantUnitsByBand[1] = 1;
  rightBlock.maxQuantModeByBand[0] = 7;
  rightBlock.maxQuantModeByBand[1] = 0;

  initializeQuantModes(
    rightBlock,
    rightChannel,
    2,
    2,
    0x1b,
    leftChannel.idwl.values,
    null,
    fixture.hdr.mode3BandMask,
    fixture.hdr.mode3DeltaFlags
  );

  assert.deepEqual(Array.from(rightChannel.idwl.values.slice(0, 2)), [0, 0]);
  assert.deepEqual(Array.from(rightBlock.quantModeByBand.slice(0, 2)), [0, 0]);
  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(0, 2)), [1, 0]);
  assert.deepEqual(Array.from(fixture.hdr.mode3DeltaFlags.slice(0, 2)), [0, 1]);
});

test("initializeQuantModes preserves active bands when the base stereo band is zero", () => {
  const fixture = createInitialBitallocFixture(2);
  const [, rightBlock] = fixture.blocks;
  const [, rightChannel] = fixture.channels;
  const baseQuantModes = new Uint32Array([0]);
  fixture.hdr.mode3BandMask[0] = 1;

  rightBlock.quantModeBaseByBand[0] = 3.1;
  rightBlock.quantUnitsByBand[0] = 1;
  rightBlock.maxQuantModeByBand[0] = 7;

  initializeQuantModes(
    rightBlock,
    rightChannel,
    1,
    2,
    0x1b,
    baseQuantModes,
    null,
    fixture.hdr.mode3BandMask,
    fixture.hdr.mode3DeltaFlags
  );

  assert.equal(rightChannel.idwl.values[0], 3);
  assert.equal(fixture.hdr.mode3BandMask[0], 0);
  assert.equal(fixture.hdr.mode3DeltaFlags[0], 0);
});

test("initializeQuantModes preserves aux-masked zeroing at higher core modes", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;
  const [channel] = fixture.channels;
  const auxZeroBandMask = new Uint8Array([1, 0]);

  block.quantModeBaseByBand[0] = 1.2;
  block.quantModeBaseByBand[1] = 1.2;
  block.quantUnitsByBand[0] = 0;
  block.quantUnitsByBand[1] = 0;
  block.maxQuantModeByBand[0] = 7;
  block.maxQuantModeByBand[1] = 7;

  initializeQuantModes(block, channel, 2, 1, 0x17, null, auxZeroBandMask);

  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 2)), [0, 1]);
  assert.deepEqual(Array.from(block.quantModeByBand.slice(0, 2)), [0, 1]);
});

test("initializeQuantModes zeros inactive bands at lower core modes without aux masks", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;
  const [channel] = fixture.channels;

  block.quantModeBaseByBand[0] = 2.4;
  block.quantUnitsByBand[0] = 0;
  block.maxQuantModeByBand[0] = 7;

  initializeQuantModes(block, channel, 1, 1, 0x16);

  assert.equal(channel.idwl.values[0], 0);
  assert.equal(block.quantModeByBand[0], 0);
});

test("normalizeBandLimit expands 29-31 active bands to the 32-band layout", () => {
  const fixture = createInitialBitallocFixture(2);
  fixture.runtimeBlock.shared.codedBandLimit = 30;
  fixture.runtimeBlock.shared.mapSegmentCount = 9;
  fixture.channels[0].idwl.values[30] = 9;
  fixture.channels[0].idwl.values[31] = 8;
  fixture.channels[1].idwl.values[30] = 7;
  fixture.channels[1].idwl.values[31] = 6;

  normalizeBandLimit(fixture.runtimeBlock.shared, fixture.channels, 30, 2);

  assert.equal(fixture.runtimeBlock.shared.bandLimit, 0x20);
  assert.equal(fixture.runtimeBlock.shared.channelPresenceMapCount, 0x10);
  assert.deepEqual(Array.from(fixture.channels[0].idwl.values.slice(30, 32)), [0, 0]);
  assert.deepEqual(Array.from(fixture.channels[1].idwl.values.slice(30, 32)), [0, 0]);
});

test("selectGainCodingMode preserves compact primary gain delta metadata", () => {
  const fixture = createInitialBitallocFixture(1);
  const [channel] = fixture.channels;

  applyGainRecords(channel, [
    { locations: [0, 1], levels: [0, 1] },
    { locations: [1, 2], levels: [0, 1] },
    { locations: [2, 3], levels: [0, 1] },
    { locations: [3, 4], levels: [0, 1] },
  ]);

  const bits = selectGainCodingMode(channel);

  assert.equal(bits, 42);
  assert.equal(channel.gain.ngcMode, 3);
  assert.equal(channel.gain.idlevMode, 3);
  assert.equal(channel.gain.idlocMode, 3);
  assert.equal(channel.gain.n0, 0);
  assert.equal(channel.gain.n1, 2);
  assert.equal(channel.gain.idlevWidth, 1);
  assert.equal(channel.gain.idlevBase, 0);
  assert.equal(channel.gain.idlocStep, 2);
  assert.equal(channel.gain.idlocBase, 0);
});

test("selectGainCodingMode derives compact primary location bias from shared offsets", () => {
  const fixture = createInitialBitallocFixture(1);
  const [channel] = fixture.channels;

  applyGainRecords(channel, [
    { locations: [5, 6], levels: [0, 1] },
    { locations: [6, 7], levels: [0, 1] },
    { locations: [7, 8], levels: [0, 1] },
    { locations: [8, 9], levels: [0, 1] },
  ]);

  const bits = selectGainCodingMode(channel);

  assert.equal(bits, 42);
  assert.equal(channel.gain.ngcMode, 3);
  assert.equal(channel.gain.idlevMode, 3);
  assert.equal(channel.gain.idlocMode, 3);
  assert.equal(channel.gain.idlocStep, 2);
  assert.equal(channel.gain.idlocBase, 5);
});

test("selectGainCodingMode preserves stale primary delta metadata when mode-3 candidates overflow", () => {
  const fixture = createInitialBitallocFixture(1);
  const [channel] = fixture.channels;

  channel.gain.idlevWidth = 99;
  channel.gain.idlevBase = 88;
  channel.gain.idlocStep = 77;
  channel.gain.idlocBase = 66;

  applyGainRecords(channel, [
    { locations: [0, 32, 63], levels: [0, 15, 0] },
    { locations: [0, 32, 63], levels: [15, 0, 15] },
  ]);

  const bits = selectGainCodingMode(channel);

  assert.equal(bits, 43);
  assert.equal(channel.gain.ngcMode, 2);
  assert.equal(channel.gain.idlevMode, 2);
  assert.equal(channel.gain.idlocMode, 2);
  assert.equal(channel.gain.idlevWidth, 99);
  assert.equal(channel.gain.idlevBase, 88);
  assert.equal(channel.gain.idlocStep, 77);
  assert.equal(channel.gain.idlocBase, 66);
});

test("selectGainCodingMode preserves channel-1 reuse flags and zero-cost reuse modes", () => {
  const fixture = createInitialBitallocFixture(2);
  const [baseChannel, channel] = fixture.channels;

  applyGainRecords(baseChannel, [
    { locations: [0, 3], levels: [2, 5] },
    { locations: [1, 4], levels: [2, 5] },
  ]);
  applyGainRecords(channel, [
    { locations: [0, 3], levels: [2, 5] },
    { locations: [1, 4], levels: [2, 5] },
  ]);

  const bits = selectGainCodingMode(channel);

  assert.equal(bits, 0);
  assert.equal(channel.gain.ngcMode, 3);
  assert.equal(channel.gain.idlevMode, 3);
  assert.equal(channel.gain.idlocMode, 3);
  assert.deepEqual(Array.from(channel.gain.idlevFlags.slice(0, 2)), [0, 0]);
  assert.deepEqual(Array.from(channel.gain.idlocFlags.slice(0, 2)), [0, 0]);
});

test("selectGainCodingMode preserves channel-1 delta flags against the base channel", () => {
  const fixture = createInitialBitallocFixture(2);
  const [baseChannel, channel] = fixture.channels;

  applyGainRecords(baseChannel, [
    { locations: [0, 1], levels: [0, 1] },
    { locations: [1, 2], levels: [0, 1] },
  ]);
  applyGainRecords(channel, [
    { locations: [0, 1, 5], levels: [0, 1, 7] },
    { locations: [1, 2], levels: [0, 2] },
  ]);

  selectGainCodingMode(channel);

  assert.equal(channel.gain.ngcMode, 2);
  assert.equal(channel.gain.idlevMode, 1);
  assert.equal(channel.gain.idlocMode, 3);
  assert.deepEqual(Array.from(channel.gain.idlevFlags.slice(0, 2)), [0, 1]);
  assert.deepEqual(Array.from(channel.gain.idlocFlags.slice(0, 2)), [1, 0]);
});

test("seedInitialBitalloc keeps compact channel-0 gain coding metadata aligned", () => {
  const fixture = createInitialBitallocFixture(1);
  const [channel] = fixture.channels;

  applyGainRecords(channel, [
    { locations: [0, 1], levels: [0, 1] },
    { locations: [1, 2], levels: [0, 1] },
    { locations: [2, 3], levels: [0, 1] },
    { locations: [3, 4], levels: [0, 1] },
  ]);

  const total = runInitialBitalloc(fixture);

  assert.equal(total, 65);
  assert.equal(fixture.hdr.bitsGain, 54);
  assert.equal(channel.gain.ngcMode, 3);
  assert.equal(channel.gain.idlevMode, 3);
  assert.equal(channel.gain.idlocMode, 3);
  assert.equal(channel.gain.n0, 0);
  assert.equal(channel.gain.n1, 2);
  assert.equal(channel.gain.idlevWidth, 1);
  assert.equal(channel.gain.idlevBase, 0);
  assert.equal(channel.gain.idlocStep, 2);
  assert.equal(channel.gain.idlocBase, 0);
});

test("seedInitialBitalloc preserves channel-1 gain flag staging against the base channel", () => {
  const fixture = createInitialBitallocFixture(2);
  const [baseChannel, channel] = fixture.channels;

  applyGainRecords(baseChannel, [
    { locations: [0, 1], levels: [0, 1] },
    { locations: [1, 2], levels: [0, 1] },
  ]);
  applyGainRecords(channel, [
    { locations: [0, 1, 5], levels: [0, 1, 7] },
    { locations: [1, 2], levels: [0, 2] },
  ]);

  const total = runInitialBitalloc(fixture, 0x1b);

  assert.equal(total, 79);
  assert.equal(fixture.hdr.bitsGain, 63);
  assert.equal(baseChannel.gain.ngcMode, 2);
  assert.equal(baseChannel.gain.idlevMode, 3);
  assert.equal(baseChannel.gain.idlocMode, 3);
  assert.equal(channel.gain.ngcMode, 2);
  assert.equal(channel.gain.idlevMode, 1);
  assert.equal(channel.gain.idlocMode, 3);
  assert.deepEqual(Array.from(channel.gain.idlevFlags.slice(0, 2)), [0, 1]);
  assert.deepEqual(Array.from(channel.gain.idlocFlags.slice(0, 2)), [1, 0]);
});

test("seedInitialBitalloc preserves zero-cost channel-1 gain reuse against the base channel", () => {
  const fixture = createInitialBitallocFixture(2);
  const [baseChannel, channel] = fixture.channels;

  applyGainRecords(baseChannel, [
    { locations: [0, 3], levels: [2, 5] },
    { locations: [1, 4], levels: [2, 5] },
  ]);
  applyGainRecords(channel, [
    { locations: [0, 3], levels: [2, 5] },
    { locations: [1, 4], levels: [2, 5] },
  ]);

  const total = runInitialBitalloc(fixture, 0x1b);

  assert.equal(total, 73);
  assert.equal(fixture.hdr.bitsGain, 57);
  assert.equal(channel.gain.ngcMode, 3);
  assert.equal(channel.gain.idlevMode, 3);
  assert.equal(channel.gain.idlocMode, 3);
  assert.deepEqual(Array.from(channel.gain.idlevFlags.slice(0, 2)), [0, 0]);
  assert.deepEqual(Array.from(channel.gain.idlocFlags.slice(0, 2)), [0, 0]);
});

test("seedInitialBitalloc preserves stale channel-0 delta metadata when mode-3 gain candidates are invalid", () => {
  const fixture = createInitialBitallocFixture(1);
  const [channel] = fixture.channels;

  channel.gain.idlevWidth = 99;
  channel.gain.idlevBase = 88;
  channel.gain.idlocStep = 77;
  channel.gain.idlocBase = 66;

  applyGainRecords(channel, [
    { locations: [0, 32, 63], levels: [0, 15, 0] },
    { locations: [0, 32, 63], levels: [15, 0, 15] },
  ]);

  const total = runInitialBitalloc(fixture);

  assert.equal(total, 66);
  assert.equal(fixture.hdr.bitsGain, 55);
  assert.equal(channel.gain.ngcMode, 2);
  assert.equal(channel.gain.idlevMode, 2);
  assert.equal(channel.gain.idlocMode, 2);
  assert.equal(channel.gain.idlevWidth, 99);
  assert.equal(channel.gain.idlevBase, 88);
  assert.equal(channel.gain.idlocStep, 77);
  assert.equal(channel.gain.idlocBase, 66);
});

test("seedInitialBitalloc preserves active-context hcspec costs and total recomputation", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;
  const [channel] = fixture.channels;

  fixture.runtimeBlock.shared.codedBandLimit = 1;

  block.bitallocScale = 5;
  block.quantUnitsByBand[0] = 4;
  block.maxQuantModeByBand[0] = 7;
  block.normalizedBandPeaks[0] = 1;
  block.quantizedSpectrum = Float32Array.from({ length: 2048 }, (_, index) =>
    index < 16 ? ((index % 7) - 3) * 0.75 : 0
  );
  fixture.hdr.tblIndex = 0;

  const total = seedInitialBitalloc({
    runtimeBlock: fixture.runtimeBlock,
    hdr: fixture.hdr,
    blocks: fixture.blocks,
    quantizedSpectraByChannel: [block.quantizedSpectrum],
    channels: fixture.channels,
    channelCount: 1,
    blockMode: 0,
    coreMode: 0,
    maxBits: 1000,
  });

  assert.equal(channel.idwl.values[0], 3);
  assert.equal(fixture.runtimeBlock.shared.idsfCount, 1);
  assert.equal(fixture.runtimeBlock.shared.mapCount, 1);
  assert.equal(total, 79);
  assert.equal(fixture.hdr.bitsTotalBase, 30);
  assert.equal(fixture.hdr.bitsTotal, 79);
  assert.equal(channel.rebitallocCtxId, 0);
  assert.deepEqual(Array.from(block.bitDeltaByCtx), [49, 0x4000]);
  assert.equal(block.hcspecWorkByCtx[0].bestIndexByBand[0], 2);
  assert.deepEqual(Array.from(block.hcspecWorkByCtx[0].costsByBand.slice(0, 4)), [58, 51, 49, 57]);
});

test("seedInitialBitalloc forces flat idsf packing when idsfModeWord is disabled", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;
  const [channel] = fixture.channels;

  fixture.runtimeBlock.shared.codedBandLimit = 1;
  fixture.hdr.idsfModeWord = 0;
  channel.idsfModeSelect = 9;
  channel.idsf.modeSelect = 9;

  block.bitallocScale = 5;
  block.quantUnitsByBand[0] = 4;
  block.maxQuantModeByBand[0] = 7;

  const total = runInitialBitalloc(fixture);

  assert.equal(total, fixture.hdr.bitsTotal);
  assert.equal(fixture.runtimeBlock.shared.idsfCount, 1);
  assert.equal(channel.idsfModeSelect, 0);
  assert.equal(channel.idsf.modeSelect, 0);
  assert.equal(fixture.hdr.bitsIdsf, 8);
});

test("seedInitialBitalloc preserves stereo-map overhead once three idsf bands are active", () => {
  const fixture = createInitialBitallocFixture(2);

  fixture.runtimeBlock.shared.codedBandLimit = 3;
  for (const block of fixture.blocks) {
    block.bitallocScale = 1;
    for (let band = 0; band < 3; band += 1) {
      block.quantUnitsByBand[band] = 1;
      block.maxQuantModeByBand[band] = 7;
    }
  }

  const total = runInitialBitalloc(fixture, 0x1b);

  assert.equal(total, 87);
  assert.equal(fixture.runtimeBlock.shared.idsfCount, 3);
  assert.equal(fixture.runtimeBlock.shared.mapCount, 1);
  assert.equal(fixture.hdr.bitsIdsf, 16);
  assert.equal(fixture.hdr.bitsStereoMaps, 10);
  assert.equal(fixture.hdr.bitsTotalBase, 81);
});

test("seedInitialBitalloc keeps swap and flip presence bits below the stereo-map selector threshold", () => {
  const fixture = createInitialBitallocFixture(2);

  fixture.runtimeBlock.shared.codedBandLimit = 1;
  for (const block of fixture.blocks) {
    block.bitallocScale = 1;
    block.quantUnitsByBand[0] = 1;
    block.maxQuantModeByBand[0] = 7;
  }

  runInitialBitalloc(fixture, 0x1b);

  assert.equal(fixture.runtimeBlock.shared.idsfCount, 1);
  assert.equal(fixture.runtimeBlock.shared.mapCount, 1);
  assert.equal(fixture.hdr.bitsStereoMaps, 2);
  assert.equal(fixture.runtimeBlock.shared.stereoSwapPresence.enabled, 0);
  assert.equal(fixture.runtimeBlock.shared.stereoFlipPresence.enabled, 0);
});

test("seedInitialBitalloc preserves seeded stereo swap and flip map bits", () => {
  const fixture = createInitialBitallocFixture(2);

  fixture.runtimeBlock.shared.codedBandLimit = 3;
  fixture.runtimeBlock.shared.stereoSwapPresence.flags[0] = 1;
  fixture.runtimeBlock.shared.stereoFlipPresence.flags[0] = 1;
  for (const block of fixture.blocks) {
    block.bitallocScale = 1;
    for (let band = 0; band < 3; band += 1) {
      block.quantUnitsByBand[band] = 1;
      block.maxQuantModeByBand[band] = 7;
    }
  }

  runInitialBitalloc(fixture, 0x1b);

  assert.equal(fixture.hdr.bitsStereoMaps, 12);
  assert.equal(fixture.runtimeBlock.shared.stereoSwapPresence.enabled, 1);
  assert.equal(fixture.runtimeBlock.shared.stereoSwapPresence.mixed, 0);
  assert.equal(fixture.runtimeBlock.shared.stereoFlipPresence.enabled, 1);
  assert.equal(fixture.runtimeBlock.shared.stereoFlipPresence.mixed, 0);
});

test("seedInitialBitalloc unlocks later quant modes when the block is comfortably under budget", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;

  fixture.runtimeBlock.shared.codedBandLimit = 2;
  block.bitallocScale = 1;
  block.quantUnitsByBand[0] = 1;
  block.quantUnitsByBand[1] = 1;
  block.maxQuantModeByBand[0] = 3;
  block.maxQuantModeByBand[1] = 4;

  const total = runInitialBitalloc(fixture, 0, { maxBits: 1000 });

  assert.equal(total, fixture.hdr.bitsTotal);
  assert.deepEqual(Array.from(block.maxQuantModeByBand.slice(0, 2)), [7, 7]);
});

test("seedInitialBitalloc keeps quant caps when cmode4 blocks skip budget unlock", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;
  const [channel] = fixture.channels;

  fixture.runtimeBlock.shared.codedBandLimit = 2;
  channel.blockState = { isMode4Block: 1 };
  block.bitallocScale = 1;
  block.quantUnitsByBand[0] = 1;
  block.quantUnitsByBand[1] = 1;
  block.maxQuantModeByBand[0] = 3;
  block.maxQuantModeByBand[1] = 4;

  const total = runInitialBitalloc(fixture, 0, { maxBits: 1000 });

  assert.equal(total, fixture.hdr.bitsTotal);
  assert.deepEqual(Array.from(block.maxQuantModeByBand.slice(0, 2)), [3, 4]);
});

test("seedInitialBitalloc preserves encode-flag direct bitalloc scaling", () => {
  const weightedFixture = createInitialBitallocFixture(1);
  const directFixture = createInitialBitallocFixture(1);
  weightedFixture.runtimeBlock.shared.codedBandLimit = 14;
  directFixture.runtimeBlock.shared.codedBandLimit = 14;
  directFixture.runtimeBlock.shared.encodeFlags = 0x04;

  for (const fixture of [weightedFixture, directFixture]) {
    const [block] = fixture.blocks;
    block.bitallocScale = 5;
    block.quantUnitsByBand[12] = 9;
    block.maxQuantModeByBand[12] = 7;
  }

  runInitialBitalloc(weightedFixture, 0x0d);
  runInitialBitalloc(directFixture, 0x0d);

  assertApprox(weightedFixture.blocks[0].quantModeBaseByBand[12], 4.090909004211426);
  assertApprox(directFixture.blocks[0].quantModeBaseByBand[12], 4.5);
  assert.equal(weightedFixture.channels[0].idwl.values[12], 4);
  assert.equal(directFixture.channels[0].idwl.values[12], 5);
});

test("seedInitialBitalloc preserves the 48 kHz high-band weight remap", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;

  fixture.runtimeBlock.shared.codedBandLimit = 20;
  fixture.runtimeBlock.shared.sampleRateHz = 48000;

  block.bitallocScale = 5;
  block.quantUnitsByBand[18] = 12;
  block.maxQuantModeByBand[18] = 7;

  const total = runInitialBitalloc(fixture, 0x0d);

  assert.equal(total, 173);
  assert.equal(fixture.hdr.bitsTotalBase, 109);
  assert.equal(fixture.hdr.bitsTotal, 173);
  assertApprox(block.quantModeBaseByBand[18], 4);
  assert.equal(fixture.channels[0].idwl.values[18], 4);
});

test("seedInitialBitalloc applies the mono wide-gain boost only when wideGainBoostFlag is enabled", () => {
  const boostedFixture = createInitialBitallocFixture(1);
  const plainFixture = createInitialBitallocFixture(1);

  for (const fixture of [boostedFixture, plainFixture]) {
    const [block] = fixture.blocks;
    fixture.runtimeBlock.shared.codedBandLimit = 2;
    fixture.runtimeBlock.shared.encodeFlags = 0x04;
    block.bitallocScale = 0;
    block.bandLevels[0] = 3.5;
    block.bandLevels[1] = 2.5;
    block.maxQuantModeByBand[0] = 7;
    block.maxQuantModeByBand[1] = 7;
  }

  boostedFixture.blocks[0].wideGainBoostFlag = 1;

  runInitialBitalloc(boostedFixture, 9);
  runInitialBitalloc(plainFixture, 9);

  assertApprox(plainFixture.blocks[0].quantModeBaseByBand[0], 0.5);
  assertApprox(plainFixture.blocks[0].quantModeBaseByBand[1], 0);
  assertApprox(boostedFixture.blocks[0].quantModeBaseByBand[0], 1.75);
  assertApprox(boostedFixture.blocks[0].quantModeBaseByBand[1], 0.5);
});

test("seedInitialBitalloc reads sparse-gain low-band offsets from runtime gain buffers", () => {
  const sparseFixture = createInitialBitallocFixture(2);
  const fullFixture = createInitialBitallocFixture(2);

  for (const fixture of [sparseFixture, fullFixture]) {
    fixture.runtimeBlock.shared.codedBandLimit = 8;
    fixture.runtimeBlock.shared.mapSegmentCount = 1;
    fixture.blocks[0].bitallocMode = 1;
    fixture.blocks[1].bitallocMode = 1;

    for (const channel of fixture.channels) {
      channel.bufA = {
        records: Array.from({ length: 8 }, () => ({
          entries: 0,
          levels: new Uint32Array(7),
          locations: new Uint32Array(7),
        })),
      };
    }
  }

  fullFixture.channels[0].bufA.records[0].entries = 1;
  fullFixture.channels[0].bufA.records[0].levels[0] = 6;

  runInitialBitalloc(sparseFixture, 0x0d);
  runInitialBitalloc(fullFixture, 0x0d);

  assertApprox(sparseFixture.blocks[0].quantModeBaseByBand[0], 0.2);
  assertApprox(fullFixture.blocks[0].quantModeBaseByBand[0], 0.95);
});

test("seedInitialBitalloc zeros only aux-disabled zero-quant bands at higher core modes", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;
  const auxBuffer = new ArrayBuffer(0x600);
  const auxF32 = new Float32Array(auxBuffer);

  fixture.runtimeBlock.shared.codedBandLimit = 12;
  fixture.runtimeBlock.shared.mapSegmentCount = 1;
  fixture.channels[0].sharedAux = { buffer: auxBuffer };

  auxF32[0x184 / 4] = -1;

  block.bitallocScale = 5;
  block.quantUnitsByBand[0] = 0;
  block.quantUnitsByBand[8] = 0;
  block.maxQuantModeByBand[0] = 7;
  block.maxQuantModeByBand[8] = 7;

  runInitialBitalloc(fixture, 0x17);

  assert.equal(fixture.channels[0].idwl.values[0], 0);
  assert.equal(fixture.channels[0].idwl.values[8], 1);
});

test("seedInitialBitalloc reads aux zero-band masks from named sigproc metric views", () => {
  const fixture = createInitialBitallocFixture(1);
  const [block] = fixture.blocks;
  const sharedAux = createAt5SigprocAux();

  fixture.runtimeBlock.shared.codedBandLimit = 12;
  fixture.runtimeBlock.shared.mapSegmentCount = 1;
  fixture.channels[0].sharedAux = sharedAux;

  sharedAux.corrMetric1Hist[0] = -1;

  block.bitallocScale = 5;
  block.quantUnitsByBand[0] = 0;
  block.quantUnitsByBand[8] = 0;
  block.maxQuantModeByBand[0] = 7;
  block.maxQuantModeByBand[8] = 7;

  runInitialBitalloc(fixture, 0x17);

  assert.equal(fixture.channels[0].idwl.values[0], 0);
  assert.equal(fixture.channels[0].idwl.values[8], 1);
});

test("seedInitialBitalloc keeps stereo mode-3 masks aligned with channel-1 quant zeroing", () => {
  const fixture = createInitialBitallocFixture(2);
  const [leftBlock, rightBlock] = fixture.blocks;

  fixture.runtimeBlock.shared.codedBandLimit = 2;
  fixture.hdr.mode3BandMask[0] = 1;
  fixture.hdr.mode3BandMask[1] = 1;

  leftBlock.bitallocScale = 5;
  leftBlock.quantUnitsByBand[0] = 1;
  leftBlock.quantUnitsByBand[1] = 1;
  leftBlock.maxQuantModeByBand[0] = 7;
  leftBlock.maxQuantModeByBand[1] = 7;

  rightBlock.bitallocScale = 5;
  rightBlock.quantUnitsByBand[0] = 1;
  rightBlock.quantUnitsByBand[1] = 1;
  rightBlock.maxQuantModeByBand[0] = 7;
  rightBlock.maxQuantModeByBand[1] = 0;

  runInitialBitalloc(fixture, 0x1b);

  assert.deepEqual(Array.from(fixture.channels[1].idwl.values.slice(0, 2)), [0, 0]);
  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(0, 2)), [1, 0]);
  assert.deepEqual(Array.from(fixture.hdr.mode3DeltaFlags.slice(0, 2)), [0, 1]);
});
