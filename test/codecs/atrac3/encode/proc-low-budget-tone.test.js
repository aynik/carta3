import assert from "node:assert/strict";
import test from "node:test";

import { AT3_SFB_OFFSETS } from "../../../../src/atrac3/encode-tables.js";
import {
  LOW_BUDGET_DEFAULT_MODE_SHIFT,
  LOW_BUDGET_TIGHT_MODE_SHIFT,
  LOW_BUDGET_TIGHT_MODE_SHIFT_BUDGET,
  scanLowBudgetBandPeaks,
} from "../../../../src/atrac3/proc-low-budget-scan.js";
import {
  at3ToneScaleFromIdsf,
  estimateGroupIdsf,
} from "../../../../src/atrac3/proc-quant-scale.js";
import {
  restoreToneContribution,
  setBestIdsf4Tone,
} from "../../../../src/atrac3/proc-tone-common.js";
import { extractHighBudgetTones } from "../../../../src/atrac3/proc-tone-high-budget.js";
import { runLowBudgetTonePath } from "../../../../src/atrac3/proc-low-budget-tone.js";
import {
  extractMonoLowBudgetTones,
  scanMonoLowBudgetTones,
} from "../../../../src/atrac3/proc-tone-mono.js";
import { finalizeMonoLowBudgetToneCoding } from "../../../../src/atrac3/proc-tone-mono-layout.js";
import {
  AT3ENC_PROC_ACTIVE_BANDS_WORD,
  AT3ENC_PROC_BAND_COUNT,
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_POOL_BASE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_TONE_SCALE_WORD,
  AT3ENC_PROC_TONE_START_WORD,
  AT3ENC_PROC_UNIT_COUNT_WORD,
  at3encAppendToneRegionRowTone,
  at3encProcBandSelectorWord,
  at3encProcToneRegionFlagWord,
  at3encProcToneRegionModeWord,
  at3encProcToneRegionRowCountWord,
  at3encProcToneRegionSymMaxWord,
  at3encProcToneWord,
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
} from "../../../../src/atrac3/proc-layout.js";

test("ATRAC3 tone scale helpers preserve the shared tone scale model", () => {
  assert.equal(at3ToneScaleFromIdsf(1, 20), 0.47247040271759033);
  assert.equal(at3ToneScaleFromIdsf(3, 18), 1.75);
  assert.equal(at3ToneScaleFromIdsf(7, 12), 63);
});

test("restoreToneContribution preserves signed tone coefficient recovery", () => {
  const spectrum = new Float32Array(16);
  const procWords = new Uint32Array(0x200);
  const toneWord = AT3ENC_PROC_TONE_POOL_BASE_WORD;

  procWords[toneWord + 0] = 1;
  procWords[toneWord + 1] = 6;
  procWords[toneWord + 2] = 7;
  procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] = 4;
  procWords[toneWord + AT3ENC_PROC_TONE_SCALE_WORD] = 18;

  restoreToneContribution(spectrum, procWords, toneWord, 3, 2);

  assert.deepEqual(
    Array.from(spectrum.slice(4, 7)),
    Array.from(new Float32Array([1 / 1.75, -2 / 1.75, -1 / 1.75]))
  );
});

test("restoreToneContribution ignores unsupported tone base widths", () => {
  const spectrum = new Float32Array([1, 2, 3, 4]);
  const originalSpectrum = Array.from(spectrum);
  const procWords = new Uint32Array(0x40);

  restoreToneContribution(spectrum, procWords, AT3ENC_PROC_TONE_POOL_BASE_WORD, 4, 3);

  assert.deepEqual(Array.from(spectrum), originalSpectrum);
});

test("setBestIdsf4Tone preserves representative selector choices", () => {
  const spectrum = new Float32Array(32);

  spectrum.set([1000, -800, 0, 0], 0);
  assert.equal(setBestIdsf4Tone(spectrum, 0, 3, 4), 46);

  spectrum.set([2200, -1700, 600, -500], 4);
  assert.equal(setBestIdsf4Tone(spectrum, 4, 5, 4), 51);

  spectrum.set([0.25, -0.5, 0.75, 0], 8);
  assert.equal(setBestIdsf4Tone(spectrum, 8, 7, 3), 17);
});

test("setBestIdsf4Tone preserves the current even-quantized adjustment path", () => {
  const spectrum = new Float32Array([50, -50, 0, 0, 0, 0, 0, 0]);

  assert.equal(setBestIdsf4Tone(spectrum, 0, 3, 4), 37);
  assert.equal(setBestIdsf4Tone(spectrum, 0, 5, 4), 36);
});

