import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisGeneralAt5Sub,
  finalizeGeneralEntriesAt5,
} from "../../../src/atrac3plus/ghwave/general.js";

function analyzeSine(freq, amplitude, flag) {
  const src = new Float32Array(0x100);
  for (let i = 0; i < src.length; i += 1) {
    src[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / src.length);
  }

  const state = {
    start: 0,
    end: src.length,
    entries: new Uint32Array(64),
    count: 0,
  };
  const weights = new Float32Array(0x81).fill(1);

  analysisGeneralAt5Sub(src, state, flag, freq, weights, 4, 0, 0);
  return {
    count: state.count,
    entries: Array.from(state.entries.slice(0, state.count * 4)),
  };
}

test("analysisGeneralAt5Sub preserves paired GHA index selection in flag-1 mode", () => {
  assert.deepEqual(analyzeSine(8, 0.5, 1), { count: 1, entries: [0, 0, 0, 64] });
  assert.deepEqual(analyzeSine(8, 0.75, 1), { count: 1, entries: [1, 0, 0, 64] });
  assert.deepEqual(analyzeSine(8, 1, 1), { count: 1, entries: [3, 0, 0, 64] });
  assert.deepEqual(analyzeSine(8, 1.25, 1), { count: 1, entries: [4, 0, 0, 64] });
  assert.deepEqual(analyzeSine(8, 1.5, 1), { count: 1, entries: [5, 0, 0, 64] });
  assert.deepEqual(analyzeSine(8, 2, 1), { count: 1, entries: [7, 0, 0, 64] });
});

test("analysisGeneralAt5Sub preserves paired AMP index selection in flag-0 mode", () => {
  assert.deepEqual(analyzeSine(8, 0.5, 0), { count: 0, entries: [] });
  assert.deepEqual(analyzeSine(8, 0.75, 0), { count: 1, entries: [1, 15, 0, 64] });
  assert.deepEqual(analyzeSine(8, 1, 0), { count: 1, entries: [3, 14, 0, 64] });
  assert.deepEqual(analyzeSine(8, 1.25, 0), { count: 1, entries: [4, 15, 0, 64] });
  assert.deepEqual(analyzeSine(8, 2, 0), { count: 1, entries: [7, 14, 0, 64] });
});

test("finalizeGeneralEntriesAt5 drops muted flag-0 rows and sorts by encoded frequency", () => {
  const entries = new Uint32Array([2, -1 >>> 0, 9, 90, 3, 5, 8, 70, 0, 4, 7, 60, 4, 0, 6, 80]);

  assert.equal(finalizeGeneralEntriesAt5(entries, 4, 0), 2);
  assert.deepEqual(Array.from(entries.slice(0, 8)), [3, 5, 8, 70, 4, 0, 6, 80]);
});

test("finalizeGeneralEntriesAt5 keeps all flag-1 rows and preserves equal-frequency order", () => {
  const entries = new Uint32Array([7, 0, 0, 90, 5, 1, 0, 40, 6, 2, 0, 40]);

  assert.equal(finalizeGeneralEntriesAt5(entries, 3, 1), 3);
  assert.deepEqual(Array.from(entries.slice(0, 12)), [5, 1, 0, 40, 6, 2, 0, 40, 7, 0, 0, 90]);
});
