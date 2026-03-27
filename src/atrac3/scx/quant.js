import { CodecError } from "../../common/errors.js";
import { AT3_NONTONE_QUANT_ADD_SCALE, AT3_NONTONE_QUANT_LIMIT_BIAS } from "../encode-tables.js";
import { AT3_NBITS_ERROR, quantStepCountForWordLengthIndexAt3 } from "./tables.js";
import { huffbits } from "./huffman.js";

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

function clampQuantizedValue(value, nsteps) {
  return Math.max(-nsteps, Math.min(nsteps, value));
}

function quantizeNontoneValue(value, zeroThreshold, limit, nsteps) {
  if (Math.abs(value) <= Number(zeroThreshold)) {
    return 0;
  }

  const quantized = Math.trunc(value * limit + AT3_NONTONE_QUANT_ADD_SCALE);
  return clampQuantizedValue(quantized - 0x1f, nsteps);
}

export function quantNontoneNspecs(
  tableGroupIdx,
  wordLengthIndex,
  zeroThreshold,
  specCount,
  specs,
  out,
  ctx
) {
  const groupIdx = assertInteger(tableGroupIdx, "tableGroupIdx");
  const idwlIndex = assertInteger(wordLengthIndex, "wordLengthIndex");
  const count = assertInteger(specCount, "specCount");
  const specView = ensureArrayLike(specs, "specs");
  const outView = ensureArrayLike(out, "out");

  if (idwlIndex === 0) {
    return 0;
  }

  const nsteps = quantStepCountForWordLengthIndexAt3(idwlIndex);
  if (nsteps < 0) {
    return AT3_NBITS_ERROR;
  }

  const limit = nsteps + AT3_NONTONE_QUANT_LIMIT_BIAS;
  for (let index = 0; index < count; index += 1) {
    outView[index] = quantizeNontoneValue(
      Number(specView[index] ?? 0),
      zeroThreshold,
      limit,
      nsteps
    );
  }

  const tableSet = ctx && typeof ctx === "object" ? ctx.huffman?.pair?.[groupIdx] : null;
  const table =
    Array.isArray(tableSet) && idwlIndex >= 0 && idwlIndex <= 7 ? tableSet[idwlIndex] : null;
  if (!table || typeof table !== "object") {
    return AT3_NBITS_ERROR;
  }

  const bits = huffbits(table, outView, count);
  return bits === AT3_NBITS_ERROR ? bits : bits + 6;
}
