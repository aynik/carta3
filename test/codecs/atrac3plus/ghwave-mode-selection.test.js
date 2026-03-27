import assert from "node:assert/strict";
import test from "node:test";

import {
  at5GhwaveClassifyEnergy,
  at5GhwaveRefineModeCandidatesFromPeaks,
  refineGhwaveModeCandidatesAt5,
} from "../../../src/atrac3plus/ghwave/extract.js";

function createConstantBand(level) {
  return new Float32Array(256).fill(level);
}

function createSineBand(frequencyBin, amplitude = 1, phase = 0) {
  const band = new Float32Array(256);
  for (let sampleIndex = 0; sampleIndex < band.length; sampleIndex += 1) {
    band[sampleIndex] =
      amplitude * Math.sin((2 * Math.PI * frequencyBin * sampleIndex) / band.length + phase);
  }
  return band;
}

function createEnergyScratch() {
  return {
    bandPowerByCh: [new Float32Array(16), new Float32Array(16)],
    bandPowerSum: new Float32Array(16),
    chTotalPower: new Float32Array(2),
    sortedBandsByCh: [new Int32Array(16), new Int32Array(16)],
    bandSortValues: new Float32Array(16),
    selectedModeByCh: new Int32Array(2),
    mode2CandidateByCh: new Int32Array(2),
    mode1CandidateByCh: new Int32Array(2),
  };
}

test("at5GhwaveClassifyEnergy preserves concentrated two-band mode-1 classification", () => {
  const scratch = createEnergyScratch();

  const selected = at5GhwaveClassifyEnergy({
    analysisPtrs: [createConstantBand(8), createConstantBand(8), createConstantBand(0.02)],
    analysisBase: 0,
    bandCount: 3,
    channelCount: 1,
    ...scratch,
    shared: { encodeFlagD0: 1 },
    global: { flag: 99, bandCount: 99 },
  });

  assert.equal(selected, false);
  assert.deepEqual(Array.from(scratch.sortedBandsByCh[0].slice(0, 3)), [0, 1, 2]);
  assert.deepEqual(Array.from(scratch.mode1CandidateByCh), [1, 0]);
  assert.deepEqual(Array.from(scratch.mode2CandidateByCh), [0, 0]);
});

test("at5GhwaveClassifyEnergy preserves the encodeFlagD0 early general fallback", () => {
  const scratch = createEnergyScratch();
  const global = { flag: 99, bandCount: 99 };

  const selected = at5GhwaveClassifyEnergy({
    analysisPtrs: [createConstantBand(4), createConstantBand(2), createConstantBand(1.1)],
    analysisBase: 0,
    bandCount: 3,
    channelCount: 1,
    ...scratch,
    shared: { encodeFlagD0: 0 },
    global,
  });

  assert.equal(selected, true);
  assert.deepEqual(Array.from(scratch.selectedModeByCh), [3, 0]);
  assert.deepEqual(Array.from(scratch.mode1CandidateByCh), [0, 0]);
  assert.deepEqual(Array.from(scratch.mode2CandidateByCh), [0, 0]);
  assert.deepEqual(global, { flag: 0, bandCount: 1 });
});

test("at5GhwaveRefineModeCandidatesFromPeaks rejects mode-1 candidates with distant dominant peaks", () => {
  const sortedBandsByCh = [new Int32Array([0, 1]), new Int32Array(16)];
  const peakBinsByCh = [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)];
  const selectedModeByCh = new Int32Array([3, 0]);
  const mode1CandidateByCh = new Int32Array([1, 0]);
  const mode2CandidateByCh = new Int32Array(2);

  at5GhwaveRefineModeCandidatesFromPeaks({
    analysisPtrs: [createSineBand(8), createSineBand(40)],
    analysisBase: 0,
    bandCount: 2,
    channelCount: 1,
    jointFlags: new Int32Array(16),
    mixFlags: new Int32Array(16),
    sortedBandsByCh,
    chTotalPower: new Float32Array([10, 0]),
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    peakBinsByCh,
    encodeFlags: 0,
  });

  assert.deepEqual(Array.from(peakBinsByCh[0].slice(0, 2)), [8, 40]);
  assert.deepEqual(Array.from(selectedModeByCh), [3, 0]);
  assert.deepEqual(Array.from(mode1CandidateByCh), [0, 0]);
});

