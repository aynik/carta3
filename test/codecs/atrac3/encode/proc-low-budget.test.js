import assert from "node:assert/strict";
import test from "node:test";

import {
  LOW_BUDGET_BAND_HEADER_BITS,
  estimateBandBits,
  pruneAndMeasureLowBudgetBands,
  scanLowBudgetBandPeaks,
} from "../../../../src/atrac3/proc-low-budget-scan.js";
import { refreshLowBudgetBand } from "../../../../src/atrac3/proc-low-budget.js";
import { AT3_SFB_OFFSETS } from "../../../../src/atrac3/encode-tables.js";
import {
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
} from "../../../../src/atrac3/proc-layout.js";

test("estimateBandBits preserves current higher-mode coarse costs", () => {
  const groupIdsf = new Uint32Array(256);
  groupIdsf.fill(15, 0, 8);

  assert.equal(estimateBandBits(6, 20, 0, groupIdsf), 420);
});

function createMeasureLayer({ shift, sfbLimit, spectrumValues = [] }) {
  const spectrum = new Float32Array(1024);
  for (const [index, value] of spectrumValues) {
    spectrum[index] = value;
  }

  return {
    shift,
    sfbLimit,
    referencesPrimaryShift: false,
    spectrum,
    tones: {
      blocks: Array.from({ length: 4 }, () => ({ entryCount: 0 })),
      previousBlock0EntryCount: 0,
    },
  };
}

function createRefreshInputs({
  band,
  selector,
  mode = 0,
  claimedSelector = -1,
  claimedWidth = 0,
  bandSumValue = 0,
  bandWorkValues = {},
  spectrumValues = [],
}) {
  const procWords = new Uint32Array(0x400);
  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);
  const toneClaimSelectors = new Int32Array(0x20).fill(-1);
  const toneClaimWidths = new Int32Array(0x20);
  const bandSum = new Uint32Array(0x20);
  const bandWork = new Int32Array(34);
  const groupIdsf = new Uint32Array(256);
  const spectrum = new Float32Array(1024);

  for (const [index, value] of spectrumValues) {
    spectrum[index] = value;
  }
  bandSelectors[band] = selector >>> 0;
  bandModes[band] = mode >>> 0;
  toneClaimSelectors[band] = claimedSelector;
  toneClaimWidths[band] = claimedWidth;
  bandSum[band] = bandSumValue >>> 0;
  for (const [index, value] of Object.entries(bandWorkValues)) {
    bandWork[index | 0] = value;
  }

  return {
    procWords,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32: new Uint32Array(spectrum.buffer),
  };
}

test("scanLowBudgetBandPeaks grows the mono band limit from the strongest surviving peak", () => {
  const layer = createMeasureLayer({
    shift: 200,
    sfbLimit: 8,
    spectrumValues: [[AT3_SFB_OFFSETS[10], 5000]],
  });
  const groupIdsf = new Uint32Array(256);
  const bandSum = new Uint32Array(0x20);
  const bandSelectors = new Uint32Array(0x20);

  const result = scanLowBudgetBandPeaks(layer, {
    bandLimit: 8,
    bitBudget: 400,
    usesIndependentCoding: true,
    groupIdsf,
    bandSum,
    bandSelectors,
  });

  assert.equal(result.bandLimit, 0x1c);
  assert.ok(bandSelectors[10] > 0);
  assert.ok(bandSum[10] > 0);
});

test("pruneAndMeasureLowBudgetBands drops dominated bands and reclaims trailing headers", () => {
  const procWords = new Uint32Array(0x400);
  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);
  const bandMetrics = new Int32Array(34);
  const groupIdsf = new Uint32Array(256);

  bandModes[0] = 5;
  bandModes[2] = 5;
  bandSelectors[0] = 10;
  bandSelectors[2] = 10;
  bandMetrics[2] = 0x3000;
  bandMetrics[3] = 0;

  const result = pruneAndMeasureLowBudgetBands(
    procWords,
    bandModes,
    bandSelectors,
    bandMetrics,
    groupIdsf,
    4,
    10
  );

  assert.equal(result.activeBands, 1);
  assert.equal(result.availableBits, 10 + 3 * LOW_BUDGET_BAND_HEADER_BITS);
  assert.equal(procWords[0x40] | 0, 1);
  assert.equal(bandModes[2] | 0, 0);
});