test("setBestIdsf4Tone preserves multi-step even-quantized selector widening", () => {
  const spectrum = new Float32Array([43, -43, 0, 0, 0, 0, 0, 0]);

  assert.equal(setBestIdsf4Tone(spectrum, 0, 5, 4), 40);
});

function createLayer({
  shift,
  sfbLimit = 28,
  referencesPrimaryShift = false,
  spectrumValues = [],
}) {
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
      blocks: Array.from({ length: 4 }, () => ({ entryCount: 0 })),
      previousBlock0EntryCount: 0,
    },
  };
}

function runHighBudgetToneCase({
  availableBits,
  spectrumValues,
  bandLimit = 8,
  initialBlockCount = 1,
}) {
  const layer = createLayer({ shift: 0, spectrumValues });
  const procWords = new Uint32Array(0x400);
  const groupIdsf = new Uint32Array(256);
  const bandWork = new Int32Array(34);

  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = initialBlockCount >>> 0;
  estimateGroupIdsf(layer.spectrum, groupIdsf);

  const out = extractHighBudgetTones(
    layer,
    procWords,
    bandLimit,
    availableBits,
    groupIdsf,
    bandWork
  );
  return { out, layer, procWords, bandWork };
}

function createTonePathScratch(procWords = new Uint32Array(0x400)) {
  return {
    procWords,
    bandModes: at3encProcBandModesView(procWords),
    bandSelectors: at3encProcBandSelectorsView(procWords),
    bandSum: new Uint32Array(AT3ENC_PROC_BAND_COUNT),
    bandMetrics: new Int32Array(34),
    groupIdsf: new Uint32Array(256),
    toneClaimSelectors: new Int32Array(AT3ENC_PROC_BAND_COUNT).fill(-1),
    toneClaimWidths: new Int32Array(AT3ENC_PROC_BAND_COUNT),
  };
}

function runMonoToneCase({
  availableBits,
  spectrumValues,
  bands,
  selectors,
  metrics,
  bandLimit = 28,
}) {
  const layer = createLayer({ shift: 0, spectrumValues });
  const procWords = new Uint32Array(0x400);
  const bandWork = new Int32Array(34);
  const toneClaimSelectors = new Int32Array(0x20).fill(-1);
  const toneClaimWidths = new Int32Array(0x20);
  const debug = {};

  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  for (const [band, mode] of bands) {
    procWords[band] = mode;
  }
  for (const [band, selector] of selectors) {
    procWords[at3encProcBandSelectorWord(band)] = selector;
  }
  for (const [band, metric] of metrics) {
    bandWork[band + 1] = metric;
  }

  const out = extractMonoLowBudgetTones(
    layer,
    procWords,
    bandLimit,
    bandWork,
    availableBits,
    toneClaimSelectors,
    toneClaimWidths,
    debug
  );
  return { out, layer, procWords, toneClaimSelectors, toneClaimWidths, debug };
}

function runMonoToneScanCase({
  availableBits,
  spectrumValues,
  bands,
  selectors,
  metrics,
  bandLimit = 28,
}) {
  const layer = createLayer({ shift: 0, spectrumValues });
  const procWords = new Uint32Array(0x400);
  const bandWork = new Int32Array(34);
  const toneClaimSelectors = new Int32Array(0x20).fill(-1);
  const toneClaimWidths = new Int32Array(0x20);

  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  for (const [band, mode] of bands) {
    procWords[band] = mode;
  }
  for (const [band, selector] of selectors) {
    procWords[at3encProcBandSelectorWord(band)] = selector;
  }
  for (const [band, metric] of metrics) {
    bandWork[band + 1] = metric;
  }

  const result = scanMonoLowBudgetTones(
    layer,
    procWords,
    bandLimit,
    bandWork,
    availableBits,
    toneClaimSelectors,
    toneClaimWidths
  );

  return { result, layer, procWords, toneClaimSelectors, toneClaimWidths };
}

function createMonoToneProcWords(tones) {
  const procWords = new Uint32Array(0x400);

  procWords[at3encProcToneRegionModeWord(0)] = 3;
  procWords[at3encProcToneRegionSymMaxWord(0)] = 3;
  for (let i = 0; i < tones.length; i += 1) {
    const { coeffs, start, idsf } = tones[i];
    const toneWord = at3encProcToneWord(i);
    procWords.set([...coeffs, start, idsf], toneWord);

    const block = start >> 8;
    const group = start >> 6;
    procWords[at3encProcToneRegionFlagWord(0, block)] = 1;
    at3encAppendToneRegionRowTone(procWords, 0, group, toneWord);
  }

  return procWords;
}

