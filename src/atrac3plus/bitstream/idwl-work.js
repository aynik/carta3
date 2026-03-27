import { HOST_IS_LITTLE_ENDIAN } from "../../common/endian.js";

export const AT5_IDWL_WORK_GROUP_STRIDE = 0x8c;
export const AT5_IDWL_WORK_GROUP_VALUES_OFFSET = 0x0c;
export const AT5_IDWL_WORK_GROUP_VALUES = 32;

export const AT5_IDWL_WORK_PAIR_FLAG_OFFSET = 0x23c;
export const AT5_IDWL_WORK_SG_AVG_VALS_OFFSET = 0x240;
export const AT5_IDWL_WORK_SG_EXTRA_OFFSET = 0x264;
export const AT5_IDWL_WORK_SG_SHAPE_ADJUST_OFFSET = 0x268;
export const AT5_IDWL_WORK_SG_COPY_BYTES = 0x290;

const AT5_IDWL_WORK_MODE1_LEAD_OFFSET = 0x00;
const AT5_IDWL_WORK_MODE1_WIDTH_OFFSET = 0x04;
const AT5_IDWL_WORK_MODE1_BASE_OFFSET = 0x08;

// Mode-2 selectors walk a historical slot layout: each selector starts 0x8c
// bytes after the previous one, exposes 32 symbol words at +0x0c, and keeps
// its shape metadata in the trailer words that follow that payload.
const AT5_IDWL_WORK_MODE2_SLOT_STRIDE = 0x8c;
const AT5_IDWL_WORK_MODE2_SYMBOLS_OFFSET = 0x0c;
const AT5_IDWL_WORK_MODE2_SHAPE_SHIFT_OFFSET = 0x8c;
const AT5_IDWL_WORK_MODE2_SHAPE_BASE_OFFSET = 0x90;

const AT5_IDWL_WORK_GROUP_METADATA_BYTES = 0x0c;
const AT5_IDWL_WORK_GROUP_METADATA_OFFSET =
  AT5_IDWL_WORK_GROUP_STRIDE - AT5_IDWL_WORK_GROUP_METADATA_BYTES;
const AT5_IDWL_WORK_GROUP_BEST_SHAPE_OFFSET = AT5_IDWL_WORK_GROUP_METADATA_OFFSET + 0x00;
const AT5_IDWL_WORK_GROUP_AVG_BASE_OFFSET = AT5_IDWL_WORK_GROUP_METADATA_OFFSET + 0x04;
const AT5_IDWL_WORK_GROUP_SHAPE_COUNT_OFFSET = AT5_IDWL_WORK_GROUP_METADATA_OFFSET + 0x08;
const AT5_IDWL_WORK_SHARED_GROUP_VALUE_COUNT = 10;

const gI32ViewByBuffer = new WeakMap();
const gU32ViewByBuffer = new WeakMap();
const gDataViewByBuffer = new WeakMap();

function cachedI32View(buffer) {
  let view = gI32ViewByBuffer.get(buffer);
  if (!view) {
    view = new Int32Array(buffer);
    gI32ViewByBuffer.set(buffer, view);
  }
  return view;
}

function cachedU32View(buffer) {
  let view = gU32ViewByBuffer.get(buffer);
  if (!view) {
    view = new Uint32Array(buffer);
    gU32ViewByBuffer.set(buffer, view);
  }
  return view;
}

function cachedDataView(buffer) {
  let view = gDataViewByBuffer.get(buffer);
  if (!view) {
    view = new DataView(buffer);
    gDataViewByBuffer.set(buffer, view);
  }
  return view;
}

export function idwlWorkU8(scratch) {
  const work = scratch?.work;
  if (!(work instanceof Uint8Array) || (work.length | 0) < AT5_IDWL_WORK_SG_COPY_BYTES) {
    throw new TypeError("idwl scratch is missing the shared work buffer");
  }
  return work;
}

export function idwlWorkI32(scratch) {
  const work = idwlWorkU8(scratch);
  return new Int32Array(work.buffer, work.byteOffset, (work.byteLength / 4) | 0);
}

