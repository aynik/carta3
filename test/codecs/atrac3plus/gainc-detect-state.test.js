import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_GC_POINT_FIELDS as POINT,
  AT5_GC_POINT_ENTRY_STRIDE_BYTES,
  AT5_GC_POINT_GROUP_STRIDE_BYTES,
  readGaincPointLink as readLink,
  writeGaincPoint as writePoint,
  writeGaincPointFlag as writeFlag,
} from "../../../src/atrac3plus/gainc/point-layout.js";
import { getGaincBandHistory } from "../../../src/atrac3plus/gainc/history.js";
import {
  createGaincDetectScratch,
  CURRENT_SCRATCH_GROUP_OFFSET,
  CURRENT_SCRATCH_SENTINEL_OFFSET,
  initializeGaincScratchCurves,
  NEXT_SCRATCH_GROUP_OFFSET,
  PREVIOUS_SCRATCH_GROUP_OFFSET,
  PREVIOUS_SCRATCH_SENTINEL_OFFSET,
  restoreGaincPointHistoryForBand,
  storeGaincPointHistoryForNextFrame,
} from "../../../src/atrac3plus/gainc/detect-state.js";

const AT5_GAINC_BANDS_MAX = 0x10;

function createGaincRuntimeBlock() {
  return {
    pointGroupCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    disabledPointCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    gainLevelBoundsHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    peakIndexHistory: new Uint32Array(AT5_GAINC_BANDS_MAX * 2),
    peakValueHistory: new Float32Array(AT5_GAINC_BANDS_MAX * 2),
    windowAbsHistory: new Float32Array(AT5_GAINC_BANDS_MAX * 64),
    windowScaleHistory: new Float32Array(AT5_GAINC_BANDS_MAX * 64),
    trailingWindowPeakHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
    duplicatePointCountHistory: new Uint32Array(AT5_GAINC_BANDS_MAX),
    gainPointHistoryBytes: new Uint8Array(0x18000),
    stereoBandEnergyHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
    stereoBandEnergyRatioHistory: new Float32Array(AT5_GAINC_BANDS_MAX),
  };
}

function entryOffset(groupOffset, index) {
  return groupOffset + index * AT5_GC_POINT_ENTRY_STRIDE_BYTES;
}

test("restoreGaincPointHistoryForBand copies the previous and current history pages into scratch", () => {
  const block = createGaincRuntimeBlock();
  const bandHistory = getGaincBandHistory(block, 2);
  const scratch = createGaincDetectScratch();

  assert.ok(bandHistory);
  if (!bandHistory) {
    return;
  }

  bandHistory.gainPointHistoryBytes.fill(
    0x5a,
    AT5_GC_POINT_GROUP_STRIDE_BYTES * 4,
    AT5_GC_POINT_GROUP_STRIDE_BYTES * 5
  );
  bandHistory.gainPointHistoryBytes.fill(
    0xa5,
    AT5_GC_POINT_GROUP_STRIDE_BYTES * 5,
    AT5_GC_POINT_GROUP_STRIDE_BYTES * 6
  );

  restoreGaincPointHistoryForBand(scratch.scratchBytes, bandHistory.gainPointHistoryBytes, 2);

  assert.equal(scratch.scratchBytes[PREVIOUS_SCRATCH_GROUP_OFFSET], 0x5a);
  assert.equal(scratch.scratchBytes[CURRENT_SCRATCH_GROUP_OFFSET], 0xa5);
});