function runScannedTonePath(layer) {
  const scratch = createTonePathScratch();
  let bandLimit = Math.max(1, Math.min(layer.sfbLimit, AT3ENC_PROC_BAND_COUNT));
  const bitBudget = layer.shift;
  const usesIndependentCoding = layer.referencesPrimaryShift !== true;
  const spectrumU32 = new Uint32Array(
    layer.spectrum.buffer,
    layer.spectrum.byteOffset,
    layer.spectrum.length
  );
  const { procWords, bandModes, bandSelectors, bandSum, bandMetrics, groupIdsf } = scratch;
  const scanned = scanLowBudgetBandPeaks(layer, {
    bandLimit,
    bitBudget,
    usesIndependentCoding,
    groupIdsf,
    bandSum,
    bandSelectors,
  });
  bandLimit = scanned.bandLimit;
  const modeShift =
    bitBudget < scanned.over7TotalWithinLimit * LOW_BUDGET_TIGHT_MODE_SHIFT_BUDGET
      ? LOW_BUDGET_TIGHT_MODE_SHIFT
      : LOW_BUDGET_DEFAULT_MODE_SHIFT;

  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = Math.max(1, Math.ceil(AT3_SFB_OFFSETS[bandLimit] / 256));
  procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = bandLimit >>> 0;
  const availableBits = bitBudget - procWords[AT3ENC_PROC_UNIT_COUNT_WORD] * 3 - bandLimit * 3;

  const debug = {};
  const out = runLowBudgetTonePath(layer, procWords, {
    bandLimit,
    availableBits,
    bitBudget,
    modeShift,
    usesIndependentCoding,
    sumTotal: scanned.sumTotal,
    over7TotalWithinLimit: scanned.over7TotalWithinLimit,
    bandSum,
    bandModes,
    bandSelectors,
    bandMetrics,
    groupIdsf,
    spectrumU32,
    toneClaimSelectors: scratch.toneClaimSelectors,
    toneClaimWidths: scratch.toneClaimWidths,
    debug,
  });

  return { out, debug, ...scratch };
}

test("runLowBudgetTonePath preserves the scanned high-budget tone branch", () => {
  const { out, procWords, bandModes, bandSelectors, bandMetrics } = runScannedTonePath(
    createLayer({
      shift: 1500,
      sfbLimit: 8,
      spectrumValues: [
        [0, 1000],
        [1, -800],
        [64, 500],
        [65, -400],
      ],
    })
  );

  assert.equal(out, 1233);
  assert.equal(procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD], 1);
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD], 2);
  assert.deepEqual(Array.from(bandModes.slice(0, 12)), [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(Array.from(bandSelectors.slice(0, 12)), [14, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0]);
  assert.deepEqual(
    Array.from(bandMetrics.slice(0, 12)),
    [0, 4774, 0, 0, 0, 0, 0, 0, 0, 3751, 0, 0]
  );
});

test("runLowBudgetTonePath preserves mono low-budget tone acceptance when high-budget is blocked", () => {
  const layer = createLayer({
    shift: 1300,
    spectrumValues: [
      [64, 1e6],
      [65, -8e5],
      [96, 9e5],
      [97, -7e5],
    ],
  });
  const scratch = createTonePathScratch();
  const { procWords, bandModes, bandSelectors, bandSum, bandMetrics, groupIdsf } = scratch;
  const debug = {};

  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  bandSelectors[8] = 26;
  bandSelectors[10] = 24;
  const out = runLowBudgetTonePath(layer, procWords, {
    bandLimit: 28,
    availableBits: 1300,
    bitBudget: 1300,
    modeShift: LOW_BUDGET_DEFAULT_MODE_SHIFT,
    usesIndependentCoding: true,
    sumTotal: 4608,
    over7TotalWithinLimit: 100,
    bandSum,
    bandModes,
    bandSelectors,
    bandMetrics,
    groupIdsf,
    spectrumU32: new Uint32Array(
      layer.spectrum.buffer,
      layer.spectrum.byteOffset,
      layer.spectrum.length
    ),
    toneClaimSelectors: scratch.toneClaimSelectors,
    toneClaimWidths: scratch.toneClaimWidths,
    debug,
  });

  assert.equal(out, 1243);
  assert.equal(procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD], 1);
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD], 1);
  assert.deepEqual(Array.from(bandModes.slice(8, 13)), [0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(bandSelectors.slice(8, 13)), [0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(bandMetrics.slice(8, 13)), [-864, -4868, -2527, -4848, -1596]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 12)
    ),
    [7, 6, 0, 0, 64, 1, 3, 3, 0, 0, 96, 27]
  );
  assert.deepEqual(debug, {
    toneDecision: {
      toneCount: 2,
      zeroLastCount: 2,
      headerBits: 20,
      initialBlockCount: 1,
      costA: 39,
      costB: 36,
      chosen: 36,
      toneFlag: 1,
      toneRegionCount: 1,
    },
  });
});

