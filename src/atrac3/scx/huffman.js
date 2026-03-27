import { CodecError } from "../../common/errors.js";
import {
  AT3_HUFF_INIT_BLOCK_A,
  AT3_HUFF_INIT_BLOCK_B,
  AT3_HUFF_PAIR_TABLE_A,
  AT3_HUFF_PAIR_TABLE_B,
  AT3_HUFF_SIZE_TABLE_A,
  AT3_HUFF_SIZE_TABLE_B,
} from "../encode-tables.js";
import { windowLengthForWordLengthIndexAt3 } from "./tables.js";

export const AT3_HUFFBITS_ERROR = -32768;
const AT3_HUFF_MODE_SCALAR = 1;
const AT3_HUFF_MODE_PAIR = 2;

function createHuffTableSet(pairTable, sizeTable, initBlock) {
  const tables = [
    {
      pairShift: 0,
      mode: 0,
      initWord10: 0,
      valueMask: 0,
      entries: new Uint32Array(0),
    },
  ];
  let pairWordOffset = 0;

  for (let index = 1; index <= 7; index += 1) {
    const width = windowLengthForWordLengthIndexAt3(index);
    if (width < 0) {
      throw new CodecError(`invalid IDWL width index: ${index}`);
    }

    const mode = sizeTable[index] | 0;
    const entryCount = (1 << width) ** mode;
    const entryWordCount = entryCount * 2;
    const nextPairWordOffset = pairWordOffset + entryWordCount;

    tables[index] = {
      pairShift: width >>> 0,
      mode,
      initWord10: initBlock[index] >>> 0,
      valueMask: ((1 << width) - 1) >>> 0,
      entries: pairTable.slice(pairWordOffset, nextPairWordOffset),
    };
    pairWordOffset = nextPairWordOffset;
  }

  return tables;
}

function createHuffTableFamily(sizeTable, initBlock) {
  return [AT3_HUFF_PAIR_TABLE_A, AT3_HUFF_PAIR_TABLE_B].map((pairTable) =>
    createHuffTableSet(pairTable, sizeTable, initBlock)
  );
}

export function createAt3ScxHuffTableSets() {
  return {
    huffTablesA: createHuffTableFamily(AT3_HUFF_SIZE_TABLE_A, AT3_HUFF_INIT_BLOCK_A),
    huffTablesB: createHuffTableFamily(AT3_HUFF_SIZE_TABLE_B, AT3_HUFF_INIT_BLOCK_B),
  };
}

function isInt32TypedArray(value) {
  return value instanceof Uint32Array || value instanceof Int32Array;
}

function validateHuffInputs(table, values, count) {
  if (!table || typeof table !== "object") {
    throw new CodecError("table must be an object");
  }
  if (!isInt32TypedArray(values)) {
    throw new CodecError("values must be a Uint32Array or Int32Array");
  }
  if (!Number.isInteger(count) || count < 0 || count > values.length) {
    throw new CodecError(`invalid count: ${count}`);
  }
}

function resolveHuffTableState(table, values, count) {
  validateHuffInputs(table, values, count);
  const mode = table.mode | 0;
  const entries = table.entries;
  if (!(entries instanceof Uint32Array)) {
    return null;
  }
  if (
    (mode !== AT3_HUFF_MODE_SCALAR && mode !== AT3_HUFF_MODE_PAIR) ||
    (mode === AT3_HUFF_MODE_PAIR && (count & 1) !== 0)
  ) {
    return null;
  }

  return {
    mode,
    shift: table.pairShift >>> 0,
    mask: table.valueMask >>> 0,
    entries,
  };
}

function resolveHuffEntryOffset(state, values, index) {
  if (state.mode === AT3_HUFF_MODE_SCALAR) {
    return ((state.mask & (values[index] >>> 0)) * 2) >>> 0;
  }

  const left = state.mask & (values[index] >>> 0);
  const right = state.mask & (values[index + 1] >>> 0);
  return (((left << (state.shift & 31)) | right) * 2) >>> 0;
}

export function huffbits(table, values, count) {
  const state = resolveHuffTableState(table, values, count);
  if (!state) {
    return AT3_HUFFBITS_ERROR;
  }

  const step = state.mode === AT3_HUFF_MODE_SCALAR ? 1 : 2;
  let sum = 0;

  for (let index = 0; index < count; index += step) {
    const entryOffset = resolveHuffEntryOffset(state, values, index);
    if (entryOffset + 1 >= state.entries.length) {
      return AT3_HUFFBITS_ERROR;
    }

    sum += state.entries[entryOffset + 1] | 0;
  }

  return sum | 0;
}

export function packStoreFromMsb(value, bits, dst, bitpos) {
  if (!(dst instanceof Uint8Array)) {
    throw new CodecError("dst must be a Uint8Array");
  }
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new CodecError(`invalid bits: ${bits}`);
  }
  if (!Number.isInteger(bitpos) || bitpos < 0) {
    throw new CodecError(`invalid bitpos: ${bitpos}`);
  }

  let pos = bitpos >>> 0;
  let remaining = bits | 0;
  const input = value >>> 0;

  while (remaining !== 0) {
    const bitOffset = pos & 7;
    const available = 8 - bitOffset;
    const byteIndex = pos >>> 3;
    if (byteIndex >= dst.length) {
      throw new CodecError("packStoreFromMsb wrote past dst bounds");
    }

    if (available > remaining) {
      const shift = available - remaining;
      const mask = (0xff >>> bitOffset) & (0xff << shift) & 0xff;
      const out = (input << shift) & mask & 0xff;
      dst[byteIndex] |= out;
      pos += remaining;
      remaining = 0;
    } else {
      remaining -= available;
      const mask = (0xff >>> bitOffset) & 0xff;
      const out = (input >>> (remaining & 31)) & mask & 0xff;
      dst[byteIndex] |= out;
      pos += available;
    }
  }

  return pos >>> 0;
}

export function packSpecs(table, values, count, dst, bitpos) {
  validateHuffInputs(table, values, count);
  if (!(dst instanceof Uint8Array)) {
    throw new CodecError("dst must be a Uint8Array");
  }
  if (!Number.isInteger(bitpos) || bitpos < 0) {
    throw new CodecError(`invalid bitpos: ${bitpos}`);
  }

  const state = resolveHuffTableState(table, values, count);
  if (!state) {
    return -1;
  }

  const step = state.mode === AT3_HUFF_MODE_SCALAR ? 1 : 2;
  let pos = bitpos >>> 0;

  for (let index = 0; index < count; index += step) {
    const entryOffset = resolveHuffEntryOffset(state, values, index);
    if (entryOffset + 1 >= state.entries.length) {
      return -1;
    }

    pos = packStoreFromMsb(
      state.entries[entryOffset] >>> 0,
      state.entries[entryOffset + 1] | 0,
      dst,
      pos
    );
  }

  return pos | 0;
}
