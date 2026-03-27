import assert from "node:assert/strict";
import test from "node:test";

import { fillAt3ProcWordsLowBudget } from "../../../../src/atrac3/proc-words.js";
import { finalizeLowBudgetBandPayload } from "../../../../src/atrac3/proc-payload-fit.js";
import {
  countbitsNontoneSpecsGeneric,
  planLowBudgetBandPayloads,
} from "../../../../src/atrac3/proc-payload-plan.js";
import { at3ClassScaleByMode } from "../../../../src/atrac3/proc-quant-modes.js";
import { at3BandScaleFromMode } from "../../../../src/atrac3/proc-quant-scale.js";
import {
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
} from "../../../../src/atrac3/proc-layout.js";
import { AT3_SFB_OFFSETS, AT3_SFB_WIDTHS } from "../../../../src/atrac3/encode-tables.js";

test("countbitsNontoneSpecsGeneric preserves grouped and scalar mode costs", () => {
  const spectrum = new Float32Array(32);

  spectrum.set([1.25, -0.75, 0.5, -0.25, 1.5, -1.25, 0.75, -0.5], 0);
  assert.equal(countbitsNontoneSpecsGeneric(1, 20, 8, spectrum, 0), 17);

  spectrum.set([0.9, -1.1, 2.4, -2.7, 1.6, -1.8, 0.3, -0.4], 8);
  assert.equal(countbitsNontoneSpecsGeneric(3, 18, 8, spectrum, 8), 33);

  spectrum.set([0.2, -0.3, 3.8, -4.1, 5.2, -5.5, 1.1, -1.4], 16);
  assert.equal(countbitsNontoneSpecsGeneric(7, 14, 8, spectrum, 16), 62);
});

test("ATRAC3 quant mode descriptors preserve current higher-mode costs", () => {
  const spectrum = new Float32Array(32);
  spectrum.set([0.5, -0.75, 1.25, -1.5, 2.0, -2.25, 0.125, -0.25], 0);

  assert.equal(countbitsNontoneSpecsGeneric(6, 16, 8, spectrum, 0), 47);
});

test("ATRAC3 proc scale helpers preserve the shared band and tone scale model", () => {
  assert.equal(at3BandScaleFromMode(1, 20), 0.47247040271759033);
  assert.equal(at3BandScaleFromMode(3, 18), 1.75);
  assert.equal(at3BandScaleFromMode(7, 12), 63);
});

test("ATRAC3 quant mode descriptors preserve authored class-scale clamping", () => {
  assert.deepEqual(
    Array.from({ length: 9 }, (_, mode) => at3ClassScaleByMode(mode)),
    [0, 1, 2, 2, 2, 4, 6, 6, 6]
  );
});

function createPairBlock() {
  return { entryCount: 0 };
}

function createLayer({ shift, sfbLimit, referencesPrimaryShift = false, spectrumValues = [] }) {
  const spectrum = new Float32Array(1024);
  for (const [index, value] of spectrumValues) {
    spectrum[index] = value;
  }

  return {
    shift,
    sfbLimit,
    referencesPrimaryShift,
    spectrum,
    tones: {
      blocks: Array.from({ length: 4 }, () => createPairBlock()),
      previousBlock0EntryCount: 0,
    },
  };
}

function runCase({ layer, chconvPrevOutput = 0 }) {
  const procWords = new Uint32Array(0x400);
  const debug = {};
  const bitsUsed = fillAt3ProcWordsLowBudget(
    layer,
    { channelConversion: { mixCode: { previous: chconvPrevOutput } } },
    procWords,
    debug
  );
  return { bitsUsed, procWords, debug };
}

