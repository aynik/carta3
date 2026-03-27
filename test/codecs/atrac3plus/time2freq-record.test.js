import assert from "node:assert/strict";
import test from "node:test";

import { createAt5EncodeBufRecord } from "../../../src/atrac3plus/time2freq/buf.js";
import { AT5_GAIN_SEGMENTS_MAX } from "../../../src/atrac3plus/time2freq/constants.js";
import {
  at5GainRecordDecrementIndex,
  at5GainRecordMetric,
  at5GainRecordNormalize,
  fillGainParamFromRecord,
} from "../../../src/atrac3plus/time2freq/record.js";

function createRecord(points = [], overrides = {}) {
  const record = createAt5EncodeBufRecord();
  record.entries = points.length;
  for (let i = 0; i < points.length; i += 1) {
    const [location, level] = points[i];
    record.locations[i] = location;
    record.levels[i] = level;
  }
  Object.assign(record, overrides);
  return record;
}

test("fillGainParamFromRecord clamps oversized records to the codec segment budget", () => {
  const record = createRecord(
    [
      [0, 7],
      [1, 8],
      [2, 9],
      [3, 10],
      [4, 11],
      [5, 12],
      [6, 13],
    ],
    { entries: AT5_GAIN_SEGMENTS_MAX + 2 }
  );

  const params = fillGainParamFromRecord(record, new Uint32Array(16));

  assert.equal(params[0], AT5_GAIN_SEGMENTS_MAX);
  assert.deepEqual(Array.from(params.slice(1, 8)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(params.slice(8, 15)), [7, 8, 9, 10, 11, 12, 13]);
  assert.equal(params[15], 0);
});

test("at5GainRecordNormalize keeps the last point in a same-level run and trims a trailing neutral level", () => {
  const record = createRecord([
    [1, 8],
    [3, 8],
    [5, 6],
  ]);

  at5GainRecordNormalize(record);

  assert.equal(record.entries, 1);
  assert.deepEqual(Array.from(record.locations), [3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(record.levels), [8, 0, 0, 0, 0, 0, 0]);
});

test("at5GainRecordNormalize keeps the later level when duplicate locations collapse", () => {
  const record = createRecord([
    [1, 8],
    [1, 7],
    [2, 6],
  ]);

  at5GainRecordNormalize(record);

  assert.equal(record.entries, 1);
  assert.deepEqual(Array.from(record.locations), [1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(record.levels), [7, 0, 0, 0, 0, 0, 0]);
});

test("gain-record metric helpers preserve release-tail scoring and decrement detection", () => {
  assert.equal(
    at5GainRecordMetric(
      createRecord([
        [0, 10],
        [2, 8],
        [4, 7],
      ])
    ),
    4
  );
  assert.equal(
    at5GainRecordDecrementIndex(
      createRecord([
        [0, 8],
        [2, 7],
        [4, 7],
      ])
    ),
    0
  );
  assert.equal(
    at5GainRecordDecrementIndex(
      createRecord([
        [0, 6],
        [2, 6],
        [4, 8],
      ])
    ),
    2
  );
  assert.equal(at5GainRecordDecrementIndex(createRecord([[0, 6]])), -1);
});