test("refreshLowBudgetBand preserves muted tone-claimed band recompute handling", () => {
  const {
    procWords,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
  } = createRefreshInputs({
    band: 8,
    selector: 26,
    claimedSelector: 26,
    claimedWidth: 0,
    bandWorkValues: { 9: 0x800 },
  });

  refreshLowBudgetBand(
    8,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
    600,
    10
  );

  assert.equal(procWords[8] | 0, 0);
  assert.equal(procWords[0x28] | 0, 0);
  assert.equal(bandWork[9] | 0, 0x900);
  assert.deepEqual(Array.from(groupIdsf.slice(16, 20)), [0, 0, 0, 0]);
});

test("refreshLowBudgetBand preserves narrow-band spend clamping after recompute", () => {
  const {
    procWords,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
  } = createRefreshInputs({
    band: 8,
    selector: 26,
    claimedSelector: 26,
    claimedWidth: 5,
    bandWorkValues: { 8: 1000, 9: 0x1900, 10: 2000 },
    spectrumValues: [[64, 0.1]],
  });

  refreshLowBudgetBand(
    8,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
    1500,
    10
  );

  assert.equal(procWords[8] | 0, 0);
  assert.equal(procWords[0x28] | 0, 6);
  assert.deepEqual(Array.from(bandWork.slice(8, 11)), [328, 1024, 656]);
  assert.deepEqual(Array.from(groupIdsf.slice(16, 20)), [6, 0, 0, 0]);
});

test("refreshLowBudgetBand preserves low-budget doubled spend on recompute", () => {
  const {
    procWords,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
  } = createRefreshInputs({
    band: 8,
    selector: 26,
    claimedSelector: 26,
    claimedWidth: 5,
    bandWorkValues: { 8: 1000, 9: 0x1900, 10: 2000 },
    spectrumValues: [[64, 0.1]],
  });

  refreshLowBudgetBand(
    8,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
    200,
    10
  );

  assert.equal(procWords[8] | 0, 0);
  assert.equal(procWords[0x28] | 0, 6);
  assert.deepEqual(Array.from(bandWork.slice(8, 11)), [-535, -5880, -1070]);
  assert.deepEqual(Array.from(groupIdsf.slice(16, 20)), [6, 0, 0, 0]);
});

test("refreshLowBudgetBand preserves positive-peak widening rules", () => {
  const first = createRefreshInputs({
    band: 16,
    selector: 26,
    mode: 5,
    bandSumValue: 100,
  });
  refreshLowBudgetBand(
    16,
    first.bandModes,
    first.bandSelectors,
    first.toneClaimSelectors,
    first.toneClaimWidths,
    first.bandSum,
    first.bandWork,
    first.groupIdsf,
    first.spectrumU32,
    600,
    11
  );
  assert.equal(first.procWords[16] | 0, 5);
  assert.equal(first.procWords[0x30] | 0, 27);

  const second = createRefreshInputs({
    band: 16,
    selector: 26,
    mode: 5,
    bandSumValue: 500,
  });
  refreshLowBudgetBand(
    16,
    second.bandModes,
    second.bandSelectors,
    second.toneClaimSelectors,
    second.toneClaimWidths,
    second.bandSum,
    second.bandWork,
    second.groupIdsf,
    second.spectrumU32,
    600,
    11
  );
  assert.equal(second.procWords[16] | 0, 5);
  assert.equal(second.procWords[0x30] | 0, 28);
});

test("refreshLowBudgetBand preserves mode-shift-10 metric bonus without widening", () => {
  const {
    procWords,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
  } = createRefreshInputs({
    band: 16,
    selector: 26,
    mode: 5,
    bandSumValue: 100,
  });

  refreshLowBudgetBand(
    16,
    bandModes,
    bandSelectors,
    toneClaimSelectors,
    toneClaimWidths,
    bandSum,
    bandWork,
    groupIdsf,
    spectrumU32,
    600,
    10
  );

  assert.equal(procWords[16] | 0, 5);
  assert.equal(procWords[0x30] | 0, 26);
  assert.equal(bandWork[17] | 0, 0x100);
});
