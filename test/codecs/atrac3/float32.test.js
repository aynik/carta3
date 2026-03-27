import assert from "node:assert/strict";
import test from "node:test";

import { bitsToFloat32 } from "../../../src/atrac3/float32.js";

test("bitsToFloat32 decodes normal values, infinities, NaN, and signed zero", () => {
  assert.equal(bitsToFloat32(0x3f800000), 1);
  assert.equal(bitsToFloat32(0xbf800000), -1);
  assert.equal(bitsToFloat32(0x7f800000), Infinity);
  assert.equal(bitsToFloat32(0xff800000), -Infinity);
  assert.equal(Object.is(bitsToFloat32(0x00000000), 0), true);
  assert.equal(Object.is(bitsToFloat32(0x80000000), -0), true);
  assert.equal(Number.isNaN(bitsToFloat32(0x7fc00000)), true);
});

test("bitsToFloat32 preserves denormalized values", () => {
  assert.equal(bitsToFloat32(0x00000001), 2 ** -149);
  assert.equal(bitsToFloat32(0x00000002), 2 ** -148);
  assert.equal(bitsToFloat32(0x007fffff), 2 ** -149 * 0x7fffff);
  assert.equal(bitsToFloat32(0x80000001), -(2 ** -149));
});
