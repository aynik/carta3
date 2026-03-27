import assert from "node:assert/strict";
import test from "node:test";

import {
  extractGhwaveAt5,
  computeSineExtractAllocationsAt5,
  resolveGhwaveModeConfigAt5,
} from "../../../src/atrac3plus/ghwave/extract.js";

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

test("resolveGhwaveModeConfigAt5 preserves the low-core stereo fallback to single-band general mode", () => {
  const config = resolveGhwaveModeConfigAt5({
    selectedModeByCh: new Int32Array([1, 1]),
    mode2CandidateByCh: new Int32Array([1, 1]),
    mode1CandidateByCh: new Int32Array(2),
    coreMode: 0x0b,
    channelCount: 2,
    bandCount: 4,
    encodeFlagD0: 1,
    encodeFlags: 0x4,
  });

  assert.equal(config.localMode, 3);
  assert.equal(config.globalFlag, 0);
  assert.equal(config.globalBandCount, 1);
  assert.equal(config.encodeFlags, 0x4);
  assert.deepEqual(Array.from(config.resolvedModeByCh), [2, 2]);
});

test("resolveGhwaveModeConfigAt5 preserves mode-1 flagging across all active bands", () => {
  const config = resolveGhwaveModeConfigAt5({
    selectedModeByCh: new Int32Array([1, 0]),
    mode2CandidateByCh: new Int32Array(2),
    mode1CandidateByCh: new Int32Array([1, 0]),
    coreMode: 0x13,
    channelCount: 1,
    bandCount: 5,
    encodeFlagD0: 0,
    encodeFlags: 0x8,
  });

  assert.equal(config.localMode, 1);
  assert.equal(config.globalFlag, 1);
  assert.equal(config.globalBandCount, 5);
  assert.equal(config.encodeFlags, 0x9);
  assert.deepEqual(Array.from(config.resolvedModeByCh), [1, 0]);
});

test("resolveGhwaveModeConfigAt5 preserves the encodeFlagD0 fallback band clamp for mixed candidates", () => {
  const config = resolveGhwaveModeConfigAt5({
    selectedModeByCh: new Int32Array([1, 1]),
    mode2CandidateByCh: new Int32Array([0, 1]),
    mode1CandidateByCh: new Int32Array([1, 0]),
    coreMode: 0x19,
    channelCount: 2,
    bandCount: 6,
    encodeFlagD0: 1,
    encodeFlags: 0x20,
  });

  assert.equal(config.localMode, 3);
  assert.equal(config.globalFlag, 1);
  assert.equal(config.globalBandCount, 2);
  assert.equal(config.encodeFlags, 0x20);
  assert.deepEqual(Array.from(config.resolvedModeByCh), [1, 2]);
});

test("resolveGhwaveModeConfigAt5 reuses the resolvedModeByCh scratch array", () => {
  const resolvedModeByCh = new Int32Array([7, 9]);
  const config = resolveGhwaveModeConfigAt5({
    selectedModeByCh: new Int32Array([1, 0]),
    mode2CandidateByCh: new Int32Array(2),
    mode1CandidateByCh: new Int32Array([1, 0]),
    coreMode: 0x13,
    channelCount: 1,
    bandCount: 5,
    encodeFlagD0: 0,
    encodeFlags: 0x8,
    resolvedModeByCh,
  });

  assert.equal(config.resolvedModeByCh, resolvedModeByCh);
  assert.deepEqual(Array.from(config.resolvedModeByCh), [1, 0]);
});

test("computeSineExtractAllocationsAt5 preserves stereo split and joint-band suppression", () => {
  const allocations = computeSineExtractAllocationsAt5(
    0x0d,
    2,
    3,
    new Float32Array([1, 4, 8]),
    new Int32Array([2, 1, 0]),
    new Int32Array([0, 1, 0])
  );

  assert.deepEqual(Array.from(allocations[0].slice(0, 3)), [1, 10, 15]);
  assert.deepEqual(Array.from(allocations[1].slice(0, 3)), [0, 0, 14]);
});

test("computeSineExtractAllocationsAt5 preserves the zero-budget low-core fallback", () => {
  const allocations = computeSineExtractAllocationsAt5(
    0x0a,
    2,
    3,
    new Float32Array([4, 8, 16]),
    new Int32Array([2, 1, 0]),
    new Int32Array(16)
  );

  assert.deepEqual(Array.from(allocations[0].slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(allocations[1].slice(0, 3)), [0, 0, 0]);
});

test("computeSineExtractAllocationsAt5 reuses cached scratch buffers", () => {
  const sineAllocations = [new Int32Array(16).fill(7), new Int32Array(16).fill(9)];
  const sineBandWeights = new Float32Array(16).fill(5);
  const work = { sineAllocations, sineBandWeights };

  const allocations = computeSineExtractAllocationsAt5(
    0x0d,
    2,
    3,
    new Float32Array([1, 4, 8]),
    new Int32Array([2, 1, 0]),
    new Int32Array([0, 1, 0]),
    work
  );

  assert.equal(allocations, sineAllocations);
  assert.equal(work.sineBandWeights, sineBandWeights);
  assert.deepEqual(Array.from(allocations[0].slice(0, 3)), [1, 10, 15]);
  assert.deepEqual(Array.from(allocations[1].slice(0, 3)), [0, 0, 14]);
});

test("extractGhwaveAt5 reuses cached ghwave general scratch in the runtime path", () => {
  const generalWork = {
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
  const currentGlobal = {
    enabled: 0,
    flag: 0,
    bandCount: 1,
    jointFlags: new Int32Array(16),
    mixFlags: new Int32Array(16),
    entriesU32: new Uint32Array(48 * 4),
  };
  const previousGlobal = { flag: 0 };
  const currentSlot = createAnalysisSlot(currentGlobal);
  const previousSlot = createAnalysisSlot(previousGlobal);
  const channelEntries = [
    {
      shared: { encodeFlagD0: 1, encodeFlags: 0 },
      sharedAux: { scratch: { ghwave: { generalWork } } },
      slots: [null, null, null, previousSlot, currentSlot],
    },
  ];
  const analysisPtrs = new Array(16).fill(null);
  analysisPtrs[0] = createSineBand(12, 2.0);
  analysisPtrs[1] = createSineBand(20, 2.0);
  analysisPtrs[2] = createSineBand(32, 1.0);

  extractGhwaveAt5(channelEntries, analysisPtrs, 0, 0x13, 3, 1, null);

  assert.equal(currentGlobal.enabled, 1);
  assert.ok(generalWork.window.some((value) => value !== 5));
  assert.ok(generalWork.spectrumMix.some((value) => value !== 9));
  assert.ok(generalWork.freqMask.some((value) => value !== 15));
  assert.ok(generalWork.scanBuf.some((value) => value !== 17));
  assert.ok(generalWork.scanSpectrum.some((value) => value !== 21));
  assert.ok(generalWork.entryMagnitudes.some((value) => value !== 23));
  assert.ok(generalWork.entryPhases.some((value) => value !== 25));
  assert.ok(generalWork.entryFrequencies.some((value) => value !== 27));
});
