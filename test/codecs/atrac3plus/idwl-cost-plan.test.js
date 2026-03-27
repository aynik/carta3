import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveIncrementalIdwlCostPlan,
  resolveInitialIdwlCostPlan,
  selectLowestIdwlCostSlot,
} from "../../../src/atrac3plus/bitstream/internal.js";

test("resolveInitialIdwlCostPlan names the primary and stereo candidate slots", () => {
  assert.deepEqual(resolveInitialIdwlCostPlan(0, 0), {
    slot1: "mode1",
    slot2: "mode2",
    slot3: "mode3",
  });
  assert.deepEqual(resolveInitialIdwlCostPlan(2, 0), {
    slot1: null,
    slot2: "mode2",
    slot3: "mode3",
  });
  assert.deepEqual(resolveInitialIdwlCostPlan(0, 1), {
    slot1: "mode4",
    slot2: "mode2",
    slot3: "mode3",
  });
});

test("resolveIncrementalIdwlCostPlan names the current channel's candidate refreshes", () => {
  assert.deepEqual(resolveIncrementalIdwlCostPlan(0, 0, 0), {
    slot1: "mode1",
    slot2: "mode2",
    slot3: "mode3",
  });
  assert.deepEqual(resolveIncrementalIdwlCostPlan(2, 0, 0), {
    slot1: null,
    slot2: null,
    slot3: "mode3",
  });
  assert.deepEqual(resolveIncrementalIdwlCostPlan(0, 0, 1), {
    slot1: null,
    slot2: null,
    slot3: null,
  });
  assert.deepEqual(resolveIncrementalIdwlCostPlan(0, 1, 0), {
    slot1: "mode4",
    slot2: "mode5",
    slot3: null,
  });
  assert.deepEqual(resolveIncrementalIdwlCostPlan(0, 1, 1), {
    slot1: "mode4",
    slot2: "mode5",
    slot3: "mode3",
  });
  assert.deepEqual(resolveIncrementalIdwlCostPlan(2, 1, 1), {
    slot1: "mode4",
    slot2: "mode5",
    slot3: "mode3",
  });
});

test("selectLowestIdwlCostSlot preserves the first matching slot on ties", () => {
  assert.deepEqual(selectLowestIdwlCostSlot(Int32Array.from([12, 8, 8, 9])), {
    bestConfigSlot: 1,
    bestValue: 8,
  });
  assert.deepEqual(selectLowestIdwlCostSlot(Int32Array.from([3, 4, 5, 6])), {
    bestConfigSlot: 0,
    bestValue: 3,
  });
});
