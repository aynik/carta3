import assert from "node:assert/strict";
import test from "node:test";

import { roundDivU32, roundToEvenI32 } from "../../src/common/math.js";

test("roundDivU32 preserves unsigned rounded integer division", () => {
  assert.equal(roundDivU32(5, 2), 3);
  assert.equal(roundDivU32(7, 3), 2);
  assert.throws(() => roundDivU32(Number.NaN, 2), /invalid numerator/);
  assert.throws(() => roundDivU32(-1, 2), /invalid numerator/);
  assert.throws(() => roundDivU32(5, 0), /invalid denom/);
  assert.throws(() => roundDivU32(5, -1), /invalid denom/);
});

test("roundToEvenI32 preserves bankers rounding and non-finite fallback", () => {
  assert.equal(roundToEvenI32(2.5), 2);
  assert.equal(roundToEvenI32(3.5), 4);
  assert.equal(roundToEvenI32(-2.5), -2);
  assert.equal(roundToEvenI32(-3.5), -4);
  assert.equal(roundToEvenI32(Number.NaN), 0);
  assert.equal(roundToEvenI32(Number.POSITIVE_INFINITY), 0);
});
