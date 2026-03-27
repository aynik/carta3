import assert from "node:assert/strict";
import test from "node:test";

import * as BitstreamInternal from "../../../src/atrac3plus/bitstream/internal.js";

test("AT5 packSym fails when Huffman codes are missing", () => {
  const dst = new Uint8Array(4);
  const bitState = { bitpos: 0 };

  assert.equal(BitstreamInternal.at5PackSym(null, 0, dst, bitState), false);
});

test("AT5 packSym fails when the selected symbol has a zero code length", () => {
  const dst = new Uint8Array(4);
  const bitState = { bitpos: 0 };
  const desc = { codes: new Uint8Array([0, 0, 0, 0]) };

  assert.equal(BitstreamInternal.at5PackSym(desc, 0, dst, bitState), false);
});

test("AT5 packSym packs the configured codeword MSB-first", () => {
  const dst = new Uint8Array(1);
  const bitState = { bitpos: 0 };
  const desc = { codes: new Uint8Array([0b00000101, 0, 3, 0]) };

  assert.equal(BitstreamInternal.at5PackSym(desc, 0, dst, bitState), true);
  assert.equal(bitState.bitpos, 3);
  assert.equal(dst[0], 0b10100000);
});

test("AT5 packStoreFromMsb overwrites bits in reused buffers", () => {
  const dst = new Uint8Array([0xff]);
  const bitState = { bitpos: 0 };

  assert.equal(BitstreamInternal.at5PackStoreFromMsb(0b101, 3, dst, bitState), true);
  assert.equal(bitState.bitpos, 3);
  assert.equal(dst[0], 0b10111111);
});

test("AT5 packStoreFromMsb clears bits across byte boundaries", () => {
  const dst = new Uint8Array([0xff, 0xff]);
  const bitState = { bitpos: 7 };

  assert.equal(BitstreamInternal.at5PackStoreFromMsb(0, 2, dst, bitState), true);
  assert.equal(bitState.bitpos, 9);
  assert.deepEqual(Array.from(dst), [0b11111110, 0b01111111]);
});
