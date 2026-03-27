import { CodecError } from "../../common/errors.js";
import { AT3_ITB_GROUP_TABLE } from "../encode-tables.js";
import { getAt3GainControlCount } from "./gainc-layout.js";
import { huffbits } from "./huffman.js";
import {
  AT3_NBITS_ERROR,
  spectrumOffsetForQuantBandAt3,
  spectrumSampleCountForQuantBandAt3,
  toneWidthForTwiddleIdAt3,
  windowLengthForWordLengthIndexAt3,
} from "./tables.js";

const AT3_COMPONENT_MODE_INVALID = 3;
const AT3_TONE_POOL_MAX_INDEX = 0x3f;

export function toInt(value, name) {
  if (!Number.isInteger(value)) {
    throw new CodecError(`${name} must be an integer`);
  }
  return value | 0;
}

export function resolveGlobalState(ch) {
  const globalState = ch?.globalState;
  return globalState && typeof globalState === "object" ? globalState : null;
}

export function resolveComponentGroupCount(ch) {
  return toInt(ch?.componentGroupCount ?? 0, "componentGroupCount");
}

export function isArrayLike(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

function toU32View(values, start, count) {
  if (ArrayBuffer.isView(values) && typeof values.subarray === "function") {
    return values.subarray(start, start + count);
  }
  if (Array.isArray(values)) {
    return Int32Array.from(values.slice(start, start + count));
  }
  throw new CodecError("expected an array-like numeric buffer");
}

export function at3BitsToBytesCeil(bits) {
  let tmp = bits + 7;
  if (tmp < 0) {
    tmp = bits + 14;
  }
  return tmp >> 3;
}

function itbgrpofItbAt3(index) {
  if (!Number.isInteger(index) || index < 0 || index >= AT3_ITB_GROUP_TABLE.length) {
    return -1;
  }
  return AT3_ITB_GROUP_TABLE[index] | 0;
}

function resolveTableSet(tableSets, tableSetIndex) {
  if (!Array.isArray(tableSets) || tableSetIndex < 0 || tableSetIndex > 1) {
    return null;
  }

  const tables = tableSets[tableSetIndex];
  return Array.isArray(tables) ? tables : null;
}

function resolveHuffTable(tables, tableIndex) {
  if (tableIndex < 0 || tableIndex > 7) {
    return null;
  }

  const table = tables[tableIndex];
  return table && typeof table === "object" ? table : null;
}

/**
 * Resolves the component-tone packing plan shared by SCX bit accounting and
 * SCX bitstream writing.
 */
export function resolveComponentPlan(ch, entryCount, { throwOnMissingEntries = false } = {}) {
  const componentMode = toInt(ch?.componentMode ?? 0, "componentMode");
  if (componentMode === AT3_COMPONENT_MODE_INVALID) {
    return null;
  }

  const tableSets = resolveGlobalState(ch)?.huffman?.scalar;
  if (!Array.isArray(tableSets)) {
    return null;
  }

  const entries = ch?.mddataEntries;
  if (!Array.isArray(entries)) {
    if (throwOnMissingEntries) {
      throw new CodecError("mddataEntries must be an array");
    }
    return null;
  }

  const groupCount = resolveComponentGroupCount(ch);
  const resolvedEntries = [];
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const entry = entries[entryIndex];
    const baseIndex = toInt(entry?.huffTableBaseIndex ?? 0, "huffTableBaseIndex");
    if (windowLengthForWordLengthIndexAt3(baseIndex) === -1) {
      return null;
    }

    const tables = resolveTableSet(
      tableSets,
      toInt(entry?.huffTableSetIndex ?? 0, "huffTableSetIndex")
    );
    const table = tables ? resolveHuffTable(tables, baseIndex) : null;
    if (!table) {
      return null;
    }

    const twiddleId = toInt(entry?.twiddleId ?? 0, "twiddleId");
    let toneWidth = toneWidthForTwiddleIdAt3(twiddleId);
    if (toneWidth === -1) {
      return null;
    }

    const groups = [];
    for (let outer = 0; outer < groupCount * 4; outer += 1) {
      const group = itbgrpofItbAt3(outer);
      if (group === -1) {
        return null;
      }
      if ((entry?.groupFlags?.[group] | 0) === 0) {
        continue;
      }

      const listCount = toInt(entry?.listCounts?.[outer] ?? 0, "listCount");
      const tones = [];
      for (let listIndex = 0; listIndex < listCount; listIndex += 1) {
        const tonePoolIndex = toInt(entry?.lists?.[outer]?.[listIndex] ?? 0, "tonePoolIndex");
        if (tonePoolIndex < 0 || tonePoolIndex > AT3_TONE_POOL_MAX_INDEX) {
          return null;
        }

        const tone = ch?.tonePool?.[tonePoolIndex];
        if (!tone?.coefficients) {
          return null;
        }

        const toneStart = toInt(tone?.start ?? 0, "tone.start");
        if (toneWidth + toneStart > 0x400) {
          toneWidth = 0x400 - toneStart;
        }
        if (toneWidth < 0) {
          return null;
        }

        tones.push({
          tone,
          toneStart,
          toneWidth,
          coeffs: toU32View(tone.coefficients, 0, 8),
        });
      }

      groups.push({ listCount, tones });
    }

    resolvedEntries.push({ entry, twiddleId, baseIndex, table, groups });
  }

  return { componentMode, groupCount, resolvedEntries };
}

