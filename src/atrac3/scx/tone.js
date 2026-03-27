import { CodecError } from "../../common/errors.js";
import {
  AT3_QUANT_ADD_SCALE,
  AT3_QUANT_LIMIT_BIAS,
  AT3_TONE_LIMIT_BIAS,
} from "../encode-tables.js";
import { huffbits } from "./huffman.js";
import {
  AT3_NBITS_ERROR,
  quantStepCountForWordLengthIndexAt3,
  scaleFactorIndexForValueAt3,
  scaleFactorValueForIndexAt3,
  toneWidthForTwiddleIdAt3,
} from "./tables.js";

const AT3_MAX_SPEC_INDEX = 0x3ff;
const AT3_TONE_HUFFMAN_OVERHEAD_BITS = 0x0c;

function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new CodecError(`${name} must be an integer`);
  }
  return value;
}

function ensureArrayLike(value, name) {
  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    return value;
  }
  throw new CodecError(`${name} must be an array-like numeric buffer`);
}

export function quantAt3(spec, scale, nsteps) {
  const steps = assertInteger(nsteps, "nsteps");
  const limit = steps + AT3_QUANT_LIMIT_BIAS;
  const quantized = Math.trunc((Number(spec) / Number(scale)) * limit + AT3_QUANT_ADD_SCALE);
  return Math.max(-steps, Math.min(steps, quantized - 0x1f));
}

export function quantToneSpecs(specs, tone, ctx) {
  const specView = ensureArrayLike(specs, "specs");
  const twiddleId = assertInteger(tone?.twiddleId ?? 0, "tone.twiddleId");
  const width = toneWidthForTwiddleIdAt3(twiddleId);
  const huffTableBaseIndex = assertInteger(
    tone?.huffTableBaseIndex ?? 0,
    "tone.huffTableBaseIndex"
  );
  const nsteps = quantStepCountForWordLengthIndexAt3(huffTableBaseIndex);
  if (width === -1 || nsteps === -1) {
    return AT3_NBITS_ERROR;
  }
  const start = assertInteger(tone?.start ?? 0, "tone.start");
  const count = Math.max(0, Math.min(width, AT3_MAX_SPEC_INDEX - start + 1));
  const coefficients = ensureArrayLike(tone?.coefficients, "tone.coefficients");

  let absMax = 0;
  for (let index = 0; index < count; index += 1) {
    const value = Math.abs(Number(specView[start + index] ?? 0));
    if (value > absMax) {
      absMax = value;
    }
  }

  const scaleFactorIndex = scaleFactorIndexForValueAt3(absMax);
  const scaleFactor = scaleFactorValueForIndexAt3(scaleFactorIndex);
  if (scaleFactor < 0) {
    return AT3_NBITS_ERROR;
  }
  tone.scaleFactorIndex = scaleFactorIndex;

  const huffTableSetIndex = assertInteger(tone?.huffTableSetIndex ?? 0, "tone.huffTableSetIndex");
  const huffTablesB = ctx && typeof ctx === "object" ? ctx.huffman?.scalar : null;
  if (
    !Array.isArray(huffTablesB) ||
    huffTableSetIndex < 0 ||
    huffTableSetIndex > 1 ||
    huffTableBaseIndex < 0 ||
    huffTableBaseIndex > 7
  ) {
    return AT3_NBITS_ERROR;
  }
  const table = huffTablesB[huffTableSetIndex]?.[huffTableBaseIndex] ?? null;
  if (!table || typeof table !== "object") {
    return AT3_NBITS_ERROR;
  }

  for (let index = 0; index < count; index += 1) {
    coefficients[index] = quantAt3(Number(specView[start + index] ?? 0), scaleFactor, nsteps);
  }
  coefficients.fill(0, count, width);

  const bits = huffbits(table, coefficients, width);
  return bits === AT3_NBITS_ERROR ? bits : bits + AT3_TONE_HUFFMAN_OVERHEAD_BITS;
}

export function extractToneSpecs(tone, out) {
  const outView = ensureArrayLike(out, "out");
  const width = toneWidthForTwiddleIdAt3(assertInteger(tone?.twiddleId ?? 0, "tone.twiddleId"));
  const huffTableBaseIndex = assertInteger(
    tone?.huffTableBaseIndex ?? 0,
    "tone.huffTableBaseIndex"
  );
  const nsteps = quantStepCountForWordLengthIndexAt3(huffTableBaseIndex);
  if (width === -1 || nsteps === -1) {
    return -1;
  }
  const start = assertInteger(tone?.start ?? 0, "tone.start");
  const count = Math.max(0, Math.min(width, AT3_MAX_SPEC_INDEX - start + 1));
  const coefficients = ensureArrayLike(tone?.coefficients, "tone.coefficients");

  const scaleFactor = scaleFactorValueForIndexAt3(
    assertInteger(tone?.scaleFactorIndex ?? 0, "tone.scaleFactorIndex")
  );
  if (scaleFactor < 0) {
    return -1;
  }

  const factor = scaleFactor / (nsteps + AT3_TONE_LIMIT_BIAS);
  for (let index = 0; index < count; index += 1) {
    const specIndex = start + index;
    outView[specIndex] =
      Number(outView[specIndex] ?? 0) - factor * Number(coefficients[index] ?? 0);
  }
  return 0;
}
