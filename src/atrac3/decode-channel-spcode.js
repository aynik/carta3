import {
  AT3_DEC_OFFSET_TABLE,
  AT3_SPCODE_ALT_CODE_TABLES,
  AT3_SPCODE_ALT_SHIFTS,
  AT3_SPCODE_ALT_STEP_TABLES,
  AT3_SPCODE_MAIN_CODE_TABLES,
  AT3_SPCODE_MAIN_STEP_TABLES,
  AT3_SPCODE_PAIR_SCALE,
  AT3_SPCODE_SHIFTS,
  AT3_SPCODE_SCALE_TABLE,
  AT3_SPCODE_VALUE_TABLES,
} from "./decode-tables.js";
import {
  AT3_SPCODE_ERROR_FLAG,
  peekAtrac3Bits,
  readAtrac3Bits,
} from "./decode-channel-transport.js";

const AT3_SPCODE_ALT_TABLE_SELECTOR_BIT = 0x1;
const AT3_SPCODE_FIELDS = 7;
const AT3_SPCODE_PAIR_FIELD_INDEX = 0;
const AT3_SPCODE_PAIRS_PER_CHUNK = 4;
const AT3_SPCODE_PAIR_OUTPUT_STRIDE = AT3_SPCODE_PAIRS_PER_CHUNK * 2;
const AT3_SPCODE_PAIR_SCALE_MAX_SYMBOL = 8;
const AT3_SPCODE_TABLE_SETS = [
  {
    codeTables: AT3_SPCODE_MAIN_CODE_TABLES,
    stepTables: AT3_SPCODE_MAIN_STEP_TABLES,
    bitShifts: AT3_SPCODE_SHIFTS,
  },
  {
    codeTables: AT3_SPCODE_ALT_CODE_TABLES,
    stepTables: AT3_SPCODE_ALT_STEP_TABLES,
    bitShifts: AT3_SPCODE_ALT_SHIFTS,
  },
];

function markSpcodeError(state) {
  // Public ATRAC3 decode only exposes a sticky bitstream error flag.
  state.bitstream.flags |= AT3_SPCODE_ERROR_FLAG;
}

function resolveSpcodeTableConfig(tableSel, fieldIndex) {
  const tableSet =
    AT3_SPCODE_TABLE_SETS[(tableSel & AT3_SPCODE_ALT_TABLE_SELECTOR_BIT) !== 0 ? 1 : 0];

  return {
    codeTable: tableSet.codeTables[fieldIndex],
    stepTable: tableSet.stepTables[fieldIndex],
    valueTable: AT3_SPCODE_VALUE_TABLES[fieldIndex],
    bitWidth: 16 - tableSet.bitShifts[fieldIndex],
  };
}

function decodeAtrac3PairSpcode(state, tableConfig, scale, out, outStart, outEnd) {
  const { codeTable, stepTable, bitWidth } = tableConfig;
  const { bitstream } = state;
  const { stream } = bitstream;
  let bitpos = bitstream.bitpos;

  // Pair field 0 expands one codeword into four packed coefficient pairs.
  for (
    let pairChunkStart = outStart;
    pairChunkStart < outEnd;
    pairChunkStart += AT3_SPCODE_PAIR_OUTPUT_STRIDE
  ) {
    for (let pairIndex = 0; pairIndex < AT3_SPCODE_PAIRS_PER_CHUNK; pairIndex += 1) {
      const code = peekAtrac3Bits(stream, bitpos, bitWidth);
      const symbol = codeTable[code];
      if (symbol < 0 || symbol > AT3_SPCODE_PAIR_SCALE_MAX_SYMBOL) {
        markSpcodeError(state);
        return;
      }

      const pairOutputIndex = pairChunkStart + pairIndex * 2;
      out[pairOutputIndex] += AT3_SPCODE_PAIR_SCALE[symbol] * scale;
      out[pairOutputIndex + 1] += AT3_SPCODE_PAIR_SCALE[symbol + 1] * scale;
      bitpos += stepTable[symbol];
    }
  }

  bitstream.bitpos = bitpos;
}

function decodeAtrac3ScalarSpcode(state, tableConfig, scale, out, outStart, outEnd) {
  const { codeTable, stepTable, valueTable, bitWidth } = tableConfig;
  if (!valueTable) {
    markSpcodeError(state);
    return;
  }

  const { bitstream } = state;
  const { stream } = bitstream;
  let bitpos = bitstream.bitpos;
  for (let outputIndex = outStart; outputIndex < outEnd; outputIndex += 1) {
    const code = peekAtrac3Bits(stream, bitpos, bitWidth);
    const symbol = codeTable[code];
    if (symbol < 0) {
      markSpcodeError(state);
      return;
    }

    bitpos += stepTable[symbol];
    out[outputIndex] += valueTable[symbol] * scale;
  }

  bitstream.bitpos = bitpos;
}

/** Decodes one sparse ATRAC3 SPCODE field into the destination spectrum. */
export function decodeSpcode(state, tableSel, fieldIndex, scale, out, outStart, outEnd) {
  if (!state?.bitstream || !out) {
    return;
  }

  const normalizedFieldIndex = fieldIndex | 0;
  if (normalizedFieldIndex < 0 || normalizedFieldIndex >= AT3_SPCODE_FIELDS) {
    markSpcodeError(state);
    return;
  }

  const tableConfig = resolveSpcodeTableConfig(tableSel, normalizedFieldIndex);
  if (normalizedFieldIndex === AT3_SPCODE_PAIR_FIELD_INDEX) {
    decodeAtrac3PairSpcode(state, tableConfig, scale, out, outStart, outEnd);
    return;
  }

  decodeAtrac3ScalarSpcode(state, tableConfig, scale, out, outStart, outEnd);
}

function collectAtrac3GroupedSpectrumEntries(state, groupCount) {
  const { bitstream } = state;
  const activeGroups = [];

  for (let group = 0; group < groupCount; group += 1) {
    const spcodeIndex = (readAtrac3Bits(bitstream, 3) & 7) - 1;
    if (spcodeIndex >= 0) {
      activeGroups.push({ group, scaleIndex: 0, spcodeIndex });
    }
  }

  for (const activeGroup of activeGroups) {
    activeGroup.scaleIndex = readAtrac3Bits(bitstream, 6) & 0x3f;
  }

  return activeGroups;
}

/**
 * Decodes the grouped non-tonal SPCODE payload that follows the optional tone
 * patch passes inside one ATRAC3 channel body.
 */
export function decodeAtrac3GroupedSpectrum(state, spectrum) {
  const { bitstream } = state;
  const groupCount = (readAtrac3Bits(bitstream, 5) & 0x1f) + 1;
  const groupTableSel = readAtrac3Bits(bitstream, 1) & 1;
  const groupedMaxCoeffIndex = AT3_DEC_OFFSET_TABLE[groupCount];

  // Grouped SPCODEs fill the remaining non-tonal coefficient bands. The
  // grouped scale prelude only exists for bands whose selector is active, so
  // keep those selectors and scales together while the remaining payload is
  // decoded.
  const activeGroups = collectAtrac3GroupedSpectrumEntries(state, groupCount);
  for (const { group, scaleIndex, spcodeIndex } of activeGroups) {
    decodeSpcode(
      state,
      groupTableSel,
      spcodeIndex,
      AT3_SPCODE_SCALE_TABLE[scaleIndex],
      spectrum,
      AT3_DEC_OFFSET_TABLE[group],
      AT3_DEC_OFFSET_TABLE[group + 1]
    );
  }

  return groupedMaxCoeffIndex;
}
