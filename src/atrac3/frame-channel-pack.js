import { CodecError } from "../common/errors.js";
import { roundToEvenI32 } from "../common/math.js";
import { tableBitlen, tableCode } from "./proc-quant-scale.js";

/**
 * Low-level ATRAC3 bit and table packing primitives used by the frame-local
 * channel payload writers.
 */
export function at3encPackTableU16(out, bitpos, tableBytes, idx) {
  if (!(out instanceof Uint8Array)) {
    throw new CodecError("out must be a Uint8Array");
  }
  if (!(tableBytes instanceof Uint8Array)) {
    throw new CodecError("tableBytes must be a Uint8Array");
  }
  if (!Number.isInteger(idx) || idx < 0) {
    throw new CodecError(`invalid table index: ${idx}`);
  }
  if ((idx << 2) + 4 > tableBytes.length) {
    throw new CodecError(`table index ${idx} exceeds table bounds`);
  }

  const code = tableCode(tableBytes, idx);
  const bitlen = tableBitlen(tableBytes, idx);
  const byteIndex = bitpos >>> 3;
  const bitoff = bitpos & 7;
  const value = code >>> bitoff;

  out[byteIndex + 1] = value & 0xff;
  out[byteIndex] |= (value >>> 8) & 0xff;

  return bitpos + bitlen;
}

export function at3encPackBitsU16(out, bitpos, value, width) {
  if (!(out instanceof Uint8Array)) {
    throw new CodecError("out must be a Uint8Array");
  }
  if (!Number.isInteger(width) || width < 0 || width > 16) {
    throw new CodecError(`invalid width: ${width}`);
  }

  const byteIndex = bitpos >>> 3;
  const bitoff = bitpos & 7;
  const shift = 16 - width - bitoff;
  const packed = (value << (shift & 0x1f)) >>> 0;
  out[byteIndex + 1] = packed & 0xff;
  out[byteIndex] |= (packed >>> 8) & 0xff;
  return bitpos + width;
}

export function at3encQuantIdxF32(x, scale, mask) {
  return roundToEvenI32(x * scale) & (mask >>> 0);
}