function createFinalizeInputs({
  activeBands,
  totalAvailable,
  bitBudget = totalAvailable,
  usesIndependentCoding = false,
  previousBlock0ToneCount = 0,
  block0ToneCount = 0,
  spectrumFill = 0,
  bandModes: initialBandModes = {},
  priorityValues = {},
  scaleSelectors = {},
  bandBits = {},
}) {
  const procWords = new Uint32Array(0x400);
  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);
  const spectrum = new Float32Array(1024).fill(spectrumFill);
  const bandPlans = [];

  procWords[0x40] = activeBands >>> 0;
  for (const [band, mode] of Object.entries(initialBandModes)) {
    bandModes[band | 0] = mode >>> 0;
  }
  for (const [band, scaleSel] of Object.entries(scaleSelectors)) {
    bandSelectors[band | 0] = scaleSel >>> 0;
  }
  for (const [band, value] of Object.entries(bandBits)) {
    const bandIndex = band | 0;
    const mode = bandModes[bandIndex] | 0;
    const bandWidth = AT3_SFB_WIDTHS[bandIndex] | 0;
    bandPlans.push({
      band: bandIndex,
      mode,
      scaleSel: bandSelectors[bandIndex] | 0,
      bandWidth,
      spectrumStart: AT3_SFB_OFFSETS[bandIndex] | 0,
      bits: value | 0,
      modeFloorBits: ((bandWidth >> 1) * at3ClassScaleByMode(mode) + 6) | 0,
      priority: priorityValues[band] ?? 0,
    });
  }

  return {
    procWords,
    bandModes,
    bandSelectors,
    bandPlans,
    plannedBits: bandPlans.reduce((sum, plan) => sum + plan.bits, 0),
    activeBands,
    totalAvailable,
    spectrum,
    usesIndependentCoding,
    previousBlock0ToneCount,
    block0ToneCount,
    bitBudget,
  };
}

function assertLeadingWords(procWords, { header, bands, selectors }) {
  assert.deepEqual(
    Array.from(procWords.slice(0x40, 0x44)),
    header,
    "header words should stay stable"
  );
  assert.deepEqual(Array.from(procWords.slice(0, 12)), bands, "band modes should stay stable");
  assert.deepEqual(
    Array.from(procWords.slice(0x20, 0x20 + 12)),
    selectors,
    "band selectors should stay stable"
  );
}

