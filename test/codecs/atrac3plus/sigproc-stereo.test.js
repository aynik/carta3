import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_MAX_CHANNELS,
  AT5_SIGPROC_SLOTS,
  createAt5SigprocAux,
  at5SigprocApplyIntensityStereo,
  at5SigprocUpdateDbDiff,
} from "../../../src/atrac3plus/sigproc/internal.js";

function assertAlmostEqual(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function bandPtrIndex(slot, channel, band) {
  return slot * (AT5_SIGPROC_MAX_CHANNELS * AT5_SIGPROC_BANDS_MAX) + channel * 16 + band;
}

function createBandPtrTable() {
  return new Array(AT5_SIGPROC_SLOTS * AT5_SIGPROC_MAX_CHANNELS * AT5_SIGPROC_BANDS_MAX).fill(null);
}

function setBandPtr(table, slot, channel, band, samples) {
  table[bandPtrIndex(slot, channel, band)] = samples;
}

test("at5SigprocUpdateDbDiff preserves the current silent, unilateral, and partial-difference ratios", () => {
  const aux = createAt5SigprocAux();
  const bandPtrs = createBandPtrTable();
  const left = new Float32Array(256).fill(1);

  setBandPtr(bandPtrs, 6, 0, 0, left);
  setBandPtr(bandPtrs, 6, 1, 0, new Float32Array(256).fill(1));
  setBandPtr(bandPtrs, 6, 0, 1, left);
  setBandPtr(bandPtrs, 6, 1, 1, new Float32Array(256));
  setBandPtr(bandPtrs, 6, 0, 2, left);
  setBandPtr(bandPtrs, 6, 1, 2, new Float32Array(256).fill(0.5));

  at5SigprocUpdateDbDiff(aux, bandPtrs);

  assertAlmostEqual(aux.dbDiff[0], 59.999996185302734);
  assertAlmostEqual(aux.dbDiff[1], 0);
  assertAlmostEqual(aux.dbDiff[2], 12.041199684143066);
  assert.equal(aux.dbDiff[3], 0);
});

test("at5SigprocApplyIntensityStereo keeps the codec intensity boundary, mix history, and scale reconstruction aligned", () => {
  const aux = createAt5SigprocAux();
  const bandPtrs = createBandPtrTable();
  const band = 4;

  const left6 = new Float32Array(256).fill(1);
  const right6 = new Float32Array(256).fill(0.5);
  const left7 = new Float32Array(256).fill(1);
  const right7 = new Float32Array(256).fill(0.95);

  setBandPtr(bandPtrs, 6, 0, band, left6);
  setBandPtr(bandPtrs, 6, 1, band, right6);
  setBandPtr(bandPtrs, 7, 0, band, left7);
  setBandPtr(bandPtrs, 7, 1, band, right7);

  aux.dbDiff[band] = 0;

  at5SigprocApplyIntensityStereo(aux, { sampleRateHz: 44100 }, bandPtrs, 15, 2);

  assert.equal(aux.intensityBand[0], 4);
  assertAlmostEqual(aux.mixHist[3 * AT5_SIGPROC_BANDS_MAX + band], 0.125);
  assertAlmostEqual(aux.mixHist[4 * AT5_SIGPROC_BANDS_MAX + band], 0.125);
  assert.equal(left7[10], 1);
  assert.equal(right7[10], 0.949999988079071);
  assertAlmostEqual(left7[100], 0.9988574981689453);
  assertAlmostEqual(right7[100], 0.9511424899101257);
  assertAlmostEqual(aux.scaleCur[band], 0.3333333432674408);
  assertAlmostEqual(aux.scaleCur[AT5_SIGPROC_BANDS_MAX + band], 0.1666666716337204);
});
