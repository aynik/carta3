import assert from "node:assert/strict";
import test from "node:test";

import { fineAnalysisAt5 } from "../../../src/atrac3plus/ghwave/component.js";

function createSineWave(frequencyBin, amplitude, phase = 0) {
  const samples = new Float32Array(0x100);
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    samples[sampleIndex] =
      amplitude * Math.sin((2 * Math.PI * frequencyBin * sampleIndex) / samples.length + phase);
  }
  return samples;
}

test("fineAnalysisAt5 preserves exact-bin phase mapping across quarter turns", () => {
  const expectedPhases = new Map([
    [0, 0],
    [Math.PI / 4, 256],
    [Math.PI / 2, 512],
    [Math.PI, 1024],
  ]);

  for (const [inputPhase, encodedPhase] of expectedPhases) {
    const result = fineAnalysisAt5(createSineWave(8, 1, inputPhase), 8, 0, 0x100);
    assert.ok(result);
    assert.equal(result.frequency, 64);
    assert.equal(result.phase, encodedPhase);
    assert.ok(Math.abs(result.magnitude - 1) < 1e-6);
  }
});

test("fineAnalysisAt5 preserves windowed fine-frequency refinement", () => {
  const result = fineAnalysisAt5(createSineWave(17, 1, Math.PI), 17, 32, 160);

  assert.ok(result);
  assert.equal(result.frequency, 136);
  assert.equal(result.phase, 0);
  assert.ok(Math.abs(result.magnitude - 1) < 1e-6);
});

test("fineAnalysisAt5 handles unaligned start/end DC windows", () => {
  const samples = new Float32Array(0x100);
  const sampleStart = 33;
  const sampleEnd = 162;
  for (let sampleIndex = sampleStart; sampleIndex < sampleEnd; sampleIndex += 1) {
    samples[sampleIndex] = 1;
  }
  samples[sampleEnd] = 1000;
  samples[sampleEnd + 1] = 1000;
  samples[sampleEnd + 2] = 1000;

  const result = fineAnalysisAt5(samples, 0, sampleStart, sampleEnd);
  assert.ok(result);
  assert.equal(result.frequency, 0);
  assert.ok(Math.abs(result.magnitude - 1) < 1e-6);
});