test("scanMonoLowBudgetTones preserves the current candidate-overflow no-op", () => {
  const { result, layer, procWords } = runMonoToneScanCase({
    availableBits: 900,
    spectrumValues: [
      [64, 1e6],
      [65, -8e5],
      [68, 9e5],
      [69, -7e5],
    ],
    bands: [[8, 1]],
    selectors: [[8, 26]],
    metrics: [[8, 0x800]],
  });

  assert.deepEqual(result, {
    headerBits: 8,
    toneCount: 0,
    toneBitsCost: 0,
    zeroLastCount: 0,
  });
  assert.deepEqual(
    Array.from(procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, at3encProcToneRegionSymMaxWord(0) + 1)),
    [1, 0, 0, 0, 0, 0, 0, 3, 3]
  );
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] | 0, 0);
  assert.deepEqual(Array.from(layer.spectrum.slice(64, 72)), [1e6, -8e5, 0, 0, 9e5, -7e5, 0, 0]);
});

test("extractMonoLowBudgetTones preserves the low-budget fast exit", () => {
  const { out, layer, procWords, debug } = runMonoToneCase({
    availableBits: 200,
    spectrumValues: [
      [64, 1e6],
      [65, -8e5],
    ],
    bands: [[8, 1]],
    selectors: [[8, 26]],
    metrics: [[8, 0x800]],
  });

  assert.equal(out, 200);
  assert.deepEqual(
    Array.from(procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, at3encProcToneRegionSymMaxWord(0) + 1)),
    [1, 0, 0, 0, 0, 0, 0, 3, 3]
  );
  assert.deepEqual(Array.from(procWords.slice(8, 13)), [1, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x28, 0x2d)), [26, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 18)
    ),
    new Array(18).fill(0)
  );
  assert.deepEqual(Array.from(layer.spectrum.slice(64, 72)), [1e6, -8e5, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(debug, {});
});

test("extractMonoLowBudgetTones preserves the current candidate-overflow no-op", () => {
  const { out, layer, procWords, debug } = runMonoToneCase({
    availableBits: 900,
    spectrumValues: [
      [64, 1e6],
      [65, -8e5],
      [68, 9e5],
      [69, -7e5],
    ],
    bands: [[8, 1]],
    selectors: [[8, 26]],
    metrics: [[8, 0x800]],
  });

  assert.equal(out, 900);
  assert.deepEqual(
    Array.from(procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, at3encProcToneRegionSymMaxWord(0) + 1)),
    [1, 0, 0, 0, 0, 0, 0, 3, 3]
  );
  assert.deepEqual(Array.from(procWords.slice(8, 13)), [1, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x28, 0x2d)), [26, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(layer.spectrum.slice(64, 72)), [1e6, -8e5, 0, 0, 9e5, -7e5, 0, 0]);
  assert.deepEqual(debug, {});
});

test("extractMonoLowBudgetTones preserves the current single-tone rejection path", () => {
  const { out, layer, procWords, toneClaimSelectors, toneClaimWidths, debug } = runMonoToneCase({
    availableBits: 900,
    spectrumValues: [
      [64, 1e6],
      [65, -8e5],
    ],
    bands: [[8, 1]],
    selectors: [[8, 26]],
    metrics: [[8, 0x800]],
  });

  assert.equal(out, 900);
  assert.deepEqual(
    Array.from(procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, at3encProcToneRegionSymMaxWord(0) + 1)),
    [1, 0, 0, 1, 0, 0, 0, 3, 3]
  );
  assert.deepEqual(Array.from(procWords.slice(8, 13)), [0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x28, 0x2d)), [26, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(toneClaimSelectors.slice(8, 13)), [26, -1, -1, -1, -1]);
  assert.deepEqual(Array.from(toneClaimWidths.slice(8, 13)), [4, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x52, 0x5a)), [1, 336, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 18)
    ),
    [7, 6, 0, 0, 64, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(64, 72)),
    [999689, -799898.625, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(debug, {});
});

