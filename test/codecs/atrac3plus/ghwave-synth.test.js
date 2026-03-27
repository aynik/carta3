import assert from "node:assert/strict";
import test from "node:test";

import { synthesisWavAt5 } from "../../../src/atrac3plus/dsp.js";
import { AT5_WIN } from "../../../src/atrac3plus/tables/decode.js";
import { at5GhwaveApplySynthesisResidual } from "../../../src/atrac3plus/ghwave/synth.js";

const AT5_GHWAVE_HALF_SAMPLES = 128;

function createAnalysis({
  hasStart = 0,
  hasEnd = 0,
  start = 0,
  end = AT5_GHWAVE_HALF_SAMPLES,
  count = 1,
  entries = new Uint32Array([3, 0, 0, 64]),
} = {}) {
  return { hasStart, hasEnd, start, end, count, entries };
}

function createSlot(analysis) {
  return { records: [analysis] };
}

function createSynthContext(analysis) {
  return {
    hasLeftFade: analysis.hasStart | 0,
    hasRightFade: analysis.hasEnd | 0,
    leftIndex: analysis.start | 0,
    rightIndex: analysis.end | 0,
    entryCount: analysis.count | 0,
    entries: analysis.entries,
  };
}

function renderHalf(analysis, offset, mode = 1, mixFlag = 0, channelIndex = 0) {
  const output = new Float32Array(AT5_GHWAVE_HALF_SAMPLES);
  synthesisWavAt5(
    createSynthContext(analysis),
    output,
    offset,
    AT5_GHWAVE_HALF_SAMPLES,
    mode,
    mixFlag,
    channelIndex
  );
  return output;
}

function multiplyByWindow(buffer, offset) {
  const output = new Float32Array(buffer);
  for (let sampleIndex = 0; sampleIndex < AT5_GHWAVE_HALF_SAMPLES; sampleIndex += 1) {
    output[sampleIndex] *= AT5_WIN[offset + sampleIndex] ?? 0;
  }
  return output;
}

function assertFloatArrayClose(actual, expected, epsilon = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `mismatch at ${index}: ${actual[index]} vs ${expected[index]}`
    );
  }
}

test("at5GhwaveApplySynthesisResidual preserves the requirePrevEntries gate", () => {
  const spectrum = new Float32Array(AT5_GHWAVE_HALF_SAMPLES).fill(1);

  at5GhwaveApplySynthesisResidual({
    analysisPtrs: [spectrum],
    analysisBase: 0,
    channelCount: 1,
    bandCount: 1,
    p20Slots: [createSlot(createAnalysis({ count: 0, entries: new Uint32Array(0) }))],
    p24Slots: [createSlot(createAnalysis())],
    baseGlobal: { mixFlags: new Int32Array(16) },
    global: { mixFlags: new Int32Array(16) },
    baseFlag: 1,
    curFlag: 1,
    requirePrevEntries: true,
  });

  assertFloatArrayClose(spectrum, new Float32Array(AT5_GHWAVE_HALF_SAMPLES).fill(1));
});

test("at5GhwaveApplySynthesisResidual applies the leading overlap window for current-only residuals", () => {
  const currentAnalysis = createAnalysis({ hasStart: 0, hasEnd: 0, start: 0, end: 128 });
  const spectrum = new Float32Array(AT5_GHWAVE_HALF_SAMPLES);
  const expected = multiplyByWindow(renderHalf(currentAnalysis, 0), 0).map((value) => -value);

  at5GhwaveApplySynthesisResidual({
    analysisPtrs: [spectrum],
    analysisBase: 0,
    channelCount: 1,
    bandCount: 1,
    p20Slots: [createSlot(createAnalysis({ count: 0, entries: new Uint32Array(0) }))],
    p24Slots: [createSlot(currentAnalysis)],
    baseGlobal: { mixFlags: new Int32Array(16) },
    global: { mixFlags: new Int32Array(16) },
    baseFlag: 1,
    curFlag: 1,
  });

  assertFloatArrayClose(spectrum, expected);
});

test("at5GhwaveApplySynthesisResidual sums overlapping previous and current halves before subtraction", () => {
  const previousAnalysis = createAnalysis({ hasStart: 0, hasEnd: 0, start: 0, end: 128 });
  const currentAnalysis = createAnalysis({
    hasStart: 0,
    hasEnd: 0,
    start: 0,
    end: 128,
    entries: new Uint32Array([4, 0, 8, 80]),
  });
  const spectrum = new Float32Array(AT5_GHWAVE_HALF_SAMPLES);
  const previousExpected = multiplyByWindow(
    renderHalf(previousAnalysis, AT5_GHWAVE_HALF_SAMPLES),
    AT5_GHWAVE_HALF_SAMPLES
  );
  const currentExpected = multiplyByWindow(renderHalf(currentAnalysis, 0), 0);
  const expected = new Float32Array(AT5_GHWAVE_HALF_SAMPLES);

  for (let sampleIndex = 0; sampleIndex < AT5_GHWAVE_HALF_SAMPLES; sampleIndex += 1) {
    expected[sampleIndex] = -(previousExpected[sampleIndex] + currentExpected[sampleIndex]);
  }

  at5GhwaveApplySynthesisResidual({
    analysisPtrs: [spectrum],
    analysisBase: 0,
    channelCount: 1,
    bandCount: 1,
    p20Slots: [createSlot(previousAnalysis)],
    p24Slots: [createSlot(currentAnalysis)],
    baseGlobal: { mixFlags: new Int32Array(16) },
    global: { mixFlags: new Int32Array(16) },
    baseFlag: 1,
    curFlag: 1,
  });

  assertFloatArrayClose(spectrum, expected);
});