export function idwlWorkLoadI32(workU8, byteOffset) {
  const off = byteOffset | 0;
  const abs = (workU8.byteOffset + off) | 0;
  if ((abs & 3) !== 0) {
    return cachedDataView(workU8.buffer).getInt32(abs, HOST_IS_LITTLE_ENDIAN) | 0;
  }
  return cachedI32View(workU8.buffer)[abs >> 2] | 0;
}

export function idwlWorkLoadU32(workU8, byteOffset) {
  const off = byteOffset | 0;
  const abs = (workU8.byteOffset + off) | 0;
  if ((abs & 3) !== 0) {
    return cachedDataView(workU8.buffer).getUint32(abs, HOST_IS_LITTLE_ENDIAN) >>> 0;
  }
  return cachedU32View(workU8.buffer)[abs >> 2] >>> 0;
}

export function idwlWorkStoreI32(workU8, byteOffset, value) {
  const off = byteOffset | 0;
  const abs = (workU8.byteOffset + off) | 0;
  if ((abs & 3) !== 0) {
    cachedDataView(workU8.buffer).setInt32(abs, value | 0, HOST_IS_LITTLE_ENDIAN);
    return;
  }
  cachedI32View(workU8.buffer)[abs >> 2] = value | 0;
}

export function idwlWorkStoreU32(workU8, byteOffset, value) {
  const off = byteOffset | 0;
  const abs = (workU8.byteOffset + off) | 0;
  if ((abs & 3) !== 0) {
    cachedDataView(workU8.buffer).setUint32(abs, value >>> 0, HOST_IS_LITTLE_ENDIAN);
    return;
  }
  cachedU32View(workU8.buffer)[abs >> 2] = value >>> 0;
}

function idwlWorkI32ViewAtOffset(workU8, byteOffset, valueCount) {
  return new Int32Array(workU8.buffer, workU8.byteOffset + (byteOffset | 0), valueCount | 0);
}

function idwlWorkU32ViewAtOffset(workU8, byteOffset, valueCount) {
  return new Uint32Array(workU8.buffer, workU8.byteOffset + (byteOffset | 0), valueCount | 0);
}

function idwlWorkGroupMetadataOffset(group, fieldOffset) {
  return (idwlWorkGroupSlotOffset(group) + (fieldOffset | 0)) | 0;
}

function idwlWorkMode2SlotOffset(mode) {
  return ((mode | 0) * AT5_IDWL_WORK_MODE2_SLOT_STRIDE) | 0;
}

export function idwlWorkGroupSlotOffset(group) {
  return (AT5_IDWL_WORK_GROUP_VALUES_OFFSET + (group | 0) * AT5_IDWL_WORK_GROUP_STRIDE) | 0;
}

export function copyIdwlWorkGroupSlot(workU8, targetGroup, sourceGroup) {
  const sourceOffset = idwlWorkGroupSlotOffset(sourceGroup);
  const targetOffset = idwlWorkGroupSlotOffset(targetGroup);
  workU8.copyWithin(targetOffset, sourceOffset, sourceOffset + AT5_IDWL_WORK_GROUP_STRIDE);
}

export function idwlWorkSharedGroupAvgValuesView(workU8) {
  return idwlWorkI32ViewAtOffset(
    workU8,
    AT5_IDWL_WORK_SG_AVG_VALS_OFFSET,
    AT5_IDWL_WORK_SHARED_GROUP_VALUE_COUNT
  );
}

export function idwlWorkSharedGroupShapeAdjustView(workU8) {
  return idwlWorkI32ViewAtOffset(
    workU8,
    AT5_IDWL_WORK_SG_SHAPE_ADJUST_OFFSET,
    AT5_IDWL_WORK_SHARED_GROUP_VALUE_COUNT
  );
}

export function idwlWorkMode1Lead(workU8) {
  return idwlWorkLoadU32(workU8, AT5_IDWL_WORK_MODE1_LEAD_OFFSET);
}

export function idwlWorkSetMode1Lead(workU8, value) {
  idwlWorkStoreU32(workU8, AT5_IDWL_WORK_MODE1_LEAD_OFFSET, value);
}

export function idwlWorkMode1Width(workU8) {
  return idwlWorkLoadU32(workU8, AT5_IDWL_WORK_MODE1_WIDTH_OFFSET);
}

