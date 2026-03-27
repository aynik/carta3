import assert from "node:assert/strict";
import test from "node:test";

import { runSineModeExtractionAt5 } from "../../../src/atrac3plus/ghwave/extract.js";

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

test("runSineModeExtractionAt5 preserves joint-band mirrored state and peak bins", () => {
  const currentGlobal = {
    bandCount: 1,
    jointFlags: new Int32Array([1]),
    mixFlags: new Int32Array([0]),
    entriesU32: new Uint32Array(48 * 4),
  };
  const previousSlots = [createAnalysisSlot(), createAnalysisSlot()];
  const currentSlots = [createAnalysisSlot(currentGlobal), createAnalysisSlot(currentGlobal)];
  const peakBinsByCh = [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)];
  const analysisPtrs = new Array(32).fill(null);

  analysisPtrs[0] = createSineBand(12);
  analysisPtrs[16] = createSineBand(12);

  runSineModeExtractionAt5({
    analysisPtrs,
    analysisBase: 0,
    bandCount: 1,
    channelCount: 2,
    bandOrder: new Int32Array([0]),
    bandPowerSum: new Float32Array([8]),
    previousSlots,
    currentSlots,
    currentGlobal,
    peakBinsByCh,
    shared: { encodeFlagD0: 1 },
    coreMode: 0x0d,
  });

  const primaryState = currentSlots[0].records[0];
  const mirroredState = currentSlots[1].records[0];

  assert.equal(peakBinsByCh[0][0], 12);
  assert.equal(peakBinsByCh[1][0], 12);
  assert.equal(primaryState.count, 1);
  assert.equal(mirroredState.count, 1);
  assert.equal(primaryState.start, 0);
  assert.equal(primaryState.end, 256);
  assert.equal(mirroredState.start, 0);
  assert.equal(mirroredState.end, 256);
  assert.equal(mirroredState.entries, primaryState.entries);
  assert.deepEqual(Array.from(currentGlobal.entriesU32.slice(0, 4)), [3, 0, 0, 96]);
});

test("runSineModeExtractionAt5 reuses caller-owned scratch buffers for joint peak analysis", () => {
  const currentGlobal = {
    bandCount: 1,
    jointFlags: new Int32Array([1]),
    mixFlags: new Int32Array([0]),
    entriesU32: new Uint32Array(48 * 4),
  };
  const previousSlots = [createAnalysisSlot(), createAnalysisSlot()];
  const currentSlots = [createAnalysisSlot(currentGlobal), createAnalysisSlot(currentGlobal)];
  const peakBinsByCh = [new Int32Array(16).fill(-1), new Int32Array(16).fill(-1)];
  const analysisPtrs = new Array(32).fill(null);
  const scratch = {
    peakWindow: new Float32Array(256).fill(5),
    peakMixed: new Float32Array(256).fill(7),
    peakSpec: new Float32Array(132).fill(9),
  };

  analysisPtrs[0] = createSineBand(12);
  analysisPtrs[16] = createSineBand(12);

  runSineModeExtractionAt5({
    analysisPtrs,
    analysisBase: 0,
    bandCount: 1,
    channelCount: 2,
    bandOrder: new Int32Array([0]),
    bandPowerSum: new Float32Array([8]),
    previousSlots,
    currentSlots,
    currentGlobal,
    peakBinsByCh,
    scratch,
    shared: { encodeFlagD0: 1 },
    coreMode: 0x0d,
  });

  assert.equal(peakBinsByCh[0][0], 12);
  assert.equal(peakBinsByCh[1][0], 12);
  assert.ok(scratch.peakWindow.some((value) => value !== 5));
  assert.ok(scratch.peakMixed.some((value) => value !== 7));
  assert.ok(scratch.peakSpec.some((value) => value !== 9));
});
