import assert from "node:assert/strict";
import test from "node:test";

import { at5MeasurePackBits } from "../../../src/atrac3plus/channel-block/primitives.js";

test("at5MeasurePackBits returns a sentinel when packers fail", () => {
  function packFail(_ctx, _dst, state) {
    state.bitpos = 123;
    return false;
  }

  assert.equal(at5MeasurePackBits(packFail, null), 0x2000 * 8);
});

test("at5MeasurePackBits returns the packed bitpos when packers succeed", () => {
  function packOk(_ctx, _dst, state) {
    state.bitpos = 456;
    return true;
  }

  assert.equal(at5MeasurePackBits(packOk, null), 456);
});
