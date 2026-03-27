const AT5_GC_POINT_ENTRY_STRIDE_BYTES = 0x30;
const AT5_GC_POINT_GROUP_STRIDE_BYTES = 0xc00;
const AT5_GC_POINT_GROUP_ENTRIES = 0x40;

const AT5_GC_POINT_FIELDS = {
  INDEX: 0x00,
  DELTA: 0x04,
  NEXT_ACTIVE: 0x08,
  NEXT_BY_INDEX: 0x0c,
  PREV_BY_INDEX: 0x10,
  DISABLED: 0x14,
  STEP: 0x18,
  HAS_LINK: 0x1c,
  LINK_GROUP_DELTA: 0x20,
  LINK_INDEX: 0x24,
  SPAN_COST: 0x28,
  POINT_COUNT: 0x2c,
};

function readGaincPoint(view, entryOffset, fieldOffset) {
  return view.getInt32(entryOffset + fieldOffset, true);
}

function writeGaincPoint(view, entryOffset, fieldOffset, value) {
  view.setInt32(entryOffset + fieldOffset, value | 0, true);
}

function writeGaincPointU32(view, entryOffset, fieldOffset, value) {
  view.setUint32(entryOffset + fieldOffset, value >>> 0, true);
}

function readGaincPointFlag(view, entryOffset, fieldOffset) {
  return readGaincPoint(view, entryOffset, fieldOffset) !== 0;
}

function writeGaincPointFlag(view, entryOffset, fieldOffset, value) {
  writeGaincPoint(view, entryOffset, fieldOffset, value ? 1 : 0);
}

function readGaincPointLink(view, entryOffset, fieldOffset) {
  const relativeOffset = readGaincPoint(view, entryOffset, fieldOffset);
  if ((relativeOffset | 0) === 0) {
    return null;
  }
  return (entryOffset + (relativeOffset | 0)) | 0;
}

function writeGaincPointLink(view, entryOffset, fieldOffset, linkedOffset) {
  const relativeOffset = linkedOffset === null ? 0 : (linkedOffset - entryOffset) | 0;
  writeGaincPoint(view, entryOffset, fieldOffset, relativeOffset);
}

function wrapGaincIndexTo32SlotWindow(value) {
  const x = value | 0;
  if (x < 0) {
    const base = ((x + 0x1f) & ~0x1f) | 0;
    return (x - base) | 0;
  }
  return (x & 0x1f) | 0;
}

function gaincPointEntryOffset(groupBaseOffset, group, index) {
  return (
    (groupBaseOffset +
      (group | 0) * AT5_GC_POINT_GROUP_STRIDE_BYTES +
      (index | 0) * AT5_GC_POINT_ENTRY_STRIDE_BYTES) |
    0
  );
}

function clearGaincEntryLinks(view, groupBaseOffset, entryCount) {
  for (let i = 0; i < (entryCount | 0); i += 1) {
    const entryOffset = (groupBaseOffset + i * AT5_GC_POINT_ENTRY_STRIDE_BYTES) | 0;
    writeGaincPointLink(view, entryOffset, AT5_GC_POINT_FIELDS.NEXT_ACTIVE, null);
    writeGaincPointLink(view, entryOffset, AT5_GC_POINT_FIELDS.NEXT_BY_INDEX, null);
    writeGaincPointLink(view, entryOffset, AT5_GC_POINT_FIELDS.PREV_BY_INDEX, null);
  }
}

function gaincEntrySortsBeforeScratchPoint(view, entryOffset, currentOffset) {
  const entryIndex = readGaincPoint(view, entryOffset, AT5_GC_POINT_FIELDS.INDEX);
  const currentIndex = readGaincPoint(view, currentOffset, AT5_GC_POINT_FIELDS.INDEX);
  if (entryIndex !== currentIndex) {
    return entryIndex > currentIndex;
  }

  const entryPointCount = readGaincPoint(view, entryOffset, AT5_GC_POINT_FIELDS.POINT_COUNT) >>> 0;
  const currentPointCount =
    readGaincPoint(view, currentOffset, AT5_GC_POINT_FIELDS.POINT_COUNT) >>> 0;

  // Closing edges keep longer spans first; opening edges keep shorter spans first.
  if (readGaincPoint(view, entryOffset, AT5_GC_POINT_FIELDS.DELTA) < 0) {
    return currentPointCount <= entryPointCount;
  }

  return entryPointCount <= currentPointCount;
}

function insertGaincEntryByIndex(view, sentinelOffset, tailOffset, entryOffset) {
  let previousOffset = sentinelOffset;
  let nextOffset = readGaincPointLink(view, sentinelOffset, AT5_GC_POINT_FIELDS.NEXT_BY_INDEX);

  while (nextOffset !== null && !gaincEntrySortsBeforeScratchPoint(view, entryOffset, nextOffset)) {
    previousOffset = nextOffset;
    nextOffset = readGaincPointLink(view, previousOffset, AT5_GC_POINT_FIELDS.NEXT_BY_INDEX);
  }

  writeGaincPointLink(view, entryOffset, AT5_GC_POINT_FIELDS.NEXT_BY_INDEX, nextOffset);
  writeGaincPointLink(
    view,
    entryOffset,
    AT5_GC_POINT_FIELDS.PREV_BY_INDEX,
    previousOffset === sentinelOffset ? null : previousOffset
  );

  if (nextOffset === null) {
    tailOffset = entryOffset;
  } else {
    writeGaincPointLink(view, nextOffset, AT5_GC_POINT_FIELDS.PREV_BY_INDEX, entryOffset);
  }

  writeGaincPointLink(view, previousOffset, AT5_GC_POINT_FIELDS.NEXT_BY_INDEX, entryOffset);

  return tailOffset;
}

export {
  AT5_GC_POINT_ENTRY_STRIDE_BYTES,
  AT5_GC_POINT_FIELDS,
  AT5_GC_POINT_GROUP_STRIDE_BYTES,
  AT5_GC_POINT_GROUP_ENTRIES,
  clearGaincEntryLinks,
  gaincPointEntryOffset,
  insertGaincEntryByIndex,
  readGaincPoint,
  readGaincPointFlag,
  readGaincPointLink,
  writeGaincPoint,
  writeGaincPointFlag,
  writeGaincPointLink,
  writeGaincPointU32,
  wrapGaincIndexTo32SlotWindow,
};
