import { bitsToFloat32 } from "./float32.js";
import { roundToEvenI32 } from "../common/math.js";
import { AT3ENC_PROC_OFFSET_TABLE, AT3ENC_PROC_THRESHOLDS } from "./encode-tables.js";

/**
 * Shared ATRAC3 proc quantization math.
 *
 * This module owns the low-level conversions that multiple proc stages need:
 * scale reconstruction, float-to-quant-domain rounding, coarse group IDSF
 * estimation, and lazy decoding of the packed proc codebooks into fast lookup
 * tables. Keeping those details here keeps the planner and tone path focused
 * on codec decisions rather than packed table plumbing.
 */
const AT3_PROC_SCALE_WORD_MULTIPLIER = 0x2b0000;
const AT3_PROC_SCALE_OFFSET_WORDS = Uint32Array.from(
  { length: AT3ENC_PROC_OFFSET_TABLE.length >> 2 },
  (_, wordIndex) => {
    const offset = wordIndex << 2;
    return (
      (AT3ENC_PROC_OFFSET_TABLE[offset] |
        (AT3ENC_PROC_OFFSET_TABLE[offset + 1] << 8) |
        (AT3ENC_PROC_OFFSET_TABLE[offset + 2] << 16) |
        (AT3ENC_PROC_OFFSET_TABLE[offset + 3] << 24)) >>>
      0
    );
  }
);
const AT3_PROC_TABLE_CACHE = new WeakMap();

function decodeProcTableEntries(tableBytes) {
  const entryCount = tableBytes.length >> 2;
  const codes = new Uint16Array(entryCount);
  const bitLengths = new Uint16Array(entryCount);

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = index << 2;
    codes[index] = (tableBytes[entryOffset] | (tableBytes[entryOffset + 1] << 8)) >>> 0;
    bitLengths[index] = (tableBytes[entryOffset + 2] | (tableBytes[entryOffset + 3] << 8)) >>> 0;
  }

  return { codes, bitLengths };
}

/** Decodes and caches one packed proc table as code and bit-length lanes. */
function getProcTableEntries(tableBytes) {
  let entries = AT3_PROC_TABLE_CACHE.get(tableBytes);
  if (entries) {
    return entries;
  }

  entries = decodeProcTableEntries(tableBytes);
  AT3_PROC_TABLE_CACHE.set(tableBytes, entries);
  return entries;
}

function at3ProcScaleTableWord(index) {
  if (index <= 0) {
    let wordIndex = 15 + index;
    if (wordIndex < 0) {
      wordIndex = 0;
    }
    return AT3_PROC_SCALE_OFFSET_WORDS[wordIndex] >>> 0;
  }

  if (index > 21) {
    index = 21;
  }
  return AT3ENC_PROC_THRESHOLDS[index - 1] >>> 0;
}

function at3ProcScaleFromIndex(base, scaleIndex) {
  const scaleWord = (scaleIndex * AT3_PROC_SCALE_WORD_MULTIPLIER) >>> 0;
  const scaleTableIndex = (3 * ((scaleWord >>> 23) + base) - scaleIndex) | 0;
  const expMask = scaleWord & 0x7f800000;
  const tableBits = at3ProcScaleTableWord(scaleTableIndex);
  return bitsToFloat32((tableBits - expMask) >>> 0);
}

/** Quantizes one scaled coefficient to the signed proc-table code domain. */
export function magicFloatBits(value, scale) {
  return roundToEvenI32(value * scale);
}

/** Maps one packed float magnitude key to the approximate ATRAC3 group IDSF. */
export function groupIdsfEstimateFromMagKey(magKey) {
  const mantissa = magKey & 0x00ffffff;
  let estimate = ((magKey >>> 24) * 3) >>> 0;
  estimate = (estimate - (mantissa <= 0x00965fe9 ? 0x16c : 0x16b)) >>> 0;
  if (mantissa < 0x00428a30) {
    estimate = (estimate - 1) >>> 0;
  }
  return estimate < 0x40 ? estimate : 0;
}

/** Reads the largest packed float magnitude key across one coefficient group. */
export function readSpectrumMaxKey(spectrumU32, start, count = 4) {
  let maxKey = 0;
  for (let i = 0; i < count; i += 1) {
    const key = (spectrumU32[start + i] << 1) >>> 0;
    if (maxKey < key) {
      maxKey = key;
    }
  }
  return maxKey;
}

/** Rebuilds the 256-entry group IDSF estimate table from the working spectrum. */
export function estimateGroupIdsf(spectrum, out) {
  const spectrumU32 = new Uint32Array(spectrum.buffer, spectrum.byteOffset, spectrum.length);
  for (let group = 0; group < 256; group += 1) {
    out[group] = groupIdsfEstimateFromMagKey(readSpectrumMaxKey(spectrumU32, group * 4));
  }
}

/** Resolves the inverse quant scale for one non-tone mode/selector pair. */
export function at3BandScaleFromMode(mode, scaleSel) {
  return at3ProcScaleFromIndex(mode, scaleSel);
}

/** Resolves the inverse quant scale for one tone base/IDSF pair. */
export function at3ToneScaleFromIdsf(base, idsf) {
  return at3ProcScaleFromIndex(base, idsf);
}

/** Reads one cached proc codeword from a packed table entry array. */
export function tableCode(tableBytes, index) {
  return getProcTableEntries(tableBytes).codes[index] >>> 0;
}

/** Reads one cached proc codeword bit length from a packed table entry array. */
export function tableBitlen(tableBytes, index) {
  return getProcTableEntries(tableBytes).bitLengths[index] >>> 0;
}
