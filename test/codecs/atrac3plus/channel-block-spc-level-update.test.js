import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import { updateSpcLevelIndicesFromQuantizedData } from "../../../src/atrac3plus/channel-block/spc-levels.js";
import { AT5_ISPS } from "../../../src/atrac3plus/tables/unpack.js";

function setBandScratch(channel, band, value) {
  const start = AT5_ISPS[band] >>> 0;
  const end = AT5_ISPS[band + 1] >>> 0;
  channel.scratchSpectra.fill(value, start, end);
}

function createSpclevFixture({
  channelCount = 1,
  encodeFlags = 0,
  idsfCount = 9,
  mapCount = 4,
  mode3BandMask = null,
} = {}) {
  const block = createAt5RegularBlockState(channelCount);
  block.shared.idsfCount = idsfCount >>> 0;
  block.shared.mapCount = mapCount >>> 0;

  for (const channel of block.channels) {
    channel.spclevIndex = new Uint32Array(4);
    channel.idsf.values = new Uint32Array(32);
    channel.idwl.values = new Uint32Array(32);
    channel.scratchSpectra = new Int16Array(2048);
  }

  return {
    block,
    runtimeBlock: {
      shared: {
        encodeFlags,
        mode3BandMask,
      },
      channelEntries: Array.from({ length: channelCount }, () => ({
        curBuf: { records: [] },
        prevBuf: { records: [] },
      })),
    },
    initialModeAnalysis: {
      bootstrapByChannel: Array.from({ length: channelCount }, () => ({
        bandLevels: new Float32Array(32),
      })),
    },
  };
}

test("updateSpcLevelIndicesFromQuantizedData clears stale indices when SPC-level analysis is disabled", () => {
  const fixture = createSpclevFixture({ encodeFlags: 0x04 });
  fixture.block.channels[0].spclevIndex.set([1, 2, 3, 4]);

  updateSpcLevelIndicesFromQuantizedData(
    fixture.block,
    fixture.runtimeBlock,
    fixture.initialModeAnalysis,
    0
  );

  assert.deepEqual(Array.from(fixture.block.channels[0].spclevIndex), [0x0f, 0x0f, 0x0f, 0x0f]);
});

test("updateSpcLevelIndicesFromQuantizedData clears stale indices when initial band data is missing", () => {
  const fixture = createSpclevFixture();
  fixture.block.channels[0].spclevIndex.set([1, 2, 3, 4]);
  fixture.initialModeAnalysis.bootstrapByChannel[0] = null;

  updateSpcLevelIndicesFromQuantizedData(
    fixture.block,
    fixture.runtimeBlock,
    fixture.initialModeAnalysis,
    0
  );

  assert.deepEqual(Array.from(fixture.block.channels[0].spclevIndex), [0x0f, 0x0f, 0x0f, 0x0f]);
});

test("updateSpcLevelIndicesFromQuantizedData preserves the empty-band fallback to 0xf", () => {
  const fixture = createSpclevFixture();

  updateSpcLevelIndicesFromQuantizedData(
    fixture.block,
    fixture.runtimeBlock,
    fixture.initialModeAnalysis,
    0
  );

  assert.deepEqual(Array.from(fixture.block.channels[0].spclevIndex), [0x0f, 0x0f, 0x0f, 0x0f]);
});

test("updateSpcLevelIndicesFromQuantizedData assigns slot levels for active quantized bands", () => {
  const fixture = createSpclevFixture();
  const [channel] = fixture.block.channels;

  channel.idwl.values[8] = 5;
  channel.idsf.values[8] = 20;
  fixture.initialModeAnalysis.bootstrapByChannel[0].bandLevels[8] = 1;
  setBandScratch(channel, 8, 1);

  updateSpcLevelIndicesFromQuantizedData(
    fixture.block,
    fixture.runtimeBlock,
    fixture.initialModeAnalysis,
    0
  );

  assert.deepEqual(Array.from(channel.spclevIndex), [0x0f, 4, 0x0f, 0x0f]);
});

test("updateSpcLevelIndicesFromQuantizedData reuses channel 0 energy for masked stereo bands", () => {
  const masked = createSpclevFixture({
    channelCount: 2,
    mode3BandMask: Uint32Array.from({ length: 32 }, (_, band) => (band === 8 ? 1 : 0)),
  });
  const unmasked = createSpclevFixture({ channelCount: 2 });

  for (const fixture of [masked, unmasked]) {
    const [left, right] = fixture.block.channels;
    left.idwl.values[8] = 5;
    left.idsf.values[8] = 20;
    right.idsf.values[8] = 20;
    fixture.initialModeAnalysis.bootstrapByChannel[0].bandLevels[8] = 1;
    setBandScratch(left, 8, 1);
  }

  updateSpcLevelIndicesFromQuantizedData(
    unmasked.block,
    unmasked.runtimeBlock,
    unmasked.initialModeAnalysis,
    0
  );
  updateSpcLevelIndicesFromQuantizedData(
    masked.block,
    masked.runtimeBlock,
    masked.initialModeAnalysis,
    0
  );

  assert.equal(unmasked.block.channels[1].spclevIndex[1], 0x0f);
  assert.equal(masked.block.channels[0].spclevIndex[1], 4);
  assert.equal(masked.block.channels[1].spclevIndex[1], 4);
});