test("planLowBudgetBandPayloads preserves overspend selector widening on silent low bands", () => {
  const bandModes = new Uint32Array(32);
  const bandSelectors = new Uint32Array(32);
  const bandMetrics = new Int32Array(34);
  const groupIdsf = new Uint32Array(256);
  const spectrum = new Float32Array(1024);

  bandModes[0] = 3;
  bandModes[1] = 4;
  bandSelectors[0] = 10;
  bandSelectors[1] = 20;
  bandMetrics[1] = -200;
  bandMetrics[2] = -300;

  const result = planLowBudgetBandPayloads({
    bandModes,
    bandSelectors,
    bandMetrics,
    groupIdsf,
    estimatedBits: 500,
    activeWidth: 50,
    mode7Width: 0,
    activeBands: 2,
    totalAvailable: 10,
    modeShift: 10,
    spectrum,
    captureDebug: true,
  });

  assert.deepEqual(Array.from(bandModes.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(bandSelectors.slice(0, 4)), [11, 21, 1, 1]);
  assert.equal(result.remaining10, -100);
  assert.equal(result.plannedBits, 0);
  assert.deepEqual(result.bandPlans, []);
  assert.deepEqual(Array.from(result.prioritySnapshot.slice(0, 4)), [-1, -1, 0, 0]);
});

test("planLowBudgetBandPayloads preserves promotion of a surviving high-headroom band", () => {
  const bandModes = new Uint32Array(32);
  const bandSelectors = new Uint32Array(32);
  const bandMetrics = new Int32Array(34);
  const groupIdsf = new Uint32Array(256);
  const spectrum = new Float32Array(1024);

  spectrum[0] = 1000;
  spectrum[1] = -800;
  bandModes[0] = 3;
  bandSelectors[0] = 20;
  bandMetrics[1] = 5000;

  const result = planLowBudgetBandPayloads({
    bandModes,
    bandSelectors,
    bandMetrics,
    groupIdsf,
    estimatedBits: 20,
    activeWidth: 8,
    mode7Width: 0,
    activeBands: 1,
    totalAvailable: 100,
    modeShift: 10,
    spectrum,
    captureDebug: true,
  });

  assert.deepEqual(Array.from(bandModes.slice(0, 2)), [7, 0]);
  assert.deepEqual(Array.from(bandSelectors.slice(0, 2)), [20, 0]);
  assert.equal(result.remaining10, 700);
  assert.equal(result.plannedBits, 34);
  assert.deepEqual(
    result.bandPlans.map(({ band, mode, scaleSel, bits, priority }) => ({
      band,
      mode,
      scaleSel,
      bits,
      priority,
    })),
    [{ band: 0, mode: 7, scaleSel: 20, bits: 34, priority: 20 }]
  );
  assert.deepEqual(Array.from(result.bitCountSnapshot.slice(0, 3)), [0, 34, 0]);
});

test("fillAt3ProcWordsLowBudget preserves current silent mono budgeting", () => {
  const { bitsUsed, procWords, debug } = runCase({
    layer: createLayer({ shift: 200, sfbLimit: 8 }),
  });

  assert.equal(bitsUsed, 28);
  assertLeadingWords(procWords, {
    header: [1, 1, 1, 2],
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    selectors: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  assert.deepEqual(debug.commonEntry, {
    bandLimit: 8,
    bitBudget: 200,
    modeShift: 10,
    availableBits: 151,
    bands: Array.from(procWords.slice(0, 0x20)),
    selectors: Array.from(procWords.slice(0x20, 0x40)),
    bandWork: debug.commonEntry.bandWork,
  });
  assert.equal(debug.afterRemaining.remaining10, 1720);
  assert.equal(debug.afterCountbits.bitsUsed, 0);
  assert.equal(debug.afterCountbits.totalAvailable, 172);
  assert.deepEqual(
    debug.afterCountbits.selectKey.slice(0, 12),
    [-1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("fillAt3ProcWordsLowBudget preserves current low-budget mono spike handling", () => {
  const { bitsUsed, procWords, debug } = runCase({
    layer: createLayer({
      shift: 200,
      sfbLimit: 8,
      spectrumValues: [
        [0, 1000],
        [1, -800],
        [64, 500],
        [65, -400],
      ],
    }),
  });

  assert.equal(bitsUsed, 191);
  assertLeadingWords(procWords, {
    header: [9, 1, 1, 2],
    bands: [7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0],
    selectors: [26, 0, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0],
  });
  assert.equal(debug.commonEntry.bandLimit, 28);
  assert.equal(debug.commonEntry.modeShift, 10);
  assert.equal(debug.commonEntry.availableBits, 37);
  assert.deepEqual(debug.commonEntry.bands.slice(0, 12), [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(debug.afterRemaining.remaining10, 0);
  assert.equal(debug.afterCountbits.bitsUsed, 94);
  assert.equal(debug.afterCountbits.totalAvailable, 104);
  assert.deepEqual(debug.afterCountbits.bands.slice(0, 12), [7, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0]);
  assert.deepEqual(
    debug.afterCountbits.selectKey.slice(0, 12),
    [26, -1, -1, -1, -1, -1, -1, -1, 42, 0, 0, 0]
  );
});

test("fillAt3ProcWordsLowBudget preserves current high-budget mono spike handling", () => {
  const { bitsUsed, procWords, debug } = runCase({
    layer: createLayer({
      shift: 1500,
      sfbLimit: 8,
      spectrumValues: [
        [0, 1000],
        [1, -800],
        [64, 500],
        [65, -400],
      ],
    }),
  });

  assert.equal(bitsUsed, 300);
  assertLeadingWords(procWords, {
    header: [9, 1, 1, 2],
    bands: [7, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0],
    selectors: [14, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0],
  });
  assert.equal(debug.commonEntry.bandLimit, 28);
  assert.equal(debug.commonEntry.modeShift, 10);
  assert.equal(debug.commonEntry.availableBits, 1233);
  assert.equal(debug.afterRemaining.remaining10, 11560);
  assert.equal(debug.afterCountbits.bitsUsed, 100);
  assert.equal(debug.afterCountbits.totalAvailable, 1300);
  assert.deepEqual(
    debug.afterCountbits.selectKey.slice(0, 12),
    [14, -1, -1, -1, -1, -1, -1, -1, 11, 0, 0, 0]
  );
});

test("fillAt3ProcWordsLowBudget preserves current converted-layer budgeting", () => {
  const { bitsUsed, procWords, debug } = runCase({
    layer: createLayer({
      shift: 300,
      sfbLimit: 8,
      referencesPrimaryShift: true,
      spectrumValues: [
        [0, 1000],
        [1, -800],
        [64, 500],
        [65, -400],
      ],
    }),
    chconvPrevOutput: 7,
  });

  assert.equal(bitsUsed, 154);
  assertLeadingWords(procWords, {
    header: [1, 1, 1, 2],
    bands: [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    selectors: [14, 0, 0, 0, 0, 0, 0, 0, 42, 0, 0, 0],
  });
  assert.equal(debug.commonEntry.bandLimit, 8);
  assert.equal(debug.commonEntry.modeShift, 10);
  assert.equal(debug.commonEntry.availableBits, 163);
  assert.equal(debug.afterRemaining.remaining10, 1340);
  assert.equal(debug.afterCountbits.bitsUsed, 38);
  assert.equal(debug.afterCountbits.totalAvailable, 184);
  assert.deepEqual(
    debug.afterCountbits.selectKey.slice(0, 12),
    [14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("fillAt3ProcWordsLowBudget trims converted trailing units only after the compatible mix rollover", () => {
  const layer = createLayer({
    shift: 200,
    sfbLimit: 28,
    referencesPrimaryShift: true,
  });

  const beforeRollover = runCase({ layer, chconvPrevOutput: 0 }).procWords;
  const afterRollover = runCase({ layer, chconvPrevOutput: 7 }).procWords;

  assert.deepEqual(Array.from(beforeRollover.slice(0x40, 0x44)), [1, 3, 1, 2]);
  assert.deepEqual(Array.from(afterRollover.slice(0x40, 0x44)), [1, 1, 1, 2]);
});

test("fillAt3ProcWordsLowBudget preserves current dense mono fitting", () => {
  const spectrumValues = Array.from({ length: 96 }, (_, index) => [index, Math.sin(index) * 100]);
  const { bitsUsed, procWords, debug } = runCase({
    layer: createLayer({
      shift: 600,
      sfbLimit: 12,
      spectrumValues,
    }),
  });

  assert.equal(bitsUsed, 596);
  assertLeadingWords(procWords, {
    header: [10, 1, 0, 0],
    bands: [7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0, 0],
    selectors: [35, 35, 35, 35, 35, 35, 35, 35, 35, 41, 1, 1],
  });
  assert.equal(debug.commonEntry.bandLimit, 28);
  assert.equal(debug.commonEntry.modeShift, 10);
  assert.equal(debug.commonEntry.availableBits, 507);
  assert.equal(debug.afterRemaining.remaining10, -210);
  assert.equal(debug.afterCountbits.bitsUsed, 588);
  assert.equal(debug.afterCountbits.totalAvailable, 567);
  assert.deepEqual(
    debug.afterCountbits.selectKey.slice(0, 12),
    [35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 0, 0]
  );
});

test("finalizeLowBudgetBandPayload preserves mono tone-priority ordering", () => {
  const state = createFinalizeInputs({
    activeBands: 6,
    totalAvailable: 30,
    usesIndependentCoding: true,
    previousBlock0ToneCount: 1,
    bandModes: { 0: 7, 5: 7 },
    priorityValues: { 0: 1, 5: 50 },
    bandBits: { 0: 30, 5: 30 },
  });

  const usedBits = finalizeLowBudgetBandPayload(state);

  assert.equal(usedBits, 30);
  assert.equal(state.procWords[0] | 0, 7);
  assert.equal(state.procWords[5] | 0, 0);
});

test("finalizeLowBudgetBandPayload preserves trailing-band trim to recover budget", () => {
  const state = createFinalizeInputs({
    activeBands: 3,
    totalAvailable: 20,
    bitBudget: 23,
    bandModes: { 0: 5, 1: 1 },
    scaleSelectors: { 0: 1 },
    priorityValues: { 0: 5 },
    bandBits: { 0: 22 },
  });

  const usedBits = finalizeLowBudgetBandPayload(state);

  assert.equal(usedBits, 22);
  assert.equal(state.procWords[0] | 0, 5);
  assert.equal(state.procWords[1] | 0, 1);
  assert.equal(state.procWords[0x20] | 0, 1);
  assert.equal(state.procWords[0x40] | 0, 2);
});

test("finalizeLowBudgetBandPayload preserves selector widening to fit overflowing bands", () => {
  const state = createFinalizeInputs({
    activeBands: 1,
    totalAvailable: 25,
    bandModes: { 0: 5 },
    priorityValues: { 0: 10 },
    bandBits: { 0: 38 },
    spectrumFill: 0.01,
  });

  const usedBits = finalizeLowBudgetBandPayload(state);

  assert.equal(usedBits, 22);
  assert.equal(state.procWords[0] | 0, 5);
  assert.equal(state.procWords[0x20] | 0, 7);
});

test("finalizeLowBudgetBandPayload keeps committed tail bands locked during later reclaim", () => {
  const state = createFinalizeInputs({
    activeBands: 2,
    totalAvailable: 30,
    bandModes: { 0: 7, 1: 7 },
    scaleSelectors: { 0: 0x3f, 1: 0 },
    priorityValues: { 0: 5, 1: 10 },
    bandBits: { 0: 20, 1: 20 },
  });

  const usedBits = finalizeLowBudgetBandPayload(state);

  assert.equal(usedBits, 20);
  assert.equal(state.procWords[0] | 0, 0);
  assert.equal(state.procWords[1] | 0, 7);
  assert.equal(state.procWords[0x20] | 0, 0x40);
  assert.equal(state.procWords[0x40] | 0, 2);
});

test("finalizeLowBudgetBandPayload preserves two-step mode upgrades when slack allows", () => {
  const state = createFinalizeInputs({
    activeBands: 1,
    totalAvailable: 60,
    bandModes: { 0: 5 },
    scaleSelectors: { 0: 1 },
    priorityValues: { 0: 10 },
    bandBits: { 0: 22 },
  });

  const usedBits = finalizeLowBudgetBandPayload(state);

  assert.equal(usedBits, 30);
  assert.equal(state.procWords[0] | 0, 7);
  assert.equal(state.procWords[0x20] | 0, 1);
});

test("finalizeLowBudgetBandPayload preserves first-band tie ordering", () => {
  const state = createFinalizeInputs({
    activeBands: 2,
    totalAvailable: 30,
    bandModes: { 0: 7, 1: 7 },
    scaleSelectors: { 0: 0x3f, 1: 0x3f },
    priorityValues: { 0: 10, 1: 10 },
    bandBits: { 0: 30, 1: 30 },
  });

  const usedBits = finalizeLowBudgetBandPayload(state);

  assert.equal(usedBits, 30);
  assert.equal(state.procWords[0] | 0, 7);
  assert.equal(state.procWords[1] | 0, 0);
  assert.equal(state.procWords[0x21] | 0, 0x40);
});
