import assert from "node:assert/strict";
import test from "node:test";

import {
  filterBandForQuantBandAt3,
  quantStepCountForWordLengthIndexAt3,
  scaleFactorIndexForAbsValueAt3,
  scaleFactorIndexForValueAt3,
  scaleFactorValueForIndexAt3,
  spectrumOffsetForQuantBandAt3,
  spectrumSampleCountForQuantBandAt3,
  toneWidthForTwiddleIdAt3,
  windowLengthForWordLengthIndexAt3,
  zeroThresholdForWordLengthIndexAt3,
} from "../../../../src/atrac3/scx/tables.js";
import { AT3_ID_SCALEFACTOR_TABLE } from "../../../../src/atrac3/encode-tables.js";

test("SCX table lookups preserve current sentinel behavior", () => {
  assert.equal(spectrumOffsetForQuantBandAt3(0), 0);
  assert.equal(spectrumOffsetForQuantBandAt3(31), 896);
  assert.equal(spectrumOffsetForQuantBandAt3(99), -1);

  assert.equal(spectrumSampleCountForQuantBandAt3(31), 128);
  assert.equal(windowLengthForWordLengthIndexAt3(1), 2);
  assert.equal(quantStepCountForWordLengthIndexAt3(1), 1);
  assert.equal(toneWidthForTwiddleIdAt3(1), 2);

  assert.equal(scaleFactorValueForIndexAt3(63), 65536);
  assert.equal(scaleFactorValueForIndexAt3(99), -65536);
  assert.equal(zeroThresholdForWordLengthIndexAt3(0, 2), 0);
  assert.ok(Number.isNaN(zeroThresholdForWordLengthIndexAt3(5, 99)));
});

test("SCX scalar helpers keep current threshold mapping", () => {
  assert.deepEqual([0, 8, 12, 16, 20, 26].map(filterBandForQuantBandAt3), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([0.0001, 0.01, 1, 100].map(scaleFactorIndexForAbsValueAt3), [0, 0, 16, 35]);
  assert.deepEqual([-0.01, 0.01, 1].map(scaleFactorIndexForValueAt3), [0, 0, 16]);
});

test("SCX scale-factor helpers preserve exact upper-bound lookups", () => {
  assert.equal(scaleFactorIndexForAbsValueAt3(AT3_ID_SCALEFACTOR_TABLE[0] / 2), 0);
  assert.equal(scaleFactorIndexForAbsValueAt3(AT3_ID_SCALEFACTOR_TABLE[0]), 1);
  assert.equal(
    scaleFactorIndexForAbsValueAt3(
      (AT3_ID_SCALEFACTOR_TABLE[10] + AT3_ID_SCALEFACTOR_TABLE[11]) / 2
    ),
    11
  );
  assert.equal(scaleFactorIndexForAbsValueAt3(AT3_ID_SCALEFACTOR_TABLE[62]), 63);
  assert.equal(scaleFactorIndexForAbsValueAt3(AT3_ID_SCALEFACTOR_TABLE[63] * 2), 63);

  assert.equal(scaleFactorIndexForValueAt3(AT3_ID_SCALEFACTOR_TABLE[0]), 1);
  assert.equal(scaleFactorIndexForValueAt3(-AT3_ID_SCALEFACTOR_TABLE[15]), 16);
  assert.equal(scaleFactorIndexForValueAt3(AT3_ID_SCALEFACTOR_TABLE[63] * 2), 63);
});
