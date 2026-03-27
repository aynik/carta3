import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";
import { pruneCoefficientsWithinBudget } from "../../../src/atrac3plus/channel-block/late-budget.js";
import { AT5_ISPS, AT5_NSPS } from "../../../src/atrac3plus/tables/unpack.js";

function createCoefficientPruningFixture({
  band = 0,
  mode = 1,
  quantOffset = 0,
  baseIdx = 0,
  bitsIdct = 0,
  bitsTotal = 25,
  bitsTotalBase = 25,
  scale = 1,
} = {}) {
  const regularBlock = createAt5RegularBlockState(1);
  regularBlock.shared.encodeFlags = 0;
  regularBlock.shared.sampleRateHz = 44100;
  regularBlock.shared.bandLimit = band + 1;

  const [channel] = regularBlock.channels;
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
  const spec = new Float32Array(2048);
  block.quantizedSpectrum = spec;

  channel.rebitallocCtxId = 0;
  channel.idwl.values[band] = mode;
  channel.idct.values[band] = baseIdx;

  block.rebitallocScratch.specIndexByBand[band] = baseIdx;
  block.quantOffsetByBand[band] = quantOffset;
  block.normalizedBandPeaks[band] = scale;

  return {
    hdr,
    block,
    channel,
    blocks: [block],
    channels: [channel],
    quantizedSpectraByChannel: [spec],
    band,
  };
}

function setBandSpectrum(spec, band, values) {
  const start = AT5_ISPS[band] >>> 0;
  const count = AT5_NSPS[band] >>> 0;
  spec.set(values.slice(0, count), start);
}

test("pruneCoefficientsWithinBudget keeps the reduced spectrum when the rebitalloc delta fits", () => {
  const fixture = createCoefficientPruningFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 0,
    bitsIdct: 5,
    bitsTotal: 25,
    bitsTotalBase: 25,
  });
  setBandSpectrum(
    fixture.quantizedSpectraByChannel[0],
    fixture.band,
    [1, 0.35, 0.5, -0.2, 0.41, -0.39, 0.8, 0.1, 0.42, 0.4, 0.399, 0.401, 0.9, 0.05, -0.6, 0.2]
  );

  const total = pruneCoefficientsWithinBudget(
    fixture.hdr,
    fixture.blocks,
    fixture.quantizedSpectraByChannel,
    fixture.channels,
    1,
    1,
    22
  );

  assert.equal(total, 21);
  assert.equal(fixture.hdr.bitsTotal, 21);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.channel.idct.values[0], 3);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 3);
  assert.ok(
    Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16)).every((value) => value === 0)
  );
});

test("pruneCoefficientsWithinBudget restores spectrum and rebitalloc state when no delta improves", () => {
  const fixture = createCoefficientPruningFixture({
    band: 0,
    mode: 1,
    quantOffset: 0,
    baseIdx: 0,
    bitsIdct: 0,
    bitsTotal: 25,
    bitsTotalBase: 25,
  });
  const bandValues = [
    1, 0.35, 0.5, -0.2, 0.41, -0.39, 0.8, 0.1, 0.42, 0.4, 0.399, 0.401, 0.9, 0.05, -0.6, 0.2,
  ];
  setBandSpectrum(fixture.quantizedSpectraByChannel[0], fixture.band, bandValues);
  const originalBand = Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16));

  const total = pruneCoefficientsWithinBudget(
    fixture.hdr,
    fixture.blocks,
    fixture.quantizedSpectraByChannel,
    fixture.channels,
    1,
    1,
    20
  );

  assert.equal(total, 25);
  assert.equal(fixture.hdr.bitsTotal, 25);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.channel.idct.values[0], 0);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 0);
  assert.deepEqual(Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16)), originalBand);
});

