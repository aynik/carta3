import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_WIND0,
  AT5_WIND1,
  AT5_WIND2,
  AT5_WIND3,
} from "../../../src/atrac3plus/tables/decode.js";
import { at5T2fMdctOutputs, at5T2fSelectWindow } from "../../../src/atrac3plus/time2freq/index.js";
import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/internal.js";

const MDCT_BAND_SAMPLES = 128;
const TIME_SAMPLES = 256;

function createAnalysisBand(seed) {
  const band = new Float32Array(TIME_SAMPLES);
  for (let i = 0; i < TIME_SAMPLES; i += 1) {
    band[i] = Math.sin(((i + 1) * (seed + 1)) / 17) + i / TIME_SAMPLES;
  }
  return band;
}

function bandSlice(spec, band) {
  const start = band * MDCT_BAND_SAMPLES;
  return spec.subarray(start, start + MDCT_BAND_SAMPLES);
}

function sumAbsDiff(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += Math.abs(a[i] - b[i]);
  }
  return total;
}

test("at5T2fSelectWindow maps the four tlev-flag combinations to the codec windows", () => {
  assert.equal(at5T2fSelectWindow({ tlevFlag: 0 }, { tlevFlag: 0 }), AT5_WIND0);
  assert.equal(at5T2fSelectWindow({ tlevFlag: 0 }, { tlevFlag: 1 }), AT5_WIND1);
  assert.equal(at5T2fSelectWindow({ tlevFlag: 1 }, { tlevFlag: 0 }), AT5_WIND2);
  assert.equal(at5T2fSelectWindow({ tlevFlag: 1 }, { tlevFlag: 1 }), AT5_WIND3);
});

test("at5T2fMdctOutputs keeps inactive secondary bands identical to the primary pass", () => {
  const prevBufs = [createAt5EncodeBufBlock()];
  const curBufs = [createAt5EncodeBufBlock()];
  const analysisRows = Array.from({ length: 6 }, (_, band) => createAnalysisBand(band));
  const quantizedSpectraByChannel = [new Float32Array(6 * MDCT_BAND_SAMPLES)];
  const bitallocSpectraByChannel = [new Float32Array(6 * MDCT_BAND_SAMPLES)];

  at5T2fMdctOutputs(
    prevBufs,
    curBufs,
    analysisRows,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
    1,
    6,
    2,
    {}
  );

  for (let band = 0; band < 6; band += 1) {
    assert.deepEqual(
      Array.from(bandSlice(quantizedSpectraByChannel[0], band)),
      Array.from(bandSlice(bitallocSpectraByChannel[0], band))
    );
  }
});

test("at5T2fMdctOutputs leaves the secondary pass unscaled when a gain window is active", () => {
  const prevBufs = [createAt5EncodeBufBlock()];
  const curBufs = [createAt5EncodeBufBlock()];
  const analysisRows = [createAnalysisBand(0), createAnalysisBand(1)];
  const quantizedSpectraByChannel = [new Float32Array(2 * MDCT_BAND_SAMPLES)];
  const bitallocSpectraByChannel = [new Float32Array(2 * MDCT_BAND_SAMPLES)];

  curBufs[0].records[0].entries = 1;
  curBufs[0].records[0].locations[0] = 0;
  curBufs[0].records[0].levels[0] = 7;

  at5T2fMdctOutputs(
    prevBufs,
    curBufs,
    analysisRows,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
    1,
    2,
    0,
    {}
  );

  assert.ok(
    sumAbsDiff(
      bandSlice(quantizedSpectraByChannel[0], 0),
      bandSlice(bitallocSpectraByChannel[0], 0)
    ) > 1
  );
  assert.deepEqual(
    Array.from(bandSlice(quantizedSpectraByChannel[0], 1)),
    Array.from(bandSlice(bitallocSpectraByChannel[0], 1))
  );
});