test("extractMonoLowBudgetTones preserves the current multi-tone acceptance and cost choice", () => {
  const { out, layer, procWords, toneClaimSelectors, toneClaimWidths, debug } = runMonoToneCase({
    availableBits: 1300,
    spectrumValues: [
      [64, 1e6],
      [65, -8e5],
      [96, 9e5],
      [97, -7e5],
    ],
    bands: [
      [8, 1],
      [10, 1],
    ],
    selectors: [
      [8, 26],
      [10, 24],
    ],
    metrics: [
      [8, 0x800],
      [10, 0x800],
    ],
  });

  assert.equal(out, 1243);
  assert.deepEqual(
    Array.from(procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, at3encProcToneRegionSymMaxWord(0) + 1)),
    [1, 1, 1, 1, 0, 0, 0, 3, 1]
  );
  assert.deepEqual(Array.from(procWords.slice(8, 13)), [0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x28, 0x2d)), [26, 0, 24, 0, 0]);
  assert.deepEqual(Array.from(toneClaimSelectors.slice(8, 13)), [26, -1, 24, -1, -1]);
  assert.deepEqual(Array.from(toneClaimWidths.slice(8, 13)), [4, 0, 4, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x52, 0x5a)), [2, 336, 342, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 18)
    ),
    [7, 6, 0, 0, 64, 1, 3, 3, 0, 0, 96, 27, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(64, 72)),
    [999689, -799898.625, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(96, 104)),
    [898779.4375, -599186.3125, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(debug, {
    toneDecision: {
      toneCount: 2,
      zeroLastCount: 2,
      headerBits: 20,
      initialBlockCount: 1,
      costA: 39,
      costB: 36,
      chosen: 36,
      toneFlag: 1,
      toneRegionCount: 1,
    },
  });
});

test("extractMonoLowBudgetTones preserves accepted leading-zero tone shifting", () => {
  const { out, layer, procWords, toneClaimSelectors, toneClaimWidths, debug } = runMonoToneCase({
    availableBits: 2000,
    spectrumValues: [
      [64, 0.1],
      [65, 0.1],
      [66, 0.1],
      [67, 2],
      [96, 1e6],
      [97, -8e5],
    ],
    bands: [
      [8, 1],
      [10, 1],
    ],
    selectors: [
      [8, 26],
      [10, 24],
    ],
    metrics: [
      [8, 0x800],
      [10, 0x800],
    ],
  });

  assert.equal(out, 1943);
  assert.deepEqual(
    Array.from(procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, at3encProcToneRegionSymMaxWord(0) + 1)),
    [1, 0, 1, 1, 0, 0, 0, 3, 1]
  );
  assert.deepEqual(Array.from(procWords.slice(8, 13)), [0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x28, 0x2d)), [26, 0, 24, 0, 0]);
  assert.deepEqual(Array.from(toneClaimSelectors.slice(8, 13)), [26, -1, 24, -1, -1]);
  assert.deepEqual(Array.from(toneClaimWidths.slice(8, 13)), [4, 0, 4, 0, 0]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 12)
    ),
    [3, 0, 0, 0, 67, 19, 7, 6, 0, 0, 96, 1]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(64, 72)),
    [
      0.10000000149011612, 0.10000000149011612, 0.10000000149011612, -0.15986457467079163, 0, 0, 0,
      0,
    ]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(96, 104)),
    [999689, -799898.625, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(debug, {
    toneDecision: {
      toneCount: 2,
      zeroLastCount: 2,
      headerBits: 20,
      initialBlockCount: 1,
      costA: 36,
      costB: 36,
      chosen: 36,
      toneFlag: 0,
      toneRegionCount: 1,
    },
  });
});

test("scanMonoLowBudgetTones preserves same-band adjacent tone realignment before layout", () => {
  const { result, layer, procWords, toneClaimSelectors, toneClaimWidths } = runMonoToneScanCase({
    availableBits: 2000,
    spectrumValues: [
      [192, 1e6],
      [193, -8e5],
      [196, 9e5],
      [197, -7e5],
    ],
    bands: [[16, 1]],
    selectors: [[16, 26]],
    metrics: [[16, 0x800]],
    bandLimit: 17,
  });

  assert.deepEqual(result, {
    headerBits: 20,
    toneCount: 2,
    toneBitsCost: 40,
    zeroLastCount: 2,
  });
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] | 0, 0);
  assert.equal(procWords[16] | 0, 0);
  assert.equal(procWords[0x30] | 0, 26);
  assert.equal(toneClaimSelectors[16] | 0, 26);
  assert.equal(toneClaimWidths[16] | 0, 5);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 12)
    ),
    [7, 6, 0, 0, 192, 1, 5, 0, 0, 0, 193, 3]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(192, 200)),
    [999689, -800475.4375, 0, 0, 899949.6875, -700000, 0, 0]
  );
});

