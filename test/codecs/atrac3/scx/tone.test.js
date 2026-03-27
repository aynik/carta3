import assert from "node:assert/strict";
import test from "node:test";

import { createAt3ScxHuffTableSets } from "../../../../src/atrac3/scx/huffman.js";
import { extractToneSpecs, quantAt3, quantToneSpecs } from "../../../../src/atrac3/scx/tone.js";

function createToneContext() {
  const { huffTablesA, huffTablesB } = createAt3ScxHuffTableSets();
  return {
    huffman: {
      pair: huffTablesA,
      scalar: huffTablesB,
    },
  };
}

test("quantAt3 preserves current rounding and clamping behavior", () => {
  assert.equal(quantAt3(0.5, 2, 7), 2);
  assert.equal(quantAt3(-3.5, 2, 7), -7);
  assert.equal(quantAt3(100, 2, 7), 7);
});

test("quantToneSpecs and extractToneSpecs preserve current tone quantization behavior", () => {
  const ctx = createToneContext();
  const specs = Float32Array.from(
    { length: 1024 },
    (_, index) => ({ 10: 1.5, 11: -0.8, 12: 0.4, 13: -0.2 })[index] ?? 0
  );
  const tone = {
    twiddleId: 2,
    start: 10,
    huffTableBaseIndex: 2,
    huffTableSetIndex: 0,
    coefficients: new Int32Array(8),
    scaleFactorIndex: 0,
  };

  assert.equal(quantToneSpecs(specs, tone, ctx), 21);
  assert.equal(tone.scaleFactorIndex, 17);
  assert.deepEqual(Array.from(tone.coefficients), [2, -1, 1, 0, 0, 0, 0, 0]);

  const out = Float32Array.from(specs);
  assert.equal(extractToneSpecs(tone, out), 0);
  assert.deepEqual(
    Array.from(out.slice(8, 16)),
    [
      0, 0, 0.23007917404174805, -0.16503959894180298, -0.2349604070186615, -0.20000000298023224, 0,
      0,
    ]
  );
});

test("quantToneSpecs preserves current invalid-width and boundary handling", () => {
  const ctx = createToneContext();
  const specs = Float32Array.from({ length: 1024 }, (_, index) => (index === 1023 ? 2 : 0));

  const invalidTone = {
    twiddleId: 99,
    start: 0,
    huffTableBaseIndex: 1,
    huffTableSetIndex: 0,
    coefficients: new Int32Array(8),
  };
  assert.equal(quantToneSpecs(specs, invalidTone, ctx), -32768);

  const invalidTableTone = {
    twiddleId: 1,
    start: 0,
    huffTableBaseIndex: 1,
    huffTableSetIndex: 9,
    coefficients: new Int32Array(8),
    scaleFactorIndex: 99,
  };
  assert.equal(quantToneSpecs(specs, invalidTableTone, ctx), -32768);
  assert.equal(invalidTableTone.scaleFactorIndex, 0);

  const edgeTone = {
    twiddleId: 1,
    start: 1023,
    huffTableBaseIndex: 1,
    huffTableSetIndex: 0,
    coefficients: new Int32Array(8),
  };
  assert.equal(quantToneSpecs(specs, edgeTone, ctx), 16);
  assert.equal(edgeTone.scaleFactorIndex, 19);
  assert.deepEqual(Array.from(edgeTone.coefficients), [1, 0, 0, 0, 0, 0, 0, 0]);

  const out = Float32Array.from(specs);
  assert.equal(extractToneSpecs(edgeTone, out), 0);
  assert.deepEqual(Array.from(out.slice(1020)), [0, 0, 0, 0.3201052248477936]);

  edgeTone.scaleFactorIndex = 99;
  assert.equal(extractToneSpecs(edgeTone, Float32Array.from(specs)), -1);
});

test("quantToneSpecs preserves the current out-of-range tone tail handling", () => {
  const ctx = createToneContext();
  const specs = Float32Array.from(
    { length: 1024 },
    (_, index) => ({ 1022: 1.5, 1023: -0.8 })[index] ?? 0
  );
  const tone = {
    twiddleId: 3,
    start: 1022,
    huffTableBaseIndex: 1,
    huffTableSetIndex: 0,
    coefficients: new Int32Array(8),
    scaleFactorIndex: 0,
  };

  assert.equal(quantToneSpecs(specs, tone, ctx), 18);
  assert.equal(tone.scaleFactorIndex, 17);
  assert.deepEqual(Array.from(tone.coefficients), [1, -1, 0, 0, 0, 0, 0, 0]);

  const out = Float32Array.from(specs);
  assert.equal(extractToneSpecs(tone, out), 0);
  assert.deepEqual(Array.from(out.slice(1020)), [0, 0, 0.44173264503479004, 0.258267343044281]);
});

test("quantToneSpecs preserves the current partial tail clearing behavior", () => {
  const ctx = createToneContext();
  const specs = Float32Array.from(
    { length: 1024 },
    (_, index) => ({ 1022: 1.5, 1023: -0.8 })[index] ?? 0
  );
  const tone = {
    twiddleId: 3,
    start: 1022,
    huffTableBaseIndex: 1,
    huffTableSetIndex: 0,
    coefficients: Int32Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
    scaleFactorIndex: 0,
  };

  assert.equal(quantToneSpecs(specs, tone, ctx), 18);
  assert.deepEqual(Array.from(tone.coefficients), [1, -1, 0, 0, 9, 9, 9, 9]);
});
