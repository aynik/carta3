import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_IDWL_WORK_GROUP_VALUES,
  AT5_IDWL_WORK_SG_COPY_BYTES,
  copyIdwlWorkGroupSlot,
  idwlWorkMode1Base,
  idwlWorkMode1Lead,
  idwlWorkMode1Width,
  idwlWorkMode2PairFlag,
  idwlWorkMode2ShapeBase,
  idwlWorkMode2ShapeShift,
  idwlWorkMode2SymbolsView,
  idwlWorkGroupAvgBase,
  idwlWorkGroupBestShape,
  idwlWorkGroupShapeCount,
  idwlWorkGroupSlotOffset,
  idwlWorkI32,
  idwlWorkSetMode1Base,
  idwlWorkSetMode1Lead,
  idwlWorkSetMode1Width,
  idwlWorkSetMode2PairFlag,
  idwlWorkSetMode2ShapeBase,
  idwlWorkSetMode2ShapeShift,
  idwlWorkSetGroupAvgBase,
  idwlWorkSetGroupBestShape,
  idwlWorkSetGroupShapeCount,
} from "../../../src/atrac3plus/bitstream/idwl-work.js";

function createIdwlWorkScratch() {
  return { work: new Uint8Array(AT5_IDWL_WORK_SG_COPY_BYTES) };
}

test("IDWL work names the mode-1 header words", () => {
  const scratch = createIdwlWorkScratch();
  const workI32 = idwlWorkI32(scratch);

  idwlWorkSetMode1Lead(scratch.work, 5);
  idwlWorkSetMode1Width(scratch.work, 2);
  idwlWorkSetMode1Base(scratch.work, 7);

  assert.equal(idwlWorkMode1Lead(scratch.work), 5);
  assert.equal(idwlWorkMode1Width(scratch.work), 2);
  assert.equal(idwlWorkMode1Base(scratch.work), 7);
  assert.deepEqual(Array.from(workI32.slice(0, 3)), [5, 2, 7]);
});

test("IDWL work names each mode-2 selector slot", () => {
  const scratch = createIdwlWorkScratch();
  const symbols = idwlWorkMode2SymbolsView(scratch.work, 1);

  symbols.set([9, 8, 7, 6], 0);
  idwlWorkSetMode2ShapeShift(scratch.work, 1, 0x11223344);
  idwlWorkSetMode2ShapeBase(scratch.work, 1, 0x9abcdef0);
  idwlWorkSetMode2PairFlag(scratch.work, 1);

  assert.equal(symbols.byteOffset - scratch.work.byteOffset, 0x98);
  assert.equal(symbols.byteLength, 0x80);
  assert.equal(idwlWorkMode2ShapeShift(scratch.work, 1), 0x11223344);
  assert.equal(idwlWorkMode2ShapeBase(scratch.work, 1), 0x9abcdef0);
  assert.equal(idwlWorkMode2PairFlag(scratch.work), 1);
  assert.deepEqual(Array.from(idwlWorkMode2SymbolsView(scratch.work, 1).slice(0, 4)), [9, 8, 7, 6]);
});

test("IDWL work group metadata accessors use the trailer words of each slot", () => {
  const scratch = createIdwlWorkScratch();
  const workI32 = idwlWorkI32(scratch);
  const group0Base = idwlWorkGroupSlotOffset(0) / 4;
  const group1Base = idwlWorkGroupSlotOffset(1) / 4;

  idwlWorkSetGroupBestShape(scratch.work, 0, 5);
  idwlWorkSetGroupAvgBase(scratch.work, 0, 12);
  idwlWorkSetGroupShapeCount(scratch.work, 0, 7);

  idwlWorkSetGroupBestShape(scratch.work, 1, 9);
  idwlWorkSetGroupAvgBase(scratch.work, 1, -3);
  idwlWorkSetGroupShapeCount(scratch.work, 1, 4);

  assert.equal(idwlWorkGroupBestShape(scratch.work, 0), 5);
  assert.equal(idwlWorkGroupAvgBase(scratch.work, 0), 12);
  assert.equal(idwlWorkGroupShapeCount(scratch.work, 0), 7);

  assert.equal(idwlWorkGroupBestShape(scratch.work, 1), 9);
  assert.equal(idwlWorkGroupAvgBase(scratch.work, 1), -3);
  assert.equal(idwlWorkGroupShapeCount(scratch.work, 1), 4);

  assert.equal(workI32[group0Base + AT5_IDWL_WORK_GROUP_VALUES + 0], 5);
  assert.equal(workI32[group0Base + AT5_IDWL_WORK_GROUP_VALUES + 1], 12);
  assert.equal(workI32[group0Base + AT5_IDWL_WORK_GROUP_VALUES + 2], 7);
  assert.equal(workI32[group1Base + AT5_IDWL_WORK_GROUP_VALUES + 0], 9);
  assert.equal(workI32[group1Base + AT5_IDWL_WORK_GROUP_VALUES + 1], -3);
  assert.equal(workI32[group1Base + AT5_IDWL_WORK_GROUP_VALUES + 2], 4);
});

test("copyIdwlWorkGroupSlot copies both SG values and trailer metadata", () => {
  const scratch = createIdwlWorkScratch();
  const workI32 = idwlWorkI32(scratch);
  const sourceBase = idwlWorkGroupSlotOffset(1) / 4;
  const targetBase = idwlWorkGroupSlotOffset(0) / 4;

  workI32[sourceBase + 0] = 11;
  workI32[sourceBase + 5] = -7;
  workI32[sourceBase + 31] = 3;
  idwlWorkSetGroupBestShape(scratch.work, 1, 6);
  idwlWorkSetGroupAvgBase(scratch.work, 1, 14);
  idwlWorkSetGroupShapeCount(scratch.work, 1, 8);

  workI32[targetBase + 0] = 99;
  idwlWorkSetGroupBestShape(scratch.work, 0, 1);
  idwlWorkSetGroupAvgBase(scratch.work, 0, 2);
  idwlWorkSetGroupShapeCount(scratch.work, 0, 3);

  copyIdwlWorkGroupSlot(scratch.work, 0, 1);

  assert.equal(workI32[targetBase + 0], 11);
  assert.equal(workI32[targetBase + 5], -7);
  assert.equal(workI32[targetBase + 31], 3);
  assert.equal(idwlWorkGroupBestShape(scratch.work, 0), 6);
  assert.equal(idwlWorkGroupAvgBase(scratch.work, 0), 14);
  assert.equal(idwlWorkGroupShapeCount(scratch.work, 0), 8);
});
