import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  buildBasicAt5RegularBlockFromRuntime,
  createBasicBlockPlan,
  encodeBasicBlockPlanChannel,
} from "../../../src/atrac3plus/channel-block/basic-block.js";
import { AT5_ISPS } from "../../../src/atrac3plus/tables/unpack.js";

function createRecord(entries = 0, levels = [], locations = [], tlevFlag = 0) {
  return {
    entries,
    levels: Uint32Array.from(levels),
    locations: Uint32Array.from(locations),
    tlevFlag,
  };
}

function createBasicRuntimeBlock({ amplitude = 100, secondBandAmplitude = 0 } = {}) {
  const regularBlock = createAt5RegularBlockState(1);
  const [channel] = regularBlock.channels;
  const baseSpec = new Float32Array(2048);
  const altSpec = new Float32Array(2048);
  const secondBandStart = AT5_ISPS[1] >>> 0;

  baseSpec[0] = amplitude;
  altSpec[0] = amplitude;
  baseSpec[secondBandStart] = secondBandAmplitude;
  altSpec[secondBandStart] = secondBandAmplitude;

  return {
    channelsInBlock: 1,
    ispsIndex: 6,
    blockState: { encodeMode: 0 },
    shared: {
      coreMode: 0x05,
      sampleRateHz: 44100,
      mapSegmentCount: 1,
      encodeFlags: 0,
    },
    channelEntries: [
      {
        ...channel,
        curBuf: {
          records: [createRecord(1, [6], [0], 1)],
          tlevFlagsCopy: Uint32Array.of(1),
        },
        prevBuf: {
          records: [createRecord()],
        },
      },
    ],
    quantizedSpectraByChannel: [baseSpec],
    bitallocSpectraByChannel: [altSpec],
  };
}

function createStereoBasicRuntimeBlock() {
  const regularBlock = createAt5RegularBlockState(2);
  const quantizedSpectraByChannel = [new Float32Array(2048), new Float32Array(2048)];
  const bitallocSpectraByChannel = [new Float32Array(2048), new Float32Array(2048)];

  quantizedSpectraByChannel[0][0] = 1;
  quantizedSpectraByChannel[1][0] = 2;
  bitallocSpectraByChannel[0][0] = 10;
  bitallocSpectraByChannel[1][0] = 20;

  return {
    channelsInBlock: 2,
    ispsIndex: 6,
    blockState: { encodeMode: 0 },
    shared: {
      coreMode: 0x05,
      sampleRateHz: 44100,
      mapSegmentCount: 1,
      encodeFlags: 0,
      swapMap: Uint32Array.of(1),
    },
    channelEntries: regularBlock.channels,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
  };
}

function createBasicEncodeFixture(runtimeBlock, { secondBitOffset = 0, ...options } = {}) {
  return createBasicBlockPlan(runtimeBlock, { ...options, secondBitOffset });
}

test("createBasicBlockPlan keeps swap-adjusted quantized and bitalloc spectra separate", () => {
  const runtimeBlock = createStereoBasicRuntimeBlock();
  const plan = createBasicEncodeFixture(runtimeBlock);

  assert.notEqual(plan.quantizedSpectraByChannel, runtimeBlock.quantizedSpectraByChannel);
  assert.notEqual(plan.bitallocSpectraByChannel, runtimeBlock.bitallocSpectraByChannel);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[0][0], 1);
  assert.equal(runtimeBlock.quantizedSpectraByChannel[1][0], 2);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[0][0], 10);
  assert.equal(runtimeBlock.bitallocSpectraByChannel[1][0], 20);
  assert.equal(plan.quantizedSpectraByChannel[0][0], 2);
  assert.equal(plan.quantizedSpectraByChannel[1][0], 1);
  assert.equal(plan.bitallocSpectraByChannel[0][0], 20);
  assert.equal(plan.bitallocSpectraByChannel[1][0], 10);
});

