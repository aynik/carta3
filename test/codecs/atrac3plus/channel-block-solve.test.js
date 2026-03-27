import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import { solveChannelBlock } from "../../../src/atrac3plus/channel-block/solve.js";
import { seedInitialBitalloc } from "../../../src/atrac3plus/channel-block/initial-bitalloc.js";
import { sharedUsedBitCount } from "../../../src/atrac3plus/shared-fields.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";

function createSolveFixture({ channelCount = 2, isMode4Block = 0 } = {}) {
  const runtimeBlock = createAt5RegularBlockState(channelCount);
  runtimeBlock.channelsInBlock = channelCount;
  runtimeBlock.shared.codedBandLimit = 1;
  runtimeBlock.shared.mapSegmentCount = 0;
  runtimeBlock.shared.sampleRateHz = 44100;
  runtimeBlock.shared.encodeFlags = 0;
  runtimeBlock.shared.coreMode = 0;
  runtimeBlock.blockState = { encodeMode: 0, isMode4Block };

  const hdr = createBitallocHeader(channelCount);
  const blocks = Array.from({ length: channelCount }, () => createChannelBlock());
  const quantizedSpectraByChannel = Array.from({ length: channelCount }, () =>
    Float32Array.from({ length: 2048 }, (_, index) => (index < 16 ? ((index % 7) - 3) * 0.75 : 0))
  );

  for (let ch = 0; ch < channelCount; ch += 1) {
    const block = blocks[ch];
    block.bitallocHeader = hdr;
    block.bitallocScale = 5;
    block.quantUnitsByBand[0] = 4;
    block.maxQuantModeByBand[0] = 7;
    block.normalizedBandPeaks[0] = 1;
    block.quantizedSpectrum = quantizedSpectraByChannel[ch];
    runtimeBlock.channels[ch].sharedAux = { intensityBand: Int32Array.from([0]) };
  }

  return { runtimeBlock, hdr, blocks, channels: runtimeBlock.channels, quantizedSpectraByChannel };
}

function runSolveFixture(fixture, trace = null) {
  seedInitialBitalloc({
    runtimeBlock: fixture.runtimeBlock,
    hdr: fixture.hdr,
    blocks: fixture.blocks,
    quantizedSpectraByChannel: fixture.quantizedSpectraByChannel,
    channels: fixture.channels,
    blockMode: 0,
    coreMode: 0,
    maxBits: 1000,
  });

  return solveChannelBlock({
    runtimeBlock: fixture.runtimeBlock,
    hdr: fixture.hdr,
    blocks: fixture.blocks,
    quantizedSpectraByChannel: fixture.quantizedSpectraByChannel,
    channels: fixture.channels,
    coreMode: 0,
    bitLimit: 1000,
    trace,
  });
}

test("solveChannelBlock traces the bitalloc-offset stage and stores the used bit count", () => {
  const fixture = createSolveFixture();
  const stages = [];

  const usedBits = runSolveFixture(fixture, (entry) => stages.push(entry));

  assert.equal(usedBits, fixture.hdr.bitsTotal);
  assert.equal(sharedUsedBitCount(fixture.runtimeBlock.shared), usedBits);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].stage, "sba2");
  assert.equal(stages[0].channelCount, 2);
  assert.equal(stages[0].bandCount, 1);
  assert.equal(stages[0].runtimeBlock, fixture.runtimeBlock);
});

test("solveChannelBlock mirrors only channel 0 for mode-4 mono blocks", () => {
  const fixture = createSolveFixture({ isMode4Block: 1 });

  const usedBits = runSolveFixture(fixture);

  assert.equal(usedBits, fixture.hdr.bitsTotal);
  assert.ok(fixture.channels[0].rebitallocMirrorBytes instanceof Uint8Array);
  assert.equal(fixture.channels[1].rebitallocMirrorBytes, undefined);
  assert.equal(sharedUsedBitCount(fixture.runtimeBlock.shared), usedBits);
});

test("solveChannelBlock disables IDWL and resets pack modes for flagged encodes", () => {
  const fixture = createSolveFixture();
  fixture.runtimeBlock.shared.encodeFlags = 0x04;
  fixture.channels[0].idwlPackMode = 7;
  fixture.channels[1].idwlPackMode = 7;

  const usedBits = runSolveFixture(fixture);

  assert.equal(usedBits, fixture.hdr.bitsTotal);
  assert.equal(fixture.hdr.idwlEnabled, 0);
  assert.equal(fixture.channels[0].idwlPackMode, 0);
  assert.equal(fixture.channels[1].idwlPackMode, 0);
});