test("pruneCoefficientsWithinBudget skips bands whose stored quant offset is already past the probe range", () => {
  const fixture = createCoefficientPruningFixture({
    band: 0,
    mode: 1,
    quantOffset: 0x3d,
    baseIdx: 0,
    bitsIdct: 0,
    bitsTotal: 25,
    bitsTotalBase: 25,
  });
  const bandValues = [
    1, 0.35, 0.5, -0.2, 0.41, -0.39, 0.8, 0.1, 0.42, 0.4, 0.399, 0.401, 0.9, 0.05, -0.6, 0.2,
  ];
  setBandSpectrum(fixture.quantizedSpectraByChannel[0], fixture.band, bandValues);
  const originalBand = Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16));

  const total = pruneCoefficientsWithinBudget(
    fixture.hdr,
    fixture.blocks,
    fixture.quantizedSpectraByChannel,
    fixture.channels,
    1,
    1,
    20
  );

  assert.equal(total, 25);
  assert.equal(fixture.hdr.bitsTotal, 25);
  assert.equal(fixture.channel.idct.values[0], 0);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 0);
  assert.deepEqual(Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16)), originalBand);
});

test("pruneCoefficientsWithinBudget restores the last accepted pruning frontier when stronger probes fail", () => {
  const fixture = createCoefficientPruningFixture({
    band: 0,
    mode: 1,
    quantOffset: 3,
    baseIdx: 0,
    bitsIdct: 6,
    bitsTotal: 25,
    bitsTotalBase: 25,
    scale: 0.2,
  });
  const bandValues = [
    0.248, 0.465, 0.006, -0.548, -1.17, -0.776, 0.966, 0.01, 0.791, 1.17, -0.028, 0.781, 0.421,
    1.139, -0.751, -0.986,
  ];
  setBandSpectrum(fixture.quantizedSpectraByChannel[0], fixture.band, bandValues);
  const originalBand = Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16));

  const total = pruneCoefficientsWithinBudget(
    fixture.hdr,
    fixture.blocks,
    fixture.quantizedSpectraByChannel,
    fixture.channels,
    1,
    1,
    12
  );

  const bandAfter = Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16));

  assert.equal(total, 18);
  assert.equal(fixture.hdr.bitsTotal, 18);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.channel.idct.values[0], 0);

  for (const index of [0, 1, 2, 3, 7, 10, 12]) {
    assert.equal(bandAfter[index], 0);
  }
  for (const index of [4, 5, 6, 8, 9, 11, 13, 14, 15]) {
    assert.equal(bandAfter[index], originalBand[index]);
  }
});

test("pruneCoefficientsWithinBudget keeps stronger probes anchored to the original band state", () => {
  const fixture = createCoefficientPruningFixture({
    band: 0,
    mode: 1,
    quantOffset: 6,
    baseIdx: 0,
    bitsIdct: 7,
    bitsTotal: 24,
    bitsTotalBase: 24,
    scale: 0.15,
  });
  setBandSpectrum(
    fixture.quantizedSpectraByChannel[0],
    fixture.band,
    [
      -0.2796013, 0.06489262, -0.21402797, 0.42967278, -0.6985356, 1.0041075, -1.3273613, 1.6475625,
      -0.1992982, 0.4485091, -0.6788157, 0.8705558, -1.0056645, 1.0685159, -1.046674, 0.09554092,
    ]
  );

  const total = pruneCoefficientsWithinBudget(
    fixture.hdr,
    fixture.blocks,
    fixture.quantizedSpectraByChannel,
    fixture.channels,
    1,
    1,
    12
  );

  assert.equal(total, 12);
  assert.equal(fixture.hdr.bitsTotal, 12);
  assert.equal(fixture.hdr.bitsIdct, 0);
  assert.equal(fixture.hdr.bitsTotalBase, 17);
  assert.equal(fixture.channel.idct.values[0], 3);
  assert.equal(fixture.block.rebitallocScratch.specIndexByBand[0], 3);
  assert.equal(fixture.block.quantOffsetByBand[0], 6);
  assert.ok(
    Array.from(fixture.quantizedSpectraByChannel[0].slice(0, 16)).every((value) => value === 0)
  );
});