/**
 * Resolves the spectrum packing section shared by SCX bit accounting and
 * bitstream writing.
 */
export function resolveSpectrumSection(ch, { requireQuidsf = false } = {}) {
  const groupCount = toInt(ch?.specGroupCount ?? 0, "specGroupCount");
  const idwl = ch?.idwl;
  if (!idwl) {
    throw new CodecError("idwl must be present");
  }

  const specTableIndex = toInt(ch?.specTableIndex ?? 0, "specTableIndex");
  const tables = resolveTableSet(resolveGlobalState(ch)?.huffman?.pair, specTableIndex);
  if (!tables) {
    return null;
  }

  const quantSpecs = ch?.quantSpecs;
  if (!quantSpecs) {
    return null;
  }

  const quidsf = ch?.quidsf;
  if (requireQuidsf && !quidsf) {
    return null;
  }

  return {
    groupCount,
    idwl,
    specTableIndex,
    tables,
    quantSpecs,
    quidsf,
  };
}

export function collectActiveSpectrumBands(groupCount, idwl, tables, quantSpecs) {
  const activeBands = [];
  for (let bandIndex = 0; bandIndex < groupCount; bandIndex += 1) {
    const idwlValue = toInt(idwl[bandIndex] ?? 0, `idwl[${bandIndex}]`);
    if (idwlValue < 0 || idwlValue > 7) {
      return null;
    }
    if (idwlValue === 0) {
      continue;
    }

    if (windowLengthForWordLengthIndexAt3(idwlValue) <= 0) {
      return null;
    }

    const table = resolveHuffTable(tables, idwlValue);
    if (!table) {
      return null;
    }

    const specOffset = spectrumOffsetForQuantBandAt3(bandIndex);
    const specCount = spectrumSampleCountForQuantBandAt3(bandIndex);
    if (specOffset === -1 || specCount === -1) {
      return null;
    }

    activeBands.push({
      bandIndex,
      table,
      specCount,
      specs: toU32View(quantSpecs, specOffset, specCount),
    });
  }

  return activeBands;
}

function nbitsForExplicitAdjust(frame, adjustEntries) {
  const count = toInt(frame?.adjustBlockCount ?? 0, "adjustBlockCount");
  if (count < 0 || count > adjustEntries.length) {
    throw new CodecError("adjustBlockCount exceeds adjustEntries length");
  }

  let wordSum = 0;
  for (let index = 0; index < count; index += 1) {
    wordSum += toInt(adjustEntries[index] ?? 0, `adjustEntries[${index}]`);
  }
  return (count * 3 + wordSum * 9) | 0;
}

