import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisGeneralAt5,
  applyBand0FrequencyLimitAt5,
  computeGeneralMaxEntryCountsAt5,
} from "../../../src/atrac3plus/ghwave/general.js";

function createAnalysisState() {
  return {
    hasStart: 0,
    hasEnd: 0,
    start: 0,
    end: 0,
    gateStartValid: 0,
    gateEndValid: 0,
    gateStartIdx: 0,
    gateEndIdx: 0x20,
    count: 0,
    entries: null,
  };
}

function createAnalysisSlot(sharedPtr = null) {
  return {
    sharedPtr,
    records: Array.from({ length: 16 }, () => createAnalysisState()),
  };
}

function createSineBand(frequencyBin, amplitude = 1, phase = 0) {
  const band = new Float32Array(256);
  for (let sampleIndex = 0; sampleIndex < band.length; sampleIndex += 1) {
    band[sampleIndex] =
      amplitude * Math.sin((2 * Math.PI * frequencyBin * sampleIndex) / band.length + phase);
  }
  return band;
}

test("computeGeneralMaxEntryCountsAt5 preserves stereo split and joint-band suppression", () => {
  const maxEntriesByChannel = computeGeneralMaxEntryCountsAt5({
    analysisParam: 15,
    channelCount: 2,
    bandCount: 3,
    weightsByCh: [new Float32Array([1, 4, 8]), new Float32Array([0.5, 4, 0])],
    bandOrder: new Int32Array([2, 1, 0]),
    jointFlags: new Int32Array([0, 1, 0]),
  });

  assert.deepEqual(Array.from(maxEntriesByChannel[0].slice(0, 3)), [5, 10, 9]);
  assert.deepEqual(Array.from(maxEntriesByChannel[1].slice(0, 3)), [5, 0, 9]);
});

test("computeGeneralMaxEntryCountsAt5 clamps oversized mono budgets to 0xf", () => {
  const maxEntriesByChannel = computeGeneralMaxEntryCountsAt5({
    analysisParam: 15,
    channelCount: 1,
    bandCount: 1,
    weightsByCh: [new Float32Array([16])],
    bandOrder: new Int32Array([0]),
    jointFlags: new Int32Array(16),
  });

  assert.equal(maxEntriesByChannel[0][0], 0x0f);
  assert.equal(maxEntriesByChannel[1][0], 0);
});

test("computeGeneralMaxEntryCountsAt5 clamps negative scalable budgets instead of wrapping", () => {
  const maxEntriesByChannel = computeGeneralMaxEntryCountsAt5({
    analysisParam: 12,
    channelCount: 1,
    bandCount: 3,
    weightsByCh: [new Float32Array([16, 16, 16])],
    bandOrder: new Int32Array([0, 1, 2]),
    jointFlags: new Int32Array(16),
  });

  assert.deepEqual(Array.from(maxEntriesByChannel[0].slice(0, 3)), [6, 6, 4]);
  assert.deepEqual(Array.from(maxEntriesByChannel[1].slice(0, 3)), [0, 0, 0]);
});

test("applyBand0FrequencyLimitAt5 mutes the upper half when low-band energy dominates", () => {
  const spectrum = new Float32Array(0x84);
  const freqMask = new Float32Array(0x84).fill(1);
  spectrum[0] = 17;
  spectrum[0x40] = 1;

  applyBand0FrequencyLimitAt5(spectrum, freqMask);

  assert.equal(freqMask[0x3f], 1);
  assert.equal(freqMask[0x40], 0);
  assert.equal(freqMask[0x80], 0);
});

test("applyBand0FrequencyLimitAt5 keeps the full mask at the ratio boundary", () => {
  const spectrum = new Float32Array(0x84);
  const freqMask = new Float32Array(0x84).fill(1);
  spectrum[0] = 16;
  spectrum[0x40] = 1;

  applyBand0FrequencyLimitAt5(spectrum, freqMask);

  assert.equal(freqMask[0x40], 1);
  assert.equal(freqMask[0x80], 1);
});

