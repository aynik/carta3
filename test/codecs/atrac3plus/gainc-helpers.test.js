import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32,
  AT5_GAINC_BANDS_MAX,
  applyStereoCorrelationAdjustmentAt5,
  prepareGaincScaleWindowsAt5,
} from "../../../src/atrac3plus/gainc/helpers.js";
import { getGaincBandHistory } from "../../../src/atrac3plus/gainc/history.js";
import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/buf.js";

const WINDOW_HISTORY_VALUES = 64;
const SPECTRUM_COUNT = 0x80;

function createGaincRuntimeBlock() {
  return {
    pointGroupCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    disabledPointCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    gainLevelBoundsHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    peakIndexHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    peakValueHistory: new Float32Array(AT5_GAINC_BANDS_MAX * 2),
    windowAbsHistory: new Float32Array(AT5_GAINC_BANDS_MAX * WINDOW_HISTORY_VALUES),
    windowScaleHistory: new Float32Array(AT5_GAINC_BANDS_MAX * WINDOW_HISTORY_VALUES),
    trailingWindowPeakHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
    duplicatePointCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX),
    gainPointHistoryBytes: new Uint8Array(0x18000),
    stereoBandEnergyHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
    stereoBandEnergyRatioHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
  };
}

function setSingleGainPoint(record, location, level) {
  record.entries = 1;
  record.locations[0] = location;
  record.levels[0] = level;
}

function createSpectrum(fillCount = SPECTRUM_COUNT) {
  const spectrum = new Float32Array(AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32 + SPECTRUM_COUNT);
  for (let i = 0; i < fillCount; i += 1) {
    spectrum[AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32 + i] = 1;
  }
  return spectrum;
}

function assertAlmostEqual(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("prepareGaincScaleWindowsAt5 keeps the first scales active when recent time windows are nonzero", () => {
  const analysis = new Float32Array(64);
  const newAbs = new Float32Array(2);
  const scaleFactors = new Float32Array(3);

  for (let i = 0; i < 16; i += 1) {
    analysis[i] = i % 4 === 0 ? 1 : 0;
  }

  const result = prepareGaincScaleWindowsAt5({
    analysis,
    newAbs,
    scaleFactors,
    windowBlocks: 2,
    analysisAbsOffsetF32: 32,
    analysisTimewinOffsetF32: 0,
    windowF32PerBlock: 4,
  });

  assert.equal(result.maxAbsIdx, 0);
  assert.equal(result.maxAbsVal, 0);
  assert.deepEqual(Array.from(newAbs), [0, 0]);
  assertAlmostEqual(scaleFactors[1], 1.435490369796753);
  assertAlmostEqual(scaleFactors[2], 1.1072537899017334);
});

test("applyStereoCorrelationAdjustmentAt5 mirrors the preferred channel when the stereo ratio stays stable", () => {
  const band = 6;
  const channelBlocks = [createGaincRuntimeBlock(), createGaincRuntimeBlock()];
  const curBufs = [createAt5EncodeBufBlock(), createAt5EncodeBufBlock()];
  const leftHistory = getGaincBandHistory(channelBlocks[0], band);
  const rightHistory = getGaincBandHistory(channelBlocks[1], band);
  const analysisPtrs = new Array(AT5_GAINC_BANDS_MAX * 2).fill(null);
  const auxU32 = new Uint32Array(0xf1 + AT5_GAINC_BANDS_MAX);

  assert.ok(leftHistory);
  assert.ok(rightHistory);
  if (!(leftHistory && rightHistory)) {
    return;
  }

  leftHistory.stereoBandEnergy = 4;
  rightHistory.stereoBandEnergy = 4;
  leftHistory.stereoBandEnergyRatio = 1;
  leftHistory.gainLevelBounds.set([3, 5]);
  rightHistory.gainLevelBounds.set([7, 9]);

  setSingleGainPoint(curBufs[0].records[band], 2, 8);
  setSingleGainPoint(curBufs[1].records[band], 5, 11);

  analysisPtrs[band] = createSpectrum();
  analysisPtrs[AT5_GAINC_BANDS_MAX + band] = createSpectrum();
  auxU32[0xf1 + band] = 1;

  applyStereoCorrelationAdjustmentAt5({
    band,
    channels: 2,
    corrStartBand: 6,
    channelBlocks,
    analysisPtrs,
    curBufs,
    auxU32,
    spectrumCount: SPECTRUM_COUNT,
    analysisFreqOffsetF32: AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32,
    bandsMax: AT5_GAINC_BANDS_MAX,
  });

  assert.equal(curBufs[0].records[band].entries, 1);
  assert.equal(curBufs[0].records[band].locations[0], 5);
  assert.equal(curBufs[0].records[band].levels[0], 11);
  assert.equal(curBufs[1].records[band].locations[0], 5);
  assert.equal(curBufs[1].records[band].levels[0], 11);
  assert.deepEqual(Array.from(leftHistory.gainLevelBounds), [7, 9]);
  assertAlmostEqual(leftHistory.stereoBandEnergyRatio, 1);
  assert.equal(leftHistory.stereoBandEnergy, SPECTRUM_COUNT);
  assert.equal(rightHistory.stereoBandEnergy, SPECTRUM_COUNT);
});

test("applyStereoCorrelationAdjustmentAt5 leaves records untouched when the new stereo ratio falls outside the mirror range", () => {
  const band = 6;
  const channelBlocks = [createGaincRuntimeBlock(), createGaincRuntimeBlock()];
  const curBufs = [createAt5EncodeBufBlock(), createAt5EncodeBufBlock()];
  const leftHistory = getGaincBandHistory(channelBlocks[0], band);
  const rightHistory = getGaincBandHistory(channelBlocks[1], band);
  const analysisPtrs = new Array(AT5_GAINC_BANDS_MAX * 2).fill(null);
  const auxU32 = new Uint32Array(0xf1 + AT5_GAINC_BANDS_MAX);

  assert.ok(leftHistory);
  assert.ok(rightHistory);
  if (!(leftHistory && rightHistory)) {
    return;
  }

  leftHistory.stereoBandEnergy = 1;
  rightHistory.stereoBandEnergy = 1;
  leftHistory.stereoBandEnergyRatio = 1;
  leftHistory.gainLevelBounds.set([3, 5]);
  rightHistory.gainLevelBounds.set([7, 9]);

  setSingleGainPoint(curBufs[0].records[band], 2, 8);
  setSingleGainPoint(curBufs[1].records[band], 5, 11);

  analysisPtrs[band] = createSpectrum();
  analysisPtrs[AT5_GAINC_BANDS_MAX + band] = createSpectrum(32);
  auxU32[0xf1 + band] = 1;

  applyStereoCorrelationAdjustmentAt5({
    band,
    channels: 2,
    corrStartBand: 6,
    channelBlocks,
    analysisPtrs,
    curBufs,
    auxU32,
    spectrumCount: SPECTRUM_COUNT,
    analysisFreqOffsetF32: AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32,
    bandsMax: AT5_GAINC_BANDS_MAX,
  });

  assert.equal(curBufs[0].records[band].locations[0], 2);
  assert.equal(curBufs[0].records[band].levels[0], 8);
  assert.equal(curBufs[1].records[band].locations[0], 5);
  assert.equal(curBufs[1].records[band].levels[0], 11);
  assert.deepEqual(Array.from(leftHistory.gainLevelBounds), [3, 5]);
  assertAlmostEqual(leftHistory.stereoBandEnergyRatio, 4);
  assert.equal(leftHistory.stereoBandEnergy, SPECTRUM_COUNT);
  assert.equal(rightHistory.stereoBandEnergy, 32);
});