test("encodeBasicBlockPlanChannel resets stale state before exact single-spike quantization", () => {
  const runtimeBlock = createBasicRuntimeBlock();
  const plan = createBasicEncodeFixture(runtimeBlock, { useExactQuant: true });
  const channel = plan.block.channels[0];

  channel.idwl.values[0] = 9;
  channel.idsf.values[0] = 9;
  channel.idct.values[0] = 9;
  channel.scratchSpectra.fill(3);
  channel.spclevIndex.fill(1);

  encodeBasicBlockPlanChannel(plan, 0);

  assert.equal(channel.gain.hasData, 1);
  assert.equal(channel.gain.activeCount, 1);
  assert.deepEqual(Array.from(channel.channelPresence.flags.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [5, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 4)), [35, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idct.values.slice(0, 4)), [5, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.spclevIndex.slice(0, 4)), [0xf, 0xf, 0xf, 0xf]);
  assert.deepEqual(Array.from(channel.scratchSpectra.slice(0, 8)), [7, 0, 0, 0, 0, 0, 0, 0]);
});

test("encodeBasicBlockPlanChannel clears quiet refined bands that quantize to zero", () => {
  const runtimeBlock = createBasicRuntimeBlock({ amplitude: 0.01 });
  const plan = createBasicEncodeFixture(runtimeBlock, { useExactQuant: false });
  const channel = plan.block.channels[0];

  channel.scratchSpectra.fill(9);

  encodeBasicBlockPlanChannel(plan, 0);

  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idct.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.spclevIndex.slice(0, 4)), [0xf, 0xf, 0xf, 0xf]);
  assert.deepEqual(Array.from(channel.scratchSpectra.slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("buildBasicAt5RegularBlockFromRuntime preserves refined single-spike quantization", () => {
  const block = buildBasicAt5RegularBlockFromRuntime(createBasicRuntimeBlock(), {
    useExactQuant: false,
    secondBitOffset: 0,
  });
  const [channel] = block.channels;

  assert.equal(block.shared.idsfCount, 1);
  assert.equal(block.shared.mapCount, 1);
  assert.equal(block.encoderDebug.secondBitOffset, 0);
  assert.equal(channel.gain.hasData, 1);
  assert.equal(channel.gain.activeCount, 1);
  assert.deepEqual(Array.from(channel.channelPresence.flags.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [5, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 4)), [36, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idct.values.slice(0, 4)), [5, 0, 0, 0]);
  assert.equal(channel.idct.count, 1);
  assert.deepEqual(Array.from(channel.scratchSpectra.slice(0, 8)), [6, 0, 0, 0, 0, 0, 0, 0]);
});

test("buildBasicAt5RegularBlockFromRuntime preserves exact single-spike quantization", () => {
  const block = buildBasicAt5RegularBlockFromRuntime(createBasicRuntimeBlock(), {
    useExactQuant: true,
    secondBitOffset: 0,
  });
  const [channel] = block.channels;

  assert.equal(block.shared.idsfCount, 1);
  assert.equal(block.shared.mapCount, 1);
  assert.equal(block.encoderDebug.secondBitOffset, 0);
  assert.equal(channel.gain.hasData, 1);
  assert.equal(channel.gain.activeCount, 1);
  assert.deepEqual(Array.from(channel.channelPresence.flags.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [5, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 4)), [35, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idct.values.slice(0, 4)), [5, 0, 0, 0]);
  assert.equal(channel.idct.count, 1);
  assert.deepEqual(Array.from(channel.scratchSpectra.slice(0, 8)), [7, 0, 0, 0, 0, 0, 0, 0]);
});

test("buildBasicAt5RegularBlockFromRuntime clears quiet bands that quantize to zero", () => {
  const block = buildBasicAt5RegularBlockFromRuntime(createBasicRuntimeBlock({ amplitude: 0.01 }), {
    useExactQuant: false,
    secondBitOffset: 0,
  });
  const [channel] = block.channels;

  assert.equal(block.shared.idsfCount, 0);
  assert.equal(block.shared.mapCount, 1);
  assert.equal(block.idsfShared.idsfGroupCount, 1);
  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.idct.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.equal(channel.idct.count, 0);
  assert.deepEqual(Array.from(channel.scratchSpectra.slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.spclevIndex.slice(0, 4)), [0xf, 0xf, 0xf, 0xf]);
});

test("buildBasicAt5RegularBlockFromRuntime mirrors gain-mode state into the IDCT shared tail", () => {
  const runtimeBlock = createBasicRuntimeBlock();
  runtimeBlock.blockState.encodeMode = 2;

  const block = buildBasicAt5RegularBlockFromRuntime(runtimeBlock, {
    useExactQuant: false,
    secondBitOffset: 0,
  });
  const [channel] = block.channels;

  assert.equal(block.shared.gainModeFlag, 0);
  assert.equal(channel.idct.count, 1);
  assert.equal(channel.idctState.shared.maxCount, 1);
  assert.equal(channel.idctState.shared.fixIdx, 0);
  assert.equal(channel.idctState.shared.gainModeFlag, 0);
});

test("buildBasicAt5RegularBlockFromRuntime honors bandLimit overrides for later active bands", () => {
  const runtimeBlock = createBasicRuntimeBlock({ secondBandAmplitude: 30 });
  const fullBlock = buildBasicAt5RegularBlockFromRuntime(runtimeBlock, {
    useExactQuant: false,
    secondBitOffset: 0,
  });
  const limitedBlock = buildBasicAt5RegularBlockFromRuntime(runtimeBlock, {
    bandLimit: 1,
    useExactQuant: false,
    secondBitOffset: 0,
  });
  const [fullChannel] = fullBlock.channels;
  const [limitedChannel] = limitedBlock.channels;
  const secondBandStart = AT5_ISPS[1] >>> 0;

  assert.equal(fullBlock.shared.idsfCount, 2);
  assert.deepEqual(Array.from(fullChannel.idwl.values.slice(0, 4)), [6, 5, 0, 0]);

  assert.equal(limitedBlock.shared.codedBandLimit, 1);
  assert.equal(limitedBlock.shared.mapSegmentCount, 1);
  assert.equal(limitedBlock.shared.idsfCount, 1);
  assert.equal(limitedBlock.idsfShared.idsfCount, 1);
  assert.deepEqual(Array.from(limitedChannel.idwl.values.slice(0, 4)), [6, 0, 0, 0]);
  assert.deepEqual(Array.from(limitedChannel.idsf.values.slice(0, 4)), [35, 0, 0, 0]);
  assert.deepEqual(Array.from(limitedChannel.idct.values.slice(0, 4)), [7, 0, 0, 0]);
  assert.equal(limitedChannel.idct.count, 1);
  assert.deepEqual(
    Array.from(limitedChannel.scratchSpectra.slice(secondBandStart, secondBandStart + 8)),
    [0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("buildBasicAt5RegularBlockFromRuntime keeps later exact-quant bands active", () => {
  const block = buildBasicAt5RegularBlockFromRuntime(
    createBasicRuntimeBlock({ secondBandAmplitude: 10 }),
    {
      useExactQuant: true,
      secondBitOffset: 0,
    }
  );
  const [channel] = block.channels;
  const secondBandStart = AT5_ISPS[1] >>> 0;

  assert.equal(block.shared.idsfCount, 2);
  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [6, 4, 0, 0]);
  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 4)), [35, 25, 0, 0]);
  assert.deepEqual(Array.from(channel.idct.values.slice(0, 4)), [7, 7, 0, 0]);
  assert.equal(channel.idct.count, 2);
  assert.deepEqual(
    Array.from(channel.scratchSpectra.slice(secondBandStart, secondBandStart + 8)),
    [5, 0, 0, 0, 0, 0, 0, 0]
  );
});
