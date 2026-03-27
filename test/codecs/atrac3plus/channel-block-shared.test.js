import assert from "node:assert/strict";
import test from "node:test";

import {
  at5GainCountsEqualToBase,
  at5GainIdlevLevelsEqualToBase,
  at5GainIdlocPrefixEqualToBase,
} from "../../../src/atrac3plus/channel-block/metadata.js";

function createGainRecord(entries, levels = [], locations = []) {
  return {
    entries,
    levels: Uint32Array.from(levels),
    locations: Uint32Array.from(locations),
  };
}

function createGainChannel(records, baseRecords, activeCount = records.length) {
  return {
    gain: {
      activeCount,
      records,
    },
    block0: {
      gain: {
        records: baseRecords,
      },
    },
  };
}

test("at5GainCountsEqualToBase matches active gain entry counts", () => {
  const matching = createGainChannel(
    [createGainRecord(2), createGainRecord(1)],
    [createGainRecord(2), createGainRecord(1)]
  );
  const mismatched = createGainChannel(
    [createGainRecord(2), createGainRecord(0)],
    [createGainRecord(2), createGainRecord(1)]
  );

  assert.equal(at5GainCountsEqualToBase(matching), 1);
  assert.equal(at5GainCountsEqualToBase(mismatched), 0);
});

test("at5GainIdlevLevelsEqualToBase uses default level 7 beyond the base record", () => {
  const matching = createGainChannel(
    [createGainRecord(3, [6, 7, 7])],
    [createGainRecord(2, [6, 7])]
  );
  const mismatched = createGainChannel(
    [createGainRecord(3, [6, 7, 6])],
    [createGainRecord(2, [6, 7])]
  );

  assert.equal(at5GainIdlevLevelsEqualToBase(matching), 1);
  assert.equal(at5GainIdlevLevelsEqualToBase(mismatched), 0);
});

test("at5GainIdlocPrefixEqualToBase compares only the shared location prefix", () => {
  const matching = createGainChannel(
    [createGainRecord(3, [0, 0, 0], [1, 4, 7])],
    [createGainRecord(2, [0, 0], [1, 4])]
  );
  const mismatched = createGainChannel(
    [createGainRecord(3, [0, 0, 0], [1, 5, 7])],
    [createGainRecord(2, [0, 0], [1, 4])]
  );

  assert.equal(at5GainIdlocPrefixEqualToBase(matching), 1);
  assert.equal(at5GainIdlocPrefixEqualToBase(mismatched), 0);
});
