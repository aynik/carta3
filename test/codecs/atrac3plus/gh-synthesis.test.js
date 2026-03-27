import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGhBandSynthesisState,
  shouldApplyCurrentGhOverlapWindow,
  shouldApplyPreviousGhOverlapWindow,
  shouldUseSeparateGhOverlapWindows,
} from "../../../src/atrac3plus/gh-synthesis.js";

function createGhEntry(values = {}) {
  return {
    idlocFlag0: 0,
    idlocFlag1: 0,
    idlocValue0: 0,
    idlocValue1: 0x20,
    entryCount: 0,
    entries: [],
    ...values,
  };
}

function createGhBandState(values = {}) {
  return {
    hasLeftFade: 0,
    hasRightFade: 0,
    leftIndex: 0,
    rightIndex: 0x100,
    entryCount: 0,
    entries: null,
    ...values,
  };
}

test("resolveGhBandSynthesisState derives decoder gating without mutating raw entries", () => {
  const previous = createGhEntry({
    idlocFlag0: 1,
    idlocValue0: 9,
  });
  const currentEntries = [{ step: 144 }];
  const current = createGhEntry({
    entryCount: 1,
    entries: currentEntries,
  });

  const state = resolveGhBandSynthesisState(previous, current);

  assert.deepEqual(state, {
    hasLeftFade: 1,
    hasRightFade: 0,
    leftIndex: 36,
    rightIndex: 0x100,
    entryCount: 1,
    entries: currentEntries,
  });
  assert.equal("leftIndex" in current, false);
  assert.equal("rightIndex" in current, false);
});

test("resolveGhBandSynthesisState prefers the current frame's standalone gate range", () => {
  const currentEntries = [{ step: 80 }, { step: 96 }];
  const state = resolveGhBandSynthesisState(
    createGhEntry(),
    createGhEntry({
      idlocFlag0: 1,
      idlocValue0: 5,
      idlocFlag1: 1,
      idlocValue1: 10,
      entryCount: 2,
      entries: currentEntries,
    })
  );

  assert.deepEqual(state, {
    hasLeftFade: 1,
    hasRightFade: 1,
    leftIndex: 148,
    rightIndex: 172,
    entryCount: 2,
    entries: currentEntries,
  });
});

test("resolveGhBandSynthesisState reuses the previous right gate when it still bounds the band", () => {
  const state = resolveGhBandSynthesisState(
    createGhEntry({
      idlocFlag0: 1,
      idlocValue0: 5,
      idlocFlag1: 1,
      idlocValue1: 24,
    }),
    createGhEntry({
      entryCount: 1,
      entries: [{ step: 64 }],
      idlocFlag1: 1,
      idlocValue1: 30,
    })
  );

  assert.equal(state.hasLeftFade, 1);
  assert.equal(state.leftIndex, 20);
  assert.equal(state.hasRightFade, 1);
  assert.equal(state.rightIndex, 100);
});

test("resolveGhBandSynthesisState clamps the right gate to the synthesis window", () => {
  const state = resolveGhBandSynthesisState(
    createGhEntry(),
    createGhEntry({
      idlocFlag0: 1,
      idlocValue0: 0,
      idlocFlag1: 1,
      idlocValue1: 31,
      entryCount: 1,
    })
  );

  assert.equal(state.rightIndex, 0x100);
});

test("GH overlap helpers distinguish shared and independent windows", () => {
  const overlappingPrevious = createGhBandState({
    hasRightFade: 1,
    rightIndex: 180,
    entryCount: 1,
  });
  const overlappingCurrent = createGhBandState({
    hasLeftFade: 1,
    leftIndex: 120,
    entryCount: 1,
  });

  assert.equal(shouldUseSeparateGhOverlapWindows(overlappingPrevious, overlappingCurrent), false);
  assert.equal(shouldApplyPreviousGhOverlapWindow(overlappingPrevious, overlappingCurrent), true);
  assert.equal(shouldApplyCurrentGhOverlapWindow(overlappingPrevious, overlappingCurrent), true);

  const separatedPrevious = createGhBandState({
    hasRightFade: 1,
    rightIndex: 120,
    entryCount: 1,
  });
  const separatedCurrent = createGhBandState({
    hasLeftFade: 1,
    leftIndex: 100,
    entryCount: 1,
  });

  assert.equal(shouldUseSeparateGhOverlapWindows(separatedPrevious, separatedCurrent), true);
  assert.equal(shouldApplyPreviousGhOverlapWindow(separatedPrevious, separatedCurrent), false);
  assert.equal(shouldApplyCurrentGhOverlapWindow(separatedPrevious, separatedCurrent), false);
});
