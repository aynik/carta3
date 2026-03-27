import assert from "node:assert/strict";
import test from "node:test";

import {
  AT3ENC_PROC_TONE_POOL_BASE_WORD,
  at3encAppendToneRegionRowTone,
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
  at3encClearToneRegionScratch,
  at3encReadToneRegionActiveUnitFlags,
  at3encProcToneRegionFlagWord,
  at3encProcToneRegionRowCountWord,
  at3encProcToneRegionRowPtrWord,
} from "../../../../src/atrac3/proc-layout.js";

test("proc layout views expose the shared band mode and selector slices", () => {
  const procWords = new Uint32Array(0x80);
  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);

  bandModes[0] = 7;
  bandModes[3] = 5;
  bandSelectors[0] = 12;
  bandSelectors[3] = 34;

  assert.equal(procWords[0], 7);
  assert.equal(procWords[3], 5);
  assert.equal(procWords[0x20], 12);
  assert.equal(procWords[0x23], 34);

  procWords[1] = 9;
  procWords[0x25] = 28;

  assert.equal(bandModes[1], 9);
  assert.equal(bandSelectors[5], 28);
});

test("proc layout tone helpers clear region scratch and append row pointers", () => {
  const procWords = new Uint32Array(0x200).fill(99);
  procWords[AT3ENC_PROC_TONE_POOL_BASE_WORD] = 1234;

  at3encClearToneRegionScratch(procWords);
  assert.deepEqual(
    Array.from(
      procWords.slice(at3encProcToneRegionFlagWord(0, 0), AT3ENC_PROC_TONE_POOL_BASE_WORD)
    ),
    new Array(AT3ENC_PROC_TONE_POOL_BASE_WORD - at3encProcToneRegionFlagWord(0, 0)).fill(0)
  );
  assert.equal(procWords[AT3ENC_PROC_TONE_POOL_BASE_WORD], 1234);

  const slot0 = at3encAppendToneRegionRowTone(procWords, 1, 3, 0x150);
  const slot1 = at3encAppendToneRegionRowTone(procWords, 1, 3, 0x156);

  assert.equal(slot0, 0);
  assert.equal(slot1, 1);
  assert.equal(procWords[at3encProcToneRegionRowCountWord(1, 3)], 2);
  assert.equal(procWords[at3encProcToneRegionRowPtrWord(1, 3, 0)], 0x150);
  assert.equal(procWords[at3encProcToneRegionRowPtrWord(1, 3, 1)], 0x156);
});

test("proc layout tone helpers preserve packed active-unit flag ordering", () => {
  const procWords = new Uint32Array(0x200);
  procWords[at3encProcToneRegionFlagWord(0, 0)] = 1;
  procWords[at3encProcToneRegionFlagWord(0, 1)] = 0;
  procWords[at3encProcToneRegionFlagWord(0, 2)] = 1;

  assert.equal(at3encReadToneRegionActiveUnitFlags(procWords, 0, 3), 0b101);
});
