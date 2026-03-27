import assert from "node:assert/strict";
import test from "node:test";

import { AT5_GAINC_BANDS_MAX } from "../../../src/atrac3plus/gainc/helpers.js";
import { getGaincBandHistory } from "../../../src/atrac3plus/gainc/history.js";

const WINDOW_HISTORY_VALUES = 64;

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

test("getGaincBandHistory exposes live band-scoped runtime views", () => {
  const band = 3;
  const pairOffset = band * 2;
  const windowOffset = band * WINDOW_HISTORY_VALUES;
  const block = createGaincRuntimeBlock();

  block.pointGroupCountHistory.set([11, 12], pairOffset);
  block.disabledPointCountHistory.set([21, 22], pairOffset);
  block.gainLevelBoundsHistory.set([31, 32], pairOffset);
  block.peakIndexHistory.set([41, 42], pairOffset);
  block.peakValueHistory.set([51.5, 52.5], pairOffset);
  for (let i = 0; i < WINDOW_HISTORY_VALUES; i += 1) {
    block.windowAbsHistory[windowOffset + i] = 100 + i;
    block.windowScaleHistory[windowOffset + i] = 200 + i;
  }
  block.trailingWindowPeakHistory[band] = 61.5;
  block.duplicatePointCountHistory[band] = 7;
  block.stereoBandEnergyHistory[band] = 71.5;
  block.stereoBandEnergyRatioHistory[band] = 0.75;

  const bandHistory = getGaincBandHistory(block, band);
  assert.ok(bandHistory);
  if (!bandHistory) {
    return;
  }

  assert.deepEqual(Array.from(bandHistory.pointGroupCounts), [11, 12]);
  assert.deepEqual(Array.from(bandHistory.disabledPointCounts), [21, 22]);
  assert.deepEqual(Array.from(bandHistory.gainLevelBounds), [31, 32]);
  assert.deepEqual(Array.from(bandHistory.peakIndices), [41, 42]);
  assert.deepEqual(Array.from(bandHistory.peakValues), [51.5, 52.5]);
  assert.deepEqual(Array.from(bandHistory.windowAbs.slice(0, 4)), [100, 101, 102, 103]);
  assert.deepEqual(Array.from(bandHistory.windowScale.slice(60, 64)), [260, 261, 262, 263]);
  assert.equal(bandHistory.trailingWindowPeak, 61.5);
  assert.equal(bandHistory.duplicatePointCount, 7);
  assert.equal(bandHistory.stereoBandEnergy, 71.5);
  assert.equal(bandHistory.stereoBandEnergyRatio, 0.75);
  assert.equal(bandHistory.gainPointHistoryBytes, block.gainPointHistoryBytes);

  bandHistory.pointGroupCounts[0] = 91;
  bandHistory.disabledPointCounts[1] = 92;
  bandHistory.gainLevelBounds[0] = 93;
  bandHistory.peakIndices[1] = 94;
  bandHistory.peakValues[0] = 95.5;
  bandHistory.windowAbs[0] = 96.5;
  bandHistory.windowScale[63] = 97.5;
  bandHistory.trailingWindowPeak = 98.5;
  bandHistory.duplicatePointCount = 99;
  bandHistory.stereoBandEnergy = 100.5;
  bandHistory.stereoBandEnergyRatio = 1.25;

  assert.equal(block.pointGroupCountHistory[pairOffset], 91);
  assert.equal(block.disabledPointCountHistory[pairOffset + 1], 92);
  assert.equal(block.gainLevelBoundsHistory[pairOffset], 93);
  assert.equal(block.peakIndexHistory[pairOffset + 1], 94);
  assert.equal(block.peakValueHistory[pairOffset], 95.5);
  assert.equal(block.windowAbsHistory[windowOffset], 96.5);
  assert.equal(block.windowScaleHistory[windowOffset + 63], 97.5);
  assert.equal(block.trailingWindowPeakHistory[band], 98.5);
  assert.equal(block.duplicatePointCountHistory[band], 99);
  assert.equal(block.stereoBandEnergyHistory[band], 100.5);
  assert.equal(block.stereoBandEnergyRatioHistory[band], 1.25);
});

test("getGaincBandHistory rejects incomplete runtime history layouts", () => {
  const block = createGaincRuntimeBlock();
  block.windowScaleHistory = new Float32Array(32);

  assert.equal(getGaincBandHistory(block, 1), null);
});

test("getGaincBandHistory rejects undersized per-band scalar histories", () => {
  const block = createGaincRuntimeBlock();
  block.stereoBandEnergyHistory = new Float32Array(1);

  assert.equal(getGaincBandHistory(block, 1), null);
});
