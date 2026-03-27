import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCodecDecodedSampleWindow,
  resolveDecodedSampleWindow,
  resolveFactLeadInSamples,
  trimInterleavedPcm,
} from "../../../src/common/trim.js";

test("resolveDecodedSampleWindow rejects factSamples that exceed available samples", () => {
  assert.deepEqual(resolveDecodedSampleWindow(100, 20, 10), {
    skipSamples: 10,
    targetSamples: 20,
  });

  assert.throws(() => resolveDecodedSampleWindow(100, 200, 10), /factSamples/);

  assert.deepEqual(resolveDecodedSampleWindow(100, null, 10), {
    skipSamples: 10,
    targetSamples: 90,
  });
});

test("resolveDecodedSampleWindow clamps fully skipped output", () => {
  assert.deepEqual(resolveDecodedSampleWindow(10, 5, 99), {
    skipSamples: 10,
    targetSamples: 0,
  });
});

test("resolveFactLeadInSamples preserves codec-specific fact word precedence", () => {
  assert.equal(resolveFactLeadInSamples([100, 200, 300], 1024, [1]), 200);
  assert.equal(resolveFactLeadInSamples([100, 200, 300], 2048, [2, 1]), 300);
  assert.equal(resolveFactLeadInSamples([100, null, -1], 2048, [2, 1]), 2048);
  assert.equal(resolveFactLeadInSamples(null, 1024, [1]), 1024);
});

test("resolveCodecDecodedSampleWindow composes shared trim math from codec lead-in rules", () => {
  assert.deepEqual(resolveCodecDecodedSampleWindow(1000, 400, [0, 200, 300], 1024, [1], 69), {
    skipSamples: 269,
    targetSamples: 400,
  });
  assert.deepEqual(
    resolveCodecDecodedSampleWindow(1000, null, [0, null, 300], 1024, [2, 1], 1105),
    {
      skipSamples: 1000,
      targetSamples: 0,
    }
  );
});

test("trimInterleavedPcm trims interleaved decoded PCM with fact and skip metadata", () => {
  const decodedPcm = Int16Array.from([10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 60, 61]);

  assert.deepEqual(
    Array.from(trimInterleavedPcm(decodedPcm, 2, { skipSamples: 1, targetSamples: 2 })),
    [20, 21, 30, 31]
  );
  assert.deepEqual(
    Array.from(trimInterleavedPcm(decodedPcm, 2, { skipSamples: 2, targetSamples: 4 })),
    [30, 31, 40, 41, 50, 51, 60, 61]
  );
});