function nbitsForGaincAdjust(frame, gaincParams) {
  const count = resolveComponentGroupCount(frame);
  if (count < 0 || count > gaincParams.length) {
    throw new CodecError("componentGroupCount exceeds gaincParams length");
  }

  let wordSum = 0;
  for (let index = 0; index < count; index += 1) {
    wordSum += getAt3GainControlCount(gaincParams[index]);
  }
  return (count * 3 + wordSum * 9) | 0;
}

export function nbitsForAdjust(frame) {
  const explicitEntries = frame?.adjustEntries;
  if (isArrayLike(explicitEntries)) {
    return nbitsForExplicitAdjust(frame, explicitEntries);
  }
  if (isArrayLike(frame?.gaincParams)) {
    return nbitsForGaincAdjust(frame, frame.gaincParams);
  }
  throw new CodecError("adjustEntries or gaincParams must be an array-like of numeric values");
}

export function nbitsForSheader(frame) {
  return (toInt(frame?.scratchFlag ?? 0, "scratchFlag") === 1 ? 16 : 8) | 0;
}

export function nbitsForPackdata(frame, componentBits, spectrumBits) {
  const comp = toInt(componentBits, "componentBits");
  if (comp === AT3_NBITS_ERROR) {
    return AT3_NBITS_ERROR;
  }

  const spec = toInt(spectrumBits, "spectrumBits");
  if (spec === AT3_NBITS_ERROR) {
    return AT3_NBITS_ERROR;
  }

  return (comp + spec + nbitsForSheader(frame) + nbitsForAdjust(frame)) | 0;
}

export function nbitsForComponent(ctx) {
  const entryCount = toInt(ctx?.mddataEntryIndex ?? 0, "mddataEntryIndex");
  if (entryCount < 0) {
    return AT3_NBITS_ERROR;
  }

  let bits = entryCount > 0 ? 7 : 5;
  if (entryCount === 0) {
    return bits;
  }

  const sectionState = resolveComponentPlan(ctx, entryCount, {
    throwOnMissingEntries: true,
  });
  if (!sectionState) {
    return AT3_NBITS_ERROR;
  }
  const { groupCount, resolvedEntries } = sectionState;

  for (const resolvedEntry of resolvedEntries) {
    bits = (bits + (groupCount > 0 ? groupCount : 0) + 6) | 0;
    for (const { tones } of resolvedEntry.groups) {
      bits += 3;
      for (const componentTone of tones) {
        bits += 12;
        const toneBits = huffbits(
          resolvedEntry.table,
          componentTone.coeffs,
          componentTone.toneWidth
        );
        if (toneBits === AT3_NBITS_ERROR) {
          return AT3_NBITS_ERROR;
        }
        bits += toneBits;
      }
    }
  }

  return bits | 0;
}

export function nbitsForSpectrum(ctx) {
  const spectrumSection = resolveSpectrumSection(ctx);
  if (!spectrumSection) {
    return AT3_NBITS_ERROR;
  }
  const activeBands = collectActiveSpectrumBands(
    spectrumSection.groupCount,
    spectrumSection.idwl,
    spectrumSection.tables,
    spectrumSection.quantSpecs
  );
  if (!activeBands) {
    return AT3_NBITS_ERROR;
  }

  let payloadBits = 0;
  for (const band of activeBands) {
    const nbits = huffbits(band.table, band.specs, band.specCount);
    if (nbits === AT3_NBITS_ERROR) {
      return AT3_NBITS_ERROR;
    }
    payloadBits += 6 + nbits;
  }

  return (spectrumSection.groupCount * 3 + 6 + payloadBits) | 0;
}

export function nbitsForPackdataAt3(ctx) {
  const componentBits = nbitsForComponent(ctx);
  if (componentBits === AT3_NBITS_ERROR) {
    return componentBits;
  }

  const spectrumBits = nbitsForSpectrum(ctx);
  if (spectrumBits === AT3_NBITS_ERROR) {
    return spectrumBits;
  }

  return nbitsForPackdata(ctx, componentBits, spectrumBits);
}
