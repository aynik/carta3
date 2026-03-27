import assert from "node:assert/strict";
import test from "node:test";

import { createAt3ScxHuffTableSets } from "../../../../src/atrac3/scx/huffman.js";
import { quantNontoneNspecs } from "../../../../src/atrac3/scx/quant.js";

function createQuantContext() {
  const { huffTablesA, huffTablesB } = createAt3ScxHuffTableSets();
  return {
    huffman: {
      pair: huffTablesA,
      scalar: huffTablesB,
    },
  };
}

test("quantNontoneNspecs preserves zero-idwl fast path and encoded bit counts", () => {
  const ctx = createQuantContext();

  const zeroOut = new Int32Array(4);
  assert.equal(
    quantNontoneNspecs(0, 0, 0.1, 4, Float32Array.of(0, 0.2, -0.4, 1.5), zeroOut, ctx),
    0
  );
  assert.deepEqual(Array.from(zeroOut), [0, 0, 0, 0]);

  const out = new Int32Array(4);
  assert.equal(quantNontoneNspecs(0, 1, 0.1, 4, Float32Array.of(0, 0.2, -0.4, 1.5), out, ctx), 12);
  assert.deepEqual(Array.from(out), [0, 0, -1, 1]);
});

test("quantNontoneNspecs preserves current invalid-input error returns", () => {
  const ctx = createQuantContext();
  const invalidIdwlOut = Int32Array.from([9, 9, 9]);
  const invalidTableOut = new Int32Array(3);
  const invalidContextOut = new Int32Array(3);

  assert.equal(
    quantNontoneNspecs(0, 99, 0, 3, Float32Array.of(1, 2, 3), invalidIdwlOut, ctx),
    -32768
  );
  assert.deepEqual(Array.from(invalidIdwlOut), [9, 9, 9]);

  assert.equal(
    quantNontoneNspecs(9, 1, 0, 3, Float32Array.of(1, 2, 3), invalidTableOut, ctx),
    -32768
  );
  assert.deepEqual(Array.from(invalidTableOut), [1, 1, 1]);

  assert.equal(
    quantNontoneNspecs(0, 1, 0, 3, Float32Array.of(1, 2, 3), invalidContextOut, null),
    -32768
  );
  assert.deepEqual(Array.from(invalidContextOut), [1, 1, 1]);
});