test("initializeGaincScratchCurves resets sentinel words, seeds the active list, and counts duplicate indices", () => {
  const scratch = createGaincDetectScratch();
  const { view } = scratch;
  const currentA = entryOffset(CURRENT_SCRATCH_GROUP_OFFSET, 0);
  const currentB = entryOffset(CURRENT_SCRATCH_GROUP_OFFSET, 1);
  const previousA = entryOffset(PREVIOUS_SCRATCH_GROUP_OFFSET, 0);

  view.setUint32(CURRENT_SCRATCH_SENTINEL_OFFSET, 0xffffffff, true);
  view.setUint32(PREVIOUS_SCRATCH_SENTINEL_OFFSET, 0xffffffff, true);

  writePoint(view, currentA, POINT.INDEX, 9);
  writePoint(view, currentA, POINT.DELTA, 2);
  writeFlag(view, currentA, POINT.DISABLED, false);
  writePoint(view, currentA, POINT.POINT_COUNT, 1);

  writePoint(view, currentB, POINT.INDEX, 9);
  writePoint(view, currentB, POINT.DELTA, 4);
  writeFlag(view, currentB, POINT.DISABLED, false);
  writePoint(view, currentB, POINT.POINT_COUNT, 2);

  writePoint(view, previousA, POINT.INDEX, 7);
  writePoint(view, previousA, POINT.DELTA, 3);
  writeFlag(view, previousA, POINT.DISABLED, false);
  writePoint(view, previousA, POINT.POINT_COUNT, 1);

  const currentDuplicateIndexCount = initializeGaincScratchCurves(
    view,
    1,
    { current: 2, next: 0 },
    scratch.currentDeltaSumByIndex
  );

  assert.equal(view.getUint32(CURRENT_SCRATCH_SENTINEL_OFFSET, true), 0);
  assert.equal(view.getUint32(PREVIOUS_SCRATCH_SENTINEL_OFFSET, true), 0);
  assert.equal(readLink(view, CURRENT_SCRATCH_SENTINEL_OFFSET, POINT.NEXT_ACTIVE), currentA);
  assert.equal(currentDuplicateIndexCount, 1);
  assert.equal(scratch.currentDeltaSumByIndex[9], 6);
});

test("initializeGaincScratchCurves keeps freshly emitted current points out of the initial active list", () => {
  const scratch = createGaincDetectScratch();
  const { view } = scratch;
  const retainedCurrent = entryOffset(CURRENT_SCRATCH_GROUP_OFFSET, 0);
  const freshCurrent = entryOffset(CURRENT_SCRATCH_GROUP_OFFSET, 1);

  writePoint(view, retainedCurrent, POINT.INDEX, 10);
  writePoint(view, retainedCurrent, POINT.DELTA, 2);
  writeFlag(view, retainedCurrent, POINT.DISABLED, false);

  writePoint(view, freshCurrent, POINT.INDEX, 8);
  writePoint(view, freshCurrent, POINT.DELTA, 3);
  writeFlag(view, freshCurrent, POINT.DISABLED, false);

  initializeGaincScratchCurves(view, 1, { current: 2, next: 0 }, scratch.currentDeltaSumByIndex);

  assert.equal(readLink(view, CURRENT_SCRATCH_SENTINEL_OFFSET, POINT.NEXT_ACTIVE), retainedCurrent);
  assert.equal(readLink(view, retainedCurrent, POINT.NEXT_ACTIVE), null);
  assert.equal(scratch.currentDeltaSumByIndex[10], 2);
  assert.equal(scratch.currentDeltaSumByIndex[8], 3);
});

test("storeGaincPointHistoryForNextFrame copies the current and next scratch pages into band history", () => {
  const block = createGaincRuntimeBlock();
  const bandHistory = getGaincBandHistory(block, 0);
  const scratch = createGaincDetectScratch();

  assert.ok(bandHistory);
  if (!bandHistory) {
    return;
  }

  scratch.scratchBytes.fill(
    0x5a,
    CURRENT_SCRATCH_GROUP_OFFSET,
    CURRENT_SCRATCH_GROUP_OFFSET + AT5_GC_POINT_GROUP_STRIDE_BYTES
  );
  scratch.scratchBytes.fill(
    0xa5,
    NEXT_SCRATCH_GROUP_OFFSET,
    NEXT_SCRATCH_GROUP_OFFSET + AT5_GC_POINT_GROUP_STRIDE_BYTES
  );

  storeGaincPointHistoryForNextFrame(
    scratch.view,
    scratch.scratchBytes,
    bandHistory.gainPointHistoryBytes,
    0
  );

  const historyBytes = block.gainPointHistoryBytes.subarray(0, AT5_GC_POINT_GROUP_STRIDE_BYTES * 2);
  assert.equal(historyBytes[0], 0x5a);
  assert.equal(historyBytes[AT5_GC_POINT_GROUP_STRIDE_BYTES], 0xa5);
});
