import assert from "node:assert/strict";
import test from "node:test";

import {
  blockChannelsForMode,
  blockCountForMode,
  blockLayoutForMode,
  resolveBlockMode,
} from "../../../src/atrac3plus/topology.js";

test("ATRAC3plus topology exposes explicit per-mode block layouts", () => {
  assert.deepEqual(blockLayoutForMode(5), [
    { blockIndex: 0, channelsInBlock: 2, bitUnits: 2, requestedBlockMode: "primary" },
    { blockIndex: 1, channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
    { blockIndex: 2, channelsInBlock: 2, bitUnits: 2, requestedBlockMode: "primary" },
    { blockIndex: 3, channelsInBlock: 1, bitUnits: 0, requestedBlockMode: 4 },
  ]);
  assert.deepEqual(blockLayoutForMode(7), [
    { blockIndex: 0, channelsInBlock: 2, bitUnits: 2, requestedBlockMode: "primary" },
    { blockIndex: 1, channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
    { blockIndex: 2, channelsInBlock: 2, bitUnits: 2, requestedBlockMode: "primary" },
    { blockIndex: 3, channelsInBlock: 2, bitUnits: 2, requestedBlockMode: "primary" },
    { blockIndex: 4, channelsInBlock: 1, bitUnits: 0, requestedBlockMode: 4 },
  ]);
});

test("ATRAC3plus topology helpers keep block counts, channel counts, and primary block modes aligned", () => {
  assert.equal(blockCountForMode(6), 5);
  assert.deepEqual(blockChannelsForMode(6), [2, 1, 2, 1, 1]);
  assert.equal(resolveBlockMode("primary", 3), 3);
  assert.equal(resolveBlockMode(4, 3), 4);
  assert.deepEqual(blockLayoutForMode(0), []);
});
