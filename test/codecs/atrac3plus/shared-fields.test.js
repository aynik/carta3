import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  sharedHasZeroSpectra,
  sharedMapSegmentCount,
  sharedNoiseFillCursor,
  sharedNoiseFillEnabled,
  sharedNoiseFillShift,
  sharedUsedBitCount,
  sharedZeroSpectraFlag,
} from "../../../src/atrac3plus/shared-fields.js";

test("shared field helpers read semantic block metadata", () => {
  const shared = {
    mapSegmentCount: 3,
    zeroSpectraFlag: 1,
    noiseFillEnabled: 1,
    noiseFillShift: 5,
    noiseFillCursor: 9,
    usedBitCount: 123,
  };

  assert.equal(sharedMapSegmentCount(shared), 3);
  assert.equal(sharedZeroSpectraFlag(shared), 1);
  assert.equal(sharedHasZeroSpectra(shared), true);
  assert.equal(sharedNoiseFillEnabled(shared), 1);
  assert.equal(sharedNoiseFillShift(shared), 5);
  assert.equal(sharedNoiseFillCursor(shared), 9);
  assert.equal(sharedUsedBitCount(shared), 123);
});

test("shared field helpers default missing metadata to zero", () => {
  const shared = {};

  assert.equal(sharedMapSegmentCount(shared), 0);
  assert.equal(sharedZeroSpectraFlag(shared), 0);
  assert.equal(sharedHasZeroSpectra(shared), false);
  assert.equal(sharedNoiseFillEnabled(shared), 0);
  assert.equal(sharedNoiseFillShift(shared), 0);
  assert.equal(sharedNoiseFillCursor(shared), 0);
  assert.equal(sharedUsedBitCount(shared), 0);
});

test("shared field helpers read live regular block metadata", () => {
  const block = createAt5RegularBlockState(1);
  const { shared } = block;

  shared.mapSegmentCount = 2;
  shared.zeroSpectraFlag = 1;
  shared.noiseFillEnabled = 1;
  shared.noiseFillShift = 3;
  shared.noiseFillCursor = 6;
  shared.usedBitCount = 55;

  assert.equal(sharedMapSegmentCount(shared), 2);
  assert.equal(sharedZeroSpectraFlag(shared), 1);
  assert.equal(sharedNoiseFillEnabled(shared), 1);
  assert.equal(sharedNoiseFillShift(shared), 3);
  assert.equal(sharedNoiseFillCursor(shared), 6);
  assert.equal(sharedUsedBitCount(shared), 55);

  shared.mapSegmentCount = 5;
  shared.zeroSpectraFlag = 0;
  shared.noiseFillEnabled = 0;
  shared.noiseFillShift = 4;
  shared.noiseFillCursor = 8;
  shared.usedBitCount = 89;

  assert.equal(sharedMapSegmentCount(shared), 5);
  assert.equal(sharedZeroSpectraFlag(shared), 0);
  assert.equal(sharedHasZeroSpectra(shared), false);
  assert.equal(sharedNoiseFillEnabled(shared), 0);
  assert.equal(sharedNoiseFillShift(shared), 4);
  assert.equal(sharedNoiseFillCursor(shared), 8);
  assert.equal(sharedUsedBitCount(shared), 89);
});