test("extractMonoLowBudgetTones preserves same-band adjacent tone realignment", () => {
  const { out, layer, procWords, toneClaimSelectors, toneClaimWidths, debug } = runMonoToneCase({
    availableBits: 2000,
    spectrumValues: [
      [192, 1e6],
      [193, -8e5],
      [196, 9e5],
      [197, -7e5],
    ],
    bands: [[16, 1]],
    selectors: [[16, 26]],
    metrics: [[16, 0x800]],
  });

  assert.equal(out, 1943);
  assert.deepEqual(
    Array.from(procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, at3encProcToneRegionSymMaxWord(0) + 1)),
    [1, 0, 1, 1, 0, 0, 0, 3, 1]
  );
  assert.equal(procWords[16] | 0, 0);
  assert.equal(procWords[0x30] | 0, 26);
  assert.equal(toneClaimSelectors[16] | 0, 26);
  assert.equal(toneClaimWidths[16] | 0, 5);
  assert.deepEqual(Array.from(procWords.slice(0x62, 0x6c)), [2, 336, 342, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 12)
    ),
    [7, 6, 0, 0, 192, 1, 5, 0, 0, 0, 193, 3]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(192, 200)),
    [999689, -800475.4375, 0, 0, 899949.6875, -700000, 0, 0]
  );
  assert.deepEqual(debug, {
    toneDecision: {
      toneCount: 2,
      zeroLastCount: 2,
      headerBits: 20,
      initialBlockCount: 1,
      costA: 36,
      costB: 36,
      chosen: 36,
      toneFlag: 0,
      toneRegionCount: 1,
    },
  });
});

test("scanMonoLowBudgetTones preserves cross-band overlap claim widths before layout", () => {
  const { result, layer, procWords, toneClaimSelectors, toneClaimWidths } = runMonoToneScanCase({
    availableBits: 2000,
    spectrumValues: [
      [95, 2],
      [96, 1e6],
      [97, -8e5],
      [128, 9e5],
      [129, -7e5],
    ],
    bands: [
      [9, 1],
      [10, 1],
      [12, 1],
    ],
    selectors: [
      [9, 26],
      [10, 24],
      [12, 24],
    ],
    metrics: [
      [9, 0x800],
      [10, 0x800],
      [12, 0x800],
    ],
    bandLimit: 13,
  });

  assert.deepEqual(result, {
    headerBits: 20,
    toneCount: 2,
    toneBitsCost: 46,
    zeroLastCount: 2,
  });
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] | 0, 0);
  assert.deepEqual(Array.from(procWords.slice(9, 13)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x29, 0x2d)), [26, 24, 0, 24]);
  assert.deepEqual(Array.from(toneClaimSelectors.slice(9, 13)), [26, 24, -1, 24]);
  assert.deepEqual(Array.from(toneClaimWidths.slice(9, 13)), [3, 3, 0, 4]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 18)
    ),
    [2, 7, 6, 0, 95, 1, 3, 3, 0, 0, 128, 27, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(95, 101)),
    [-0.002374442992731929, 999689, -799898.625, 0, 0, 0]
  );
});

test("extractMonoLowBudgetTones preserves cross-band overlap claim widths", () => {
  const { out, layer, procWords, toneClaimSelectors, toneClaimWidths, debug } = runMonoToneCase({
    availableBits: 2000,
    spectrumValues: [
      [95, 2],
      [96, 1e6],
      [97, -8e5],
      [128, 9e5],
      [129, -7e5],
    ],
    bands: [
      [9, 1],
      [10, 1],
      [12, 1],
    ],
    selectors: [
      [9, 26],
      [10, 24],
      [12, 24],
    ],
    metrics: [
      [9, 0x800],
      [10, 0x800],
      [12, 0x800],
    ],
  });

  assert.equal(out, 1937);
  assert.deepEqual(Array.from(procWords.slice(9, 13)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(procWords.slice(0x29, 0x2d)), [26, 24, 0, 24]);
  assert.deepEqual(Array.from(toneClaimSelectors.slice(9, 13)), [26, 24, -1, 24]);
  assert.deepEqual(Array.from(toneClaimWidths.slice(9, 13)), [3, 3, 0, 4]);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 18)
    ),
    [2, 7, 6, 0, 95, 1, 3, 3, 0, 0, 128, 27, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(95, 101)),
    [-0.002374442992731929, 999689, -799898.625, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(layer.spectrum.slice(128, 134)),
    [898779.4375, -599186.3125, 0, 0, 0, 0]
  );
  assert.deepEqual(debug, {
    toneDecision: {
      toneCount: 2,
      zeroLastCount: 2,
      headerBits: 20,
      initialBlockCount: 1,
      costA: 44,
      costB: 42,
      chosen: 42,
      toneFlag: 1,
      toneRegionCount: 1,
    },
  });
});