test("at5GhwaveRefineModeCandidatesFromPeaks clears mode-2 candidates when no peak is present", () => {
  const peakBinsByCh = [new Int32Array(16).fill(-9), new Int32Array(16).fill(-9)];
  const selectedModeByCh = new Int32Array([3, 0]);
  const mode1CandidateByCh = new Int32Array(2);
  const mode2CandidateByCh = new Int32Array([1, 0]);

  at5GhwaveRefineModeCandidatesFromPeaks({
    analysisPtrs: [new Float32Array(256)],
    analysisBase: 0,
    bandCount: 1,
    channelCount: 1,
    jointFlags: new Int32Array(16),
    mixFlags: new Int32Array(16),
    sortedBandsByCh: [new Int32Array([0]), new Int32Array(16)],
    chTotalPower: new Float32Array([10, 0]),
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    peakBinsByCh,
    encodeFlags: 0,
  });

  assert.equal(peakBinsByCh[0][0], -1);
  assert.deepEqual(Array.from(selectedModeByCh), [0, 0]);
  assert.deepEqual(Array.from(mode2CandidateByCh), [0, 0]);
});

test("refineGhwaveModeCandidatesAt5 zeroes mono joint flags in caller-owned scratch and returns success", () => {
  const scratch = createEnergyScratch();
  const currentGlobal = {
    jointFlags: new Int32Array([9, 9, 9]),
    mixFlags: new Int32Array([7, 7, 7]),
  };

  const ok = refineGhwaveModeCandidatesAt5({
    analysisPtrs: [createConstantBand(8), createConstantBand(8), createConstantBand(0.02)],
    analysisBase: 0,
    bandCount: 3,
    channelCount: 1,
    ...scratch,
    peakBinsByCh: [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)],
    shared: { encodeFlagD0: 1, encodeFlags: 0 },
    currentGlobal,
    scratch: null,
    sharedAux: null,
  });

  assert.equal(ok, true);
  assert.deepEqual(Array.from(currentGlobal.jointFlags.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(currentGlobal.mixFlags.slice(0, 3)), [0, 0, 0]);
});

test("refineGhwaveModeCandidatesAt5 fails when stereo joint buffers are missing", () => {
  const scratch = createEnergyScratch();

  const ok = refineGhwaveModeCandidatesAt5({
    analysisPtrs: [createConstantBand(4), createConstantBand(4)],
    analysisBase: 0,
    bandCount: 1,
    channelCount: 2,
    ...scratch,
    peakBinsByCh: [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)],
    shared: { encodeFlagD0: 1, encodeFlags: 0 },
    currentGlobal: {},
    scratch: null,
    sharedAux: null,
  });

  assert.equal(ok, false);
});

test("refineGhwaveModeCandidatesAt5 preserves inverse-correlation joint mix selection", () => {
  const scratch = createEnergyScratch();
  const analysisPtrs = new Array(32).fill(null);
  analysisPtrs[0] = createSineBand(12, 1, 0);
  analysisPtrs[16] = createSineBand(12, 1, Math.PI);
  const currentGlobal = {
    jointFlags: new Int32Array(16),
    mixFlags: new Int32Array(16),
  };

  const ok = refineGhwaveModeCandidatesAt5({
    analysisPtrs,
    analysisBase: 0,
    bandCount: 1,
    channelCount: 2,
    ...scratch,
    peakBinsByCh: [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)],
    shared: { encodeFlagD0: 1, encodeFlags: 0 },
    currentGlobal,
    scratch: null,
    sharedAux: null,
  });

  assert.equal(ok, true);
  assert.equal(currentGlobal.jointFlags[0], 1);
  assert.equal(currentGlobal.mixFlags[0], 1);
});
