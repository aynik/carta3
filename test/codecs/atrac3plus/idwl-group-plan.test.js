import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIdwlGroupPlans,
  buildIdwlRowGroupPlans,
  calcNbitsForIdwl4At5,
  calcNbitsForIdwl5At5,
  findCheapestIdwlGroupPlan,
  findCheapestPositiveIdwlGroupPlan,
  findCheapestPositiveIdwlRowPlan,
} from "../../../src/atrac3plus/bitstream/internal.js";
import { createAt5IdwlScratch } from "../../../src/atrac3plus/channel-block/construction.js";

function createScratch() {
  const scratch = createAt5IdwlScratch(new Uint8Array(0x290));
  return scratch;
}

function createStereoDeltaChannel(values, baseValues, bandLimit = values.length) {
  return {
    channelIndex: 1,
    shared: { bandLimit },
    idwl: { values: Int32Array.from(values) },
    block0: {
      idwl: { values: Int32Array.from(baseValues) },
    },
  };
}

test("buildIdwlGroupPlans reuses mapped raw plans but reapplies per-group header costs", () => {
  const scratch = createScratch();
  scratch.bandCountBySlot.set([4, 4, 2, 1]);
  scratch.mappedGroupBySlot.set([-1, 0, -1, -1]);

  const visitedGroups = [];
  const plans = buildIdwlGroupPlans(scratch, 8, 1, (group) => {
    visitedGroups.push(group);
    return {
      rawCost: [6, 0, 7, 2][group] | 0,
      tag: `group-${group}`,
    };
  });

  assert.deepEqual(visitedGroups, [0, 2, 3]);
  assert.deepEqual(
    plans.map((plan) => ({
      tag: plan.tag,
      rawCost: plan.rawCost,
      adjustedCost: plan.adjustedCost,
    })),
    [
      { tag: "group-0", rawCost: 6, adjustedCost: 6 },
      { tag: "group-0", rawCost: 6, adjustedCost: 11 },
      { tag: "group-2", rawCost: 7, adjustedCost: 18 },
      { tag: "group-3", rawCost: 2, adjustedCost: 9 },
    ]
  );
});

test("buildIdwlRowGroupPlans scopes mapped-plan reuse to the requested row", () => {
  const scratch = createScratch();
  scratch.bandCountBySlot.set([9, 8, 7, 6, 4, 4, 2, 1]);
  scratch.mappedGroupBySlot.set([-1, -1, -1, -1, -1, 0, -1, -1]);

  const visitedGroups = [];
  const plans = buildIdwlRowGroupPlans(scratch, 1, 8, 1, (group) => {
    visitedGroups.push(group);
    return {
      rawCost: [6, 0, 7, 2][group] | 0,
      tag: `row1-group-${group}`,
    };
  });

  assert.deepEqual(visitedGroups, [0, 2, 3]);
  assert.deepEqual(
    plans.map((plan) => ({
      tag: plan.tag,
      rawCost: plan.rawCost,
      adjustedCost: plan.adjustedCost,
    })),
    [
      { tag: "row1-group-0", rawCost: 6, adjustedCost: 6 },
      { tag: "row1-group-0", rawCost: 6, adjustedCost: 11 },
      { tag: "row1-group-2", rawCost: 7, adjustedCost: 18 },
      { tag: "row1-group-3", rawCost: 2, adjustedCost: 9 },
    ]
  );
});

test("findCheapestIdwlGroupPlan keeps group 0 when later groups only add selector headers", () => {
  const bestPlan = findCheapestIdwlGroupPlan([
    { group: 0, rawCost: 0, adjustedCost: 0 },
    { group: 1, rawCost: 0, adjustedCost: 5 },
    { group: 2, rawCost: 0, adjustedCost: 9 },
    { group: 3, rawCost: 0, adjustedCost: 7 },
  ]);

  assert.equal(bestPlan.group, 0);
  assert.equal(bestPlan.adjustedCost, 0);
});

test("findCheapestPositiveIdwlGroupPlan ignores zero-cost groups and returns the cheapest valid plan", () => {
  const bestPlan = findCheapestPositiveIdwlGroupPlan([
    { group: 0, rawCost: 0, adjustedCost: 0 },
    { group: 1, rawCost: 3, adjustedCost: 8 },
    { group: 2, rawCost: 2, adjustedCost: 5 },
    { group: 3, rawCost: 0, adjustedCost: 7 },
  ]);

  assert.equal(bestPlan.group, 2);
  assert.equal(bestPlan.adjustedCost, 5);
});

test("findCheapestPositiveIdwlRowPlan scans all row groups by adjusted cost and keeps row 0 as fallback", () => {
  const best = findCheapestPositiveIdwlRowPlan([
    [
      { row: 0, group: 0, adjustedCost: 11 },
      { row: 0, group: 1, adjustedCost: 13 },
    ],
    [
      { row: 1, group: 0, adjustedCost: 7 },
      { row: 1, group: 1, adjustedCost: 9 },
    ],
    null,
    [{ row: 3, group: 0, adjustedCost: 8 }],
  ]);

  assert.equal(best.row, 1);
  assert.equal(best.plan.group, 0);
  assert.equal(best.plan.adjustedCost, 7);

  const fallback = findCheapestPositiveIdwlRowPlan([[{ row: 0, group: 0, adjustedCost: 0 }]]);
  assert.equal(fallback.row, 0);
  assert.equal(fallback.plan.group, 0);
  assert.equal(fallback.plan.adjustedCost, 0);
});

test("calcNbitsForIdwl4At5 keeps group 0 as the cheapest flat stereo delta anchor", () => {
  const scratch = createScratch();
  scratch.bandCountBySlot.set([6, 3, 2, 1]);
  scratch.mappedGroupBySlot.set([-1, -1, -1, -1]);
  scratch.extraWordByIndex[0] = 5;

  const channel = createStereoDeltaChannel([2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2]);

  const bits = calcNbitsForIdwl4At5(channel, scratch);

  assert.equal(bits, 10);
  assert.deepEqual(Array.from(scratch.slot1Config), [0, 0, 6, 5, 0]);
});

test("calcNbitsForIdwl5At5 keeps group 0 as the cheapest flat chained stereo delta anchor", () => {
  const scratch = createScratch();
  scratch.bandCountBySlot.set([6, 3, 2, 1]);
  scratch.mappedGroupBySlot.set([-1, -1, -1, -1]);
  scratch.extraWordByIndex[0] = 4;

  const channel = createStereoDeltaChannel([3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3]);

  const bits = calcNbitsForIdwl5At5(channel, scratch);

  assert.equal(bits, 10);
  assert.deepEqual(Array.from(scratch.slot2Config), [0, 0, 6, 4, 0]);
});
