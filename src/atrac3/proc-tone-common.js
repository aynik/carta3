import { roundToEvenI32 } from "../common/math.js";
import { AT3ENC_PROC_TABLE_2, AT3ENC_PROC_TABLE_5, AT3ENC_PROC_TABLE_8 } from "./encode-tables.js";
import {
  at3ToneScaleFromIdsf,
  groupIdsfEstimateFromMagKey,
  magicFloatBits,
  readSpectrumMaxKey,
  tableBitlen,
} from "./proc-quant-scale.js";
import { AT3ENC_PROC_TONE_SCALE_WORD, AT3ENC_PROC_TONE_START_WORD } from "./proc-layout.js";

/**
 * Shared ATRAC3 tone-quantization helpers.
 *
 * The high-budget and mono low-budget tone branches both quantize short
 * four-coefficient tone windows into proc words, restore them when a candidate
 * is rejected, and choose tone scales from the same IDSF model.
 */

export const AT3_TONE_REGION_PRIMARY = 0;
export const AT3_TONE_REGION_SECONDARY = 1;
export const AT3_TONE_REGION_COUNT_NONE = 0;
export const AT3_TONE_REGION_COUNT_SINGLE = 1;
export const AT3_TONE_REGION_COUNT_DUAL = 2;
export const AT3_TONE_PASS_SINGLE_LAYOUT = 0;
export const AT3_TONE_PASS_SPLIT_LAYOUT = 1;
export const AT3_TONE_ROW_GROUP_COUNT = 16;

function getToneRestoreTable(base) {
  switch (base) {
    case 3:
      return AT3ENC_PROC_TABLE_2;
    case 5:
      return AT3ENC_PROC_TABLE_5;
    case 7:
      return AT3ENC_PROC_TABLE_8;
    default:
      return null;
  }
}

function signExtendToneCode(rawCode, bitWidth) {
  let code = rawCode | 0;
  if (bitWidth > 0) {
    const signBit = 1 << ((bitWidth - 1) & 0x1f);
    if (signBit <= code) {
      code -= 1 << (bitWidth & 0x1f);
    }
  }
  return code | 0;
}

/** Restores one extracted tone word back into the working spectrum buffer. */
export function restoreToneContribution(spectrum, procWords, toneWord, base, coeffCount) {
  const restoreTable = getToneRestoreTable(base);
  if (restoreTable === null) {
    return;
  }

  const coefficientBitWidth = tableBitlen(restoreTable, 0) | 0;
  const idsf = procWords[toneWord + AT3ENC_PROC_TONE_SCALE_WORD] | 0;
  const start = procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] | 0;
  const scale = at3ToneScaleFromIdsf(base, idsf);
  const invScale = 1 / scale;

  for (let coefficient = coeffCount; coefficient >= 0; coefficient -= 1) {
    const quantizedValue = signExtendToneCode(
      procWords[toneWord + coefficient] | 0,
      coefficientBitWidth
    );
    spectrum[start + coefficient] += quantizedValue * invScale;
  }
}

function countTrailingZeroBits(value) {
  const lowestSetBit = (value & -value) >>> 0;
  return lowestSetBit === 0 ? 32 : 31 - Math.clz32(lowestSetBit);
}

function adjustEvenToneIdsf(idsf, quantizedMask) {
  if ((quantizedMask & 1) !== 0 || idsf > 0x3c) {
    return idsf;
  }

  const maxAdjustments = Math.trunc((0x3c - idsf) / 3) + 1;
  return idsf + Math.min(countTrailingZeroBits(quantizedMask), maxAdjustments) * 3;
}

function measureToneQuantizationError(spectrum, start, count, scale) {
  let maxError = 0;
  let quantizedMask = 0;

  for (let offset = 0; offset < count; offset += 1) {
    const scaledValue = spectrum[start + offset] * scale;
    let quantizedValue = roundToEvenI32(scaledValue);
    quantizedValue = (quantizedValue << 16) >> 16;
    quantizedMask |= quantizedValue;
    const error = Math.abs(scaledValue - quantizedValue);
    if (error > maxError) {
      maxError = error;
    }
  }

  return { maxError, quantizedMask };
}

/** Chooses the tone scale selector that minimizes relative error for up to four coefficients. */
export function setBestIdsf4Tone(spectrum, start, base, count, spectrumU32 = null) {
  const magCount = Math.min(count, 4);
  if (magCount <= 0) {
    return 0;
  }

  const u32 = spectrumU32 ?? new Uint32Array(spectrum.buffer, spectrum.byteOffset, spectrum.length);
  const idsfMin = groupIdsfEstimateFromMagKey(readSpectrumMaxKey(u32, start, magCount)) | 0;
  const idsfMax = Math.min(idsfMin + 2, 0x3f);
  let outIdsf = idsfMax;
  let bestRelativeError = Number.POSITIVE_INFINITY;

  for (let idsf = idsfMax; idsf >= idsfMin; idsf -= 1) {
    const scale = at3ToneScaleFromIdsf(base, idsf);
    if (!Number.isFinite(scale) || scale === 0) {
      continue;
    }

    const { maxError, quantizedMask } = measureToneQuantizationError(spectrum, start, count, scale);
    const relativeError = maxError / scale;
    if (!(bestRelativeError > relativeError)) {
      continue;
    }

    outIdsf = adjustEvenToneIdsf(idsf, quantizedMask);
    bestRelativeError = relativeError;
  }

  return outIdsf | 0;
}

/**
 * Quantizes one four-coefficient tone window into proc words and subtracts the
 * coded contribution from the working spectrum.
 */
export function quantizeToneWord(
  spectrum,
  spectrumU32,
  procWords,
  toneWord,
  start,
  base,
  codeMask,
  bitTableBytes = null,
  bitCost = 0
) {
  const scaleSel = setBestIdsf4Tone(spectrum, start, base, 4, spectrumU32);
  const scale = at3ToneScaleFromIdsf(base, scaleSel);
  if (!Number.isFinite(scale) || scale === 0) {
    return -1;
  }

  const invScale = 1 / scale;
  procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] = start >>> 0;
  procWords[toneWord + AT3ENC_PROC_TONE_SCALE_WORD] = scaleSel >>> 0;
  for (let i = 0; i < 4; i += 1) {
    const idx = start + i;
    const cur = spectrum[idx];
    let q = magicFloatBits(cur, scale) & 0xffff;
    if ((q & 0x8000) !== 0) {
      q -= 0x10000;
    }
    const code = q & codeMask;
    procWords[toneWord + i] = code >>> 0;
    if (bitTableBytes !== null) {
      bitCost += tableBitlen(bitTableBytes, code);
    }
    spectrum[idx] = cur - q * invScale;
  }

  return bitCost;
}