test("finalizeMonoLowBudgetToneCoding shortens all-zero tails without moving starts", () => {
  const procWords = createMonoToneProcWords([
    { coeffs: [7, 6, 0, 0], start: 64, idsf: 1 },
    { coeffs: [3, 3, 0, 0], start: 96, idsf: 27 },
  ]);

  const decision = finalizeMonoLowBudgetToneCoding(procWords, 2, 43, 2);

  assert.deepEqual(decision, { toneCount: 2, costA: 39, costB: 36, chosen: 36 });
  assert.equal(procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] | 0, 1);
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] | 0, 1);
  assert.equal(procWords[at3encProcToneRegionSymMaxWord(0)] | 0, 1);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 12)
    ),
    [7, 6, 0, 0, 64, 1, 3, 3, 0, 0, 96, 27]
  );
});

test("finalizeMonoLowBudgetToneCoding preserves the current second-region split path", () => {
  const procWords = createMonoToneProcWords([
    { coeffs: [1, 1, 0, 0], start: 0, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 4, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 8, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 12, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 16, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 20, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 24, idsf: 10 },
    { coeffs: [1, 1, 5, 6], start: 64, idsf: 22 },
  ]);

  const decision = finalizeMonoLowBudgetToneCoding(procWords, 8, 220, 7);

  assert.deepEqual(decision, { toneCount: 9, costA: 227, costB: 189, chosen: 189 });
  assert.equal(procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] | 0, 1);
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] | 0, 2);
  assert.equal(procWords[0x52] | 0, 1);
  assert.equal(procWords[0xd8] | 0, 2);
  assert.deepEqual(
    Array.from(procWords.slice(0x17a, 0x17a + 12)),
    [1, 1, 0, 0, 64, 22, 5, 6, 0, 0, 66, 22]
  );
  assert.equal(procWords[0x53] | 0, 0x17a);
  assert.equal(procWords[0xd9] | 0, 0x17a);
  assert.equal(procWords[0xda] | 0, 0x180);
});

test("finalizeMonoLowBudgetToneCoding leaves the primary layout in place when a split row is full", () => {
  const procWords = createMonoToneProcWords([
    { coeffs: [1, 1, 5, 6], start: 64, idsf: 22 },
    { coeffs: [1, 1, 0, 0], start: 68, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 72, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 76, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 80, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 84, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 88, idsf: 10 },
    { coeffs: [1, 1, 0, 0], start: 128, idsf: 10 },
  ]);

  const decision = finalizeMonoLowBudgetToneCoding(procWords, 8, 220, 7);

  assert.deepEqual(decision, { toneCount: 8, costA: 220, costB: 192, chosen: 192 });
  assert.equal(procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] | 0, 1);
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] | 0, 1);
  assert.equal(procWords[at3encProcToneRegionRowCountWord(0, 1)] | 0, 7);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 12)
    ),
    [1, 1, 5, 6, 64, 22, 1, 1, 0, 0, 68, 10]
  );
});

