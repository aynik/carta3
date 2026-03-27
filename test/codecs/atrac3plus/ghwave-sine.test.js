import assert from "node:assert/strict";
import test from "node:test";

import { analysisSineAt5Sub } from "../../../src/atrac3plus/ghwave/sine.js";

function analyzeSineComponents(components, initPeakBin, maxCount = 8) {
  const src = new Float32Array(0x100);
  for (let sampleIndex = 0; sampleIndex < src.length; sampleIndex += 1) {
    let value = 0;
    for (const { frequencyBin, amplitude, phase = 0 } of components) {
      value +=
        amplitude * Math.sin((2 * Math.PI * frequencyBin * sampleIndex) / src.length + phase);
    }
    src[sampleIndex] = value;
  }

  const state = {
    start: 0,
    end: src.length,
    entries: new Uint32Array(64),
    count: 0,
  };

  analysisSineAt5Sub(src, state, initPeakBin, maxCount);
  return {
    count: state.count,
    entries: Array.from(state.entries.slice(0, state.count * 4)),
  };
}

test("analysisSineAt5Sub preserves sorted multi-sine extraction ordering", () => {
  const result = analyzeSineComponents(
    [
      { frequencyBin: 8, amplitude: 2 },
      { frequencyBin: 17, amplitude: 0.75 },
      { frequencyBin: 25, amplitude: 1.25 },
    ],
    8
  );

  assert.deepEqual(result, {
    count: 3,
    entries: [1, 0, 16, 136, 4, 0, 16, 200, 7, 0, 0, 64],
  });
});

test("analysisSineAt5Sub preserves the mismatched-initial-peak fast exit", () => {
  const result = analyzeSineComponents([{ frequencyBin: 17, amplitude: 1.25 }], 8);

  assert.deepEqual(result, {
    count: 0,
    entries: [],
  });
});
