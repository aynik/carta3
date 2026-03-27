function clampU32(value) {
  return value >>> 0;
}

function coeffPackShift(coeffsPerSymbol) {
  const groupSize = coeffsPerSymbol >>> 0;
  return groupSize <= 1 ? 0 : 31 - Math.clz32(groupSize);
}

export function at5ReadBits24(buf, pos, bits) {
  const width = bits | 0;
  if (width <= 0) {
    return 0;
  }

  const bitpos = pos >>> 0;
  const bytePos = bitpos >>> 3;
  const bitOffset = bitpos & 7;
  const windowBits = bitOffset + width;
  if (width > 24 || windowBits > 24) {
    throw new RangeError("invalid ATRAC3plus bit reader width");
  }

  const b0 = bytePos < buf.length ? buf[bytePos] : 0;
  const b1 = bytePos + 1 < buf.length ? buf[bytePos + 1] : 0;
  const b2 = bytePos + 2 < buf.length ? buf[bytePos + 2] : 0;

  let value = ((b0 << 16) | (b1 << 8) | b2) >>> 0;
  value = ((value << bitOffset) & 0x00ffffff) >>> 0;
  return value >>> (24 - width);
}

export function at5ReadBits(buf, state, bits) {
  const width = bits | 0;
  if (width <= 0) {
    return 0;
  }

  const pos = state.bitpos >>> 0;
  if (state.error) {
    return 0;
  }

  const limitBits = buf.length * 8;
  const nextPos = pos + width;
  if (nextPos > limitBits) {
    state.error = true;
    state.bitpos = nextPos >>> 0;
    return 0;
  }

  const value = at5ReadBits24(buf, pos, width);
  state.bitpos = nextPos >>> 0;
  return value >>> 0;
}

export function at5HcValueMask(desc) {
  return desc?.valueMask ?? 0;
}

export function at5HcPackedSymbolCount(desc, coeffCount) {
  const groupSize = desc?.coeffsPerSymbol ?? 0;
  if (groupSize === 0) {
    return 0;
  }
  return (coeffCount >>> 0) >>> coeffPackShift(groupSize);
}

export function at5DecodeSym(desc, buf, state) {
  const pos = state.bitpos >>> 0;
  const lookup = desc.lookup;
  const codes = desc.codes;

  if (state.error) {
    return 0;
  }

  const limitBits = buf.length * 8;
  if (pos >= limitBits) {
    state.error = true;
    return 0;
  }

  const peekBits = desc?.maxCodewordBits ?? 0;
  const value = at5ReadBits24(buf, pos, peekBits);
  const sym = lookup[value] ?? 0;

  const codeLen = codes[sym * 4 + 2] ?? 0;
  const nextPos = pos + codeLen;
  if (nextPos > limitBits) {
    state.error = true;
    state.bitpos = nextPos >>> 0;
  } else {
    state.bitpos = nextPos >>> 0;
  }
  return sym >>> 0;
}

export function at5SignExtend3Bit(value) {
  const normalized = value & 0x7;
  return (normalized & 0x4) !== 0 ? normalized | ~0x7 : normalized;
}

export function at5SignExtend5Bit(value) {
  const normalized = value & 0x1f;
  return (normalized & 0x10) !== 0 ? normalized | ~0x1f : normalized;
}

export function at5PackStoreFromMsb(value, bits, dst, bitState) {
  if (!(dst instanceof Uint8Array) || !bitState) {
    throw new TypeError("invalid ATRAC3plus bit pack arguments");
  }

  let remaining = bits | 0;
  if (remaining <= 0) {
    return true;
  }

  let pos = bitState.bitpos >>> 0;
  const limit = (dst.length << 3) >>> 0;
  if ((pos + remaining) >>> 0 > limit) {
    return false;
  }

  const valueU32 = clampU32(value);
  let byteIndex = pos >>> 3;

  while (remaining !== 0) {
    const bitOffset = pos & 7;
    const available = 8 - bitOffset;

    if (available > remaining) {
      const shift = available - remaining;
      const mask = ((0xff >>> bitOffset) & (0xff << shift)) >>> 0;
      const out = ((valueU32 << shift) & mask) >>> 0;
      dst[byteIndex] = ((dst[byteIndex] & ~mask) | out) & 0xff;
      pos = (pos + remaining) >>> 0;
      remaining = 0;
    } else {
      remaining -= available;
      const mask = (0xff >>> bitOffset) >>> 0;
      const out = (valueU32 >>> (remaining & 31)) & mask;
      dst[byteIndex] = ((dst[byteIndex] & ~mask) | out) & 0xff;
      pos = (pos + available) >>> 0;
      byteIndex += 1;
    }
  }

  bitState.bitpos = pos >>> 0;
  return true;
}

export function at5PackSym(desc, sym, dst, bitState) {
  const codes = desc?.codes;
  if (!(codes instanceof Uint8Array)) {
    return false;
  }

  const symbol = clampU32(sym);
  const index = (symbol * 4) >>> 0;
  if (index + 2 >= codes.length) {
    return false;
  }

  const code = ((codes[index] | (codes[index + 1] << 8)) & 0xffff) >>> 0;
  const length = codes[index + 2] | 0;
  if (length === 0) {
    return false;
  }
  return at5PackStoreFromMsb(code, length, dst, bitState);
}