export function idwlWorkSetMode1Width(workU8, value) {
  idwlWorkStoreU32(workU8, AT5_IDWL_WORK_MODE1_WIDTH_OFFSET, value);
}

export function idwlWorkMode1Base(workU8) {
  return idwlWorkLoadU32(workU8, AT5_IDWL_WORK_MODE1_BASE_OFFSET);
}

export function idwlWorkSetMode1Base(workU8, value) {
  idwlWorkStoreU32(workU8, AT5_IDWL_WORK_MODE1_BASE_OFFSET, value);
}

export function idwlWorkMode2SymbolsView(workU8, mode) {
  return idwlWorkU32ViewAtOffset(
    workU8,
    idwlWorkMode2SlotOffset(mode) + AT5_IDWL_WORK_MODE2_SYMBOLS_OFFSET,
    AT5_IDWL_WORK_GROUP_VALUES
  );
}

export function idwlWorkMode2ShapeShift(workU8, mode) {
  return idwlWorkLoadU32(
    workU8,
    idwlWorkMode2SlotOffset(mode) + AT5_IDWL_WORK_MODE2_SHAPE_SHIFT_OFFSET
  );
}

export function idwlWorkSetMode2ShapeShift(workU8, mode, value) {
  idwlWorkStoreU32(
    workU8,
    idwlWorkMode2SlotOffset(mode) + AT5_IDWL_WORK_MODE2_SHAPE_SHIFT_OFFSET,
    value
  );
}

export function idwlWorkMode2ShapeBase(workU8, mode) {
  return idwlWorkLoadU32(
    workU8,
    idwlWorkMode2SlotOffset(mode) + AT5_IDWL_WORK_MODE2_SHAPE_BASE_OFFSET
  );
}

export function idwlWorkSetMode2ShapeBase(workU8, mode, value) {
  idwlWorkStoreU32(
    workU8,
    idwlWorkMode2SlotOffset(mode) + AT5_IDWL_WORK_MODE2_SHAPE_BASE_OFFSET,
    value
  );
}

export function idwlWorkMode2PairFlag(workU8) {
  return idwlWorkLoadU32(workU8, AT5_IDWL_WORK_PAIR_FLAG_OFFSET) & 1;
}

export function idwlWorkSetMode2PairFlag(workU8, value) {
  idwlWorkStoreU32(workU8, AT5_IDWL_WORK_PAIR_FLAG_OFFSET, value & 1);
}

export function idwlWorkGroupBestShape(workU8, group) {
  return idwlWorkLoadI32(
    workU8,
    idwlWorkGroupMetadataOffset(group, AT5_IDWL_WORK_GROUP_BEST_SHAPE_OFFSET)
  );
}

export function idwlWorkSetGroupBestShape(workU8, group, shape) {
  idwlWorkStoreI32(
    workU8,
    idwlWorkGroupMetadataOffset(group, AT5_IDWL_WORK_GROUP_BEST_SHAPE_OFFSET),
    shape
  );
}

export function idwlWorkGroupAvgBase(workU8, group) {
  return idwlWorkLoadI32(
    workU8,
    idwlWorkGroupMetadataOffset(group, AT5_IDWL_WORK_GROUP_AVG_BASE_OFFSET)
  );
}

export function idwlWorkSetGroupAvgBase(workU8, group, value) {
  idwlWorkStoreI32(
    workU8,
    idwlWorkGroupMetadataOffset(group, AT5_IDWL_WORK_GROUP_AVG_BASE_OFFSET),
    value
  );
}

export function idwlWorkGroupShapeCount(workU8, group) {
  return idwlWorkLoadI32(
    workU8,
    idwlWorkGroupMetadataOffset(group, AT5_IDWL_WORK_GROUP_SHAPE_COUNT_OFFSET)
  );
}

export function idwlWorkSetGroupShapeCount(workU8, group, value) {
  idwlWorkStoreI32(
    workU8,
    idwlWorkGroupMetadataOffset(group, AT5_IDWL_WORK_GROUP_SHAPE_COUNT_OFFSET),
    value
  );
}