test("extractHighBudgetTones preserves the current baseline extraction layout", () => {
  const { out, layer, procWords, bandWork } = runHighBudgetToneCase({
    availableBits: 1233,
    spectrumValues: [
      [0, 1000],
      [1, -800],
      [64, 500],
      [65, -400],
    ],
  });

  assert.equal(out, 1123);
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_UNIT_COUNT_WORD, AT3ENC_PROC_TONE_REGION_COUNT_WORD + 1)
    ),
    [1, 1, 2]
  );
  assert.deepEqual(
    Array.from(
      procWords.slice(at3encProcToneRegionFlagWord(0, 0), at3encProcToneRegionFlagWord(0, 0) + 8)
    ),
    [1, 0, 0, 0, 5, 3, 1, 342]
  );
  assert.deepEqual(
    Array.from(
      procWords.slice(at3encProcToneRegionFlagWord(1, 0), at3encProcToneRegionFlagWord(1, 0) + 8)
    ),
    [1, 0, 0, 0, 7, 3, 1, 336]
  );
  assert.deepEqual(
    Array.from(
      procWords.slice(AT3ENC_PROC_TONE_POOL_BASE_WORD, AT3ENC_PROC_TONE_POOL_BASE_WORD + 12)
    ),
    [31, 39, 0, 0, 0, 45, 13, 5, 0, 0, 0, 28]
  );
  assert.deepEqual(Array.from(procWords.slice(0, 8)), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(procWords.slice(at3encProcBandSelectorWord(0), at3encProcBandSelectorWord(0) + 8)),
    [14, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(Array.from(bandWork.slice(0, 9)), [0, 4774, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(layer.spectrum.slice(0, 4)),
    [0.31746286153793335, -0.7407447695732117, 0, 0]
  );
  assert.deepEqual(Array.from(layer.spectrum.slice(64, 68)), [500, -400, 0, 0]);
});

test("extractHighBudgetTones preserves same-group replacement ordering when both classes fill", () => {
  const spectrumValues = [];
  for (let start = 0; start <= 60; start += 4) {
    const strong = start >= 56;
    spectrumValues.push(
      [start, strong ? 2200 + start : 600],
      [start + 1, strong ? -1700 - start : -500]
    );
  }

  const { out, procWords } = runHighBudgetToneCase({
    availableBits: 20000,
    spectrumValues,
  });

  const class0CountWord = at3encProcToneRegionRowCountWord(0, 0);
  const class1CountWord = at3encProcToneRegionRowCountWord(1, 0);
  const class0Slots = Array.from(
    procWords.slice(class0CountWord + 1, class0CountWord + 1 + (procWords[class0CountWord] | 0))
  );
  const class1Slots = Array.from(
    procWords.slice(class1CountWord + 1, class1CountWord + 1 + (procWords[class1CountWord] | 0))
  );
  const starts = (toneWords) =>
    toneWords.map((toneWord) => procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] | 0);
  const idsfs = (toneWords) =>
    toneWords.map((toneWord) => procWords[toneWord + AT3ENC_PROC_TONE_SCALE_WORD] | 0);

  assert.equal(out, 19434);
  assert.equal(procWords[class0CountWord] | 0, 7);
  assert.equal(procWords[class1CountWord] | 0, 7);
  assert.deepEqual(starts(class0Slots), [28, 32, 36, 40, 44, 48, 52]);
  assert.deepEqual(starts(class1Slots), [8, 12, 16, 20, 24, 56, 60]);
  assert.deepEqual(idsfs(class0Slots), [43, 43, 43, 43, 43, 43, 43]);
  assert.deepEqual(idsfs(class1Slots), [43, 43, 43, 43, 43, 50, 50]);
});

test("extractHighBudgetTones preserves alternate-class fallback when the preferred row is full", () => {
  const spectrumValues = [];
  for (let start = 0; start <= 28; start += 4) {
    spectrumValues.push([start, 2200 + start], [start + 1, -1700 - start]);
  }

  const { out, procWords } = runHighBudgetToneCase({
    availableBits: 490,
    spectrumValues,
  });

  const class0CountWord = at3encProcToneRegionRowCountWord(0, 0);
  const class1CountWord = at3encProcToneRegionRowCountWord(1, 0);
  const class0Slots = Array.from(
    procWords.slice(class0CountWord + 1, class0CountWord + 1 + (procWords[class0CountWord] | 0))
  );
  const class1Slots = Array.from(
    procWords.slice(class1CountWord + 1, class1CountWord + 1 + (procWords[class1CountWord] | 0))
  );
  const starts = (toneWords) =>
    toneWords.map((toneWord) => procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] | 0);

  assert.equal(out, 164);
  assert.equal(procWords[class0CountWord] | 0, 1);
  assert.equal(procWords[class1CountWord] | 0, 7);
  assert.deepEqual(starts(class0Slots), [28]);
  assert.deepEqual(starts(class1Slots), [0, 4, 8, 12, 16, 20, 24]);
});

test("extractHighBudgetTones preserves the current over-budget first-pass quirk", () => {
  const { out, procWords } = runHighBudgetToneCase({
    availableBits: 100,
    spectrumValues: [
      [0, 1000],
      [1, -800],
    ],
  });

  assert.equal(out, 30);
  assert.equal(procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] | 0, 2);
  assert.equal(procWords[at3encProcToneRegionRowCountWord(0, 0)] | 0, 0);
  assert.equal(procWords[at3encProcToneRegionRowCountWord(1, 0)] | 0, 1);
  assert.equal(procWords[AT3ENC_PROC_TONE_POOL_BASE_WORD + AT3ENC_PROC_TONE_START_WORD] | 0, 0);
});