test("analysisGeneralAt5 preserves joint-band mirrored state while only channel 0 records the peak bin", () => {
  const sharedState = {
    flag: 1,
    bandCount: 1,
    jointFlags: new Int32Array([1]),
    mixFlags: new Int32Array([0]),
    entriesU32: new Uint32Array(48 * 4),
  };
  const ctxList = [
    { slots: [null, null, null, createAnalysisSlot(), createAnalysisSlot(sharedState)] },
    { slots: [null, null, null, createAnalysisSlot(), createAnalysisSlot(sharedState)] },
  ];
  const srcList = new Array(32).fill(null);
  srcList[0] = createSineBand(12);
  srcList[16] = createSineBand(12);
  const peakBinsByCh = [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)];

  analysisGeneralAt5(
    ctxList,
    srcList,
    0,
    0x13,
    2,
    peakBinsByCh,
    [new Float32Array([8]), new Float32Array([8])],
    new Int32Array([0]),
    null
  );

  const primaryState = ctxList[0].slots[4].records[0];
  const mirroredState = ctxList[1].slots[4].records[0];

  assert.equal(peakBinsByCh[0][0], 12);
  assert.equal(peakBinsByCh[1][0], -1);
  assert.equal(primaryState.count, 1);
  assert.equal(mirroredState.count, 1);
  assert.equal(primaryState.start, 0);
  assert.equal(primaryState.end, 256);
  assert.equal(mirroredState.start, 0);
  assert.equal(mirroredState.end, 256);
  assert.equal(mirroredState.entries, primaryState.entries);
  assert.deepEqual(Array.from(sharedState.entriesU32.slice(0, 4)), [3, 0, 0, 96]);
});

test("analysisGeneralAt5 reuses caller-owned work buffers for joint-band analysis", () => {
  const sharedState = {
    flag: 1,
    bandCount: 1,
    jointFlags: new Int32Array([1]),
    mixFlags: new Int32Array([0]),
    entriesU32: new Uint32Array(48 * 4),
  };
  const ctxList = [
    { slots: [null, null, null, createAnalysisSlot(), createAnalysisSlot(sharedState)] },
    { slots: [null, null, null, createAnalysisSlot(), createAnalysisSlot(sharedState)] },
  ];
  const srcList = new Array(32).fill(null);
  const peakBinsByCh = [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)];
  const work = {
    window: new Float32Array(0x100).fill(5),
    mixed: new Float32Array(0x100).fill(7),
    spectrumMix: new Float32Array(0x84).fill(9),
    spectrumCh0: new Float32Array(0x84).fill(11),
    spectrumCh1: new Float32Array(0x84).fill(13),
    freqMask: new Float32Array(0x84).fill(15),
    scanBuf: new Float32Array(0x100).fill(17),
    scanGroupPeaks: new Float32Array(8).fill(19),
    scanSpectrum: new Float32Array(0x84).fill(21),
    entryMagnitudes: new Float32Array(16).fill(23),
    entryPhases: new Int32Array(16).fill(25),
    entryFrequencies: new Int32Array(16).fill(27),
  };

  srcList[0] = createSineBand(12);
  srcList[16] = createSineBand(12);

  analysisGeneralAt5(
    ctxList,
    srcList,
    0,
    0x13,
    2,
    peakBinsByCh,
    [new Float32Array([8]), new Float32Array([8])],
    new Int32Array([0]),
    work
  );

  assert.equal(peakBinsByCh[0][0], 12);
  assert.ok(work.window.some((value) => value !== 5));
  assert.ok(work.mixed.some((value) => value !== 7));
  assert.ok(work.scanBuf.some((value) => value !== 17));
  assert.ok(work.scanSpectrum.some((value) => value !== 21));
  assert.ok(work.entryMagnitudes.some((value) => value !== 23));
  assert.ok(work.entryPhases.some((value) => value !== 25));
  assert.ok(work.entryFrequencies.some((value) => value !== 27));
});
