import { AT5_HC_WL, AT5_SG_SHAPE_INDEX, AT5_WLC_COEF, AT5_WLC_SG_CB } from "../tables/unpack.js";
import { at5PackStoreFromMsb, at5PackSym } from "./bitstream.js";
import { CodecError } from "../../common/errors.js";
import {
  computeRowMetaAndBandCountsForRow,
  refreshIdwlRowBandCountsForIndex,
  resetIdwlRowBandCounts,
} from "./idwl-rows.js";
import { calcIdwlSgAt5 } from "./idwl-sg.js";
import {
  AT5_IDWL_CONFIG_BAND_COUNT,
  AT5_IDWL_CONFIG_EXTRA_WORD,
  AT5_IDWL_CONFIG_GROUP,
  AT5_IDWL_CONFIG_ROW,
  AT5_IDWL_CONFIG_WL,
  buildIdwlGroupPlans,
  buildIdwlRowGroupPlans,
  findCheapestIdwlGroupPlan,
  findCheapestPositiveIdwlGroupPlan,
  findCheapestPositiveIdwlRowPlan,
  idwlBandLimit,
  idwlEncodeMode,
  idwlScratchConfigForSlot,
  idwlWlcCodes,
  idwlWlcCoefRow,
} from "./idwl-shared.js";
import {
  AT5_IDWL_WORK_GROUP_STRIDE,
  AT5_IDWL_WORK_GROUP_VALUES,
  AT5_IDWL_WORK_GROUP_VALUES_OFFSET,
  AT5_IDWL_WORK_SG_COPY_BYTES,
  idwlWorkSetMode1Base,
  idwlWorkSetMode1Lead,
  idwlWorkSetMode1Width,
  idwlWorkSetMode2PairFlag,
  idwlWorkU8,
} from "./idwl-work.js";

/**
 * Internal IDWL bitstream helpers.
 *
 * Public IDWL callers only need state builders, error codes, and unpacking.
 * Encode-side packers, bit planners, and WLC copy helpers stay here.
 */
export {
  AT5_IDWL_ERROR_CODES,
  createAt5IdwlChannelState,
  createAt5IdwlSharedState,
  unpackIdwl,
} from "./idwl.js";

function buildIdwlMode1GroupPlan(rowSeq, bandCount) {
  const count = bandCount | 0;
  if (count <= 0) {
    return { rawCost: 0, cutoff: 0, width: 0, base: 0 };
  }

  let cutoffExact = count | 0;
  let cutoffRange1 = count | 0;
  let cutoffRange3 = count | 0;
  let baseExact = 0;
  let baseRange1 = 0;
  let baseRange3 = 0;

  let maxValue = 0;
  let minValue = 7;
  let trackingExact = 1;
  let trackingRange1 = 1;
  let trackingRange3 = 1;

  for (let index = count - 1; index >= 0; index -= 1) {
    const value = rowSeq[index] | 0;
    maxValue = Math.max(maxValue, value);
    minValue = Math.min(minValue, value);

    if (trackingExact) {
      if (((maxValue - minValue) | 0) <= 0) {
        cutoffExact = index | 0;
        baseExact = minValue | 0;
      } else {
        cutoffExact = (index + 1) | 0;
        trackingExact = 0;
      }
    }

    if (trackingRange1) {
      if (((maxValue - minValue) | 0) <= 1) {
        cutoffRange1 = index | 0;
        baseRange1 = minValue | 0;
      } else {
        cutoffRange1 = (index + 1) | 0;
        trackingRange1 = 0;
      }
    }

    if (trackingRange3) {
      if (((maxValue - minValue) | 0) <= 3) {
        cutoffRange3 = index | 0;
        baseRange3 = minValue | 0;
      } else {
        cutoffRange3 = (index + 1) | 0;
        trackingRange3 = 0;
      }
    }
  }

  let bestWidth = 3;
  let bestBits = count * 3;
  let bestCutoff = count | 0;
  let bestBase = 0;

  let cutoff = cutoffExact | 0;
  let bits = (cutoff * 3) | 0;
  if (bits < (bestBits | 0)) {
    bestBits = bits | 0;
    bestWidth = 0;
    bestCutoff = cutoff | 0;
    bestBase = baseExact | 0;
  }

  cutoff = cutoffRange1 | 0;
  bits = (cutoff * 3 + (count - cutoff)) | 0;
  if (bits < (bestBits | 0)) {
    bestBits = bits | 0;
    bestWidth = 1;
    bestCutoff = cutoff | 0;
    bestBase = baseRange1 | 0;
  }

  cutoff = cutoffRange3 | 0;
  bits = (cutoff * 3 + (count - cutoff) * 2) | 0;
  if (bits < (bestBits | 0)) {
    bestBits = bits | 0;
    bestWidth = 2;
    bestCutoff = cutoff | 0;
    bestBase = baseRange3 | 0;
  }

  return {
    rawCost: (bestBits + 10) | 0,
    cutoff: bestCutoff | 0,
    width: bestWidth | 0,
    base: bestBase | 0,
  };
}

export function calcNbitsForIdwl1At5(channel, scratch) {
  const bandLimit = idwlBandLimit(channel?.shared) | 0;
  const channelIndex = (channel?.channelIndex ?? 0) | 0;
  const rowPlans = new Array(4);

  for (let row = 0; row < 4; row += 1) {
    if ((scratch.rowEnabled[row] | 0) === 0) {
      continue;
    }

    const rowSeq = scratch.rowSeq[row];
    rowPlans[row] = buildIdwlRowGroupPlans(
      scratch,
      row,
      bandLimit,
      channelIndex,
      (_group, bandCount) => buildIdwlMode1GroupPlan(rowSeq, bandCount),
      { adjustZeroCost: false }
    );
  }

  const { row: bestRow, plan: selectedPlan } = findCheapestPositiveIdwlRowPlan(rowPlans);
  scratch.slot1Config[AT5_IDWL_CONFIG_WL] = 0;
  scratch.slot1Config[AT5_IDWL_CONFIG_GROUP] = selectedPlan?.group ?? 0;
  scratch.slot1Config[AT5_IDWL_CONFIG_BAND_COUNT] = selectedPlan?.bandCount ?? 0;
  scratch.slot1Config[AT5_IDWL_CONFIG_EXTRA_WORD] = scratch.extraWordByIndex[bestRow] | 0;
  scratch.slot1Config[AT5_IDWL_CONFIG_ROW] = bestRow | 0;

  const workU8 = idwlWorkU8(scratch);
  idwlWorkSetMode1Lead(workU8, selectedPlan?.cutoff ?? 0);
  idwlWorkSetMode1Width(workU8, selectedPlan?.width ?? 0);
  idwlWorkSetMode1Base(workU8, selectedPlan?.base ?? 0);

  return ((selectedPlan?.adjustedCost ?? 0) + 4) | 0;
}

export function calcNbitsForIdwl2SubAt5(scratch, bestSelOut, idx) {
  const valueCount = scratch.bandCountBySlot[idx | 0] | 0;
  if (valueCount <= 0) {
    return 0;
  }

  const workU8 = idwlWorkU8(scratch);
  const base = ((idx | 0) * AT5_IDWL_WORK_GROUP_STRIDE + AT5_IDWL_WORK_GROUP_VALUES_OFFSET) | 0;
  const values = new Int32Array(
    workU8.buffer,
    workU8.byteOffset + base,
    AT5_IDWL_WORK_GROUP_VALUES
  );

  const wl0 = idwlWlcCodes(0);
  const wl1 = idwlWlcCodes(1);
  if (!wl0 || !wl1) {
    throw new CodecError("missing IDWL huffman codes");
  }

  let bitsWl0 = 0;
  let bitsWl1 = 0;
  let bitsPairWl0 = 0;
  let bitsPairWl1 = 0;

  for (let index = 0; index < valueCount; index += 1) {
    const value = values[index] | 0;
    if ((value - 3) >>> 0 <= 2) {
      return 0;
    }
    const codeOffset = ((value >>> 0) * 4 + 2) | 0;
    bitsWl0 = (bitsWl0 + (wl0[codeOffset] | 0)) | 0;
    bitsWl1 = (bitsWl1 + (wl1[codeOffset] | 0)) | 0;
  }

  const pairCount = valueCount >> 1;
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const start = pairIndex * 2;
    bitsPairWl0 = (bitsPairWl0 + 1) | 0;
    bitsPairWl1 = (bitsPairWl1 + 1) | 0;

    if ((values[start] | 0) === 0 && (values[start + 1] | 0) === 0) {
      continue;
    }

    for (let offset = 0; offset < 2; offset += 1) {
      const value = values[start + offset] | 0;
      const codeOffset = ((value >>> 0) * 4 + 2) | 0;
      bitsPairWl0 = (bitsPairWl0 + (wl0[codeOffset] | 0)) | 0;
      bitsPairWl1 = (bitsPairWl1 + (wl1[codeOffset] | 0)) | 0;
    }
  }

  for (let index = pairCount * 2; index < valueCount; index += 1) {
    const value = values[index] | 0;
    const codeOffset = ((value >>> 0) * 4 + 2) | 0;
    bitsPairWl0 = (bitsPairWl0 + (wl0[codeOffset] | 0)) | 0;
    bitsPairWl1 = (bitsPairWl1 + (wl1[codeOffset] | 0)) | 0;
  }

  let bestIndex = 3;
  let bestBits = bitsPairWl1 | 0;
  if ((bitsPairWl0 | 0) < (bestBits | 0)) {
    bestBits = bitsPairWl0 | 0;
    bestIndex = 2;
  }
  if ((bitsWl1 | 0) < (bestBits | 0)) {
    bestBits = bitsWl1 | 0;
    bestIndex = 1;
  }
  if ((bitsWl0 | 0) < (bestBits | 0)) {
    bestBits = bitsWl0 | 0;
    bestIndex = 0;
  }

  bestSelOut[0] = bestIndex | 0;
  return (bestBits + 9) | 0;
}

function buildIdwlMode3GroupPlan(rowSeq, bandCount, wlTables) {
  const count = bandCount | 0;
  if (count <= 0) {
    return { rawCost: 0, wl: 0 };
  }

  let bitsWl0 = 0;
  let bitsWl1 = 0;
  let bitsWl2 = 0;
  let bitsWl3 = 0;
  for (let index = 1; index < count; index += 1) {
    const delta = ((rowSeq[index] | 0) - (rowSeq[index - 1] | 0)) & 0x7;
    const codeOffset = ((delta >>> 0) * 4 + 2) | 0;
    bitsWl0 = (bitsWl0 + (wlTables[0][codeOffset] | 0)) | 0;
    bitsWl1 = (bitsWl1 + (wlTables[1][codeOffset] | 0)) | 0;
    bitsWl2 = (bitsWl2 + (wlTables[2][codeOffset] | 0)) | 0;
    bitsWl3 = (bitsWl3 + (wlTables[3][codeOffset] | 0)) | 0;
  }

  let bestWl = 0;
  let bestBits = bitsWl0 | 0;
  if ((bitsWl1 | 0) < (bestBits | 0)) {
    bestBits = bitsWl1 | 0;
    bestWl = 1;
  }
  if ((bitsWl2 | 0) < (bestBits | 0)) {
    bestBits = bitsWl2 | 0;
    bestWl = 2;
  }
  if ((bitsWl3 | 0) < (bestBits | 0)) {
    bestBits = bitsWl3 | 0;
    bestWl = 3;
  }

  return {
    rawCost: (bestBits + 5) | 0,
    wl: bestWl | 0,
  };
}

export function calcNbitsForIdwl3At5(channel, scratch) {
  const bandLimit = idwlBandLimit(channel?.shared) | 0;
  const channelIndex = (channel?.channelIndex ?? 0) | 0;
  const wlTables = [idwlWlcCodes(0), idwlWlcCodes(1), idwlWlcCodes(2), idwlWlcCodes(3)];
  if (wlTables.some((table) => !table)) {
    throw new CodecError("missing IDWL huffman codes");
  }

  const rowPlans = new Array(4);
  for (let row = 0; row < 4; row += 1) {
    if ((scratch.rowEnabled[row] | 0) === 0) {
      continue;
    }

    const rowSeq = scratch.rowSeq[row];
    rowPlans[row] = buildIdwlRowGroupPlans(
      scratch,
      row,
      bandLimit,
      channelIndex,
      (_group, bandCount) => buildIdwlMode3GroupPlan(rowSeq, bandCount, wlTables)
    );
  }

  const { row: bestRow, plan: selectedPlan } = findCheapestPositiveIdwlRowPlan(rowPlans);
  scratch.slot3Config[AT5_IDWL_CONFIG_WL] = selectedPlan?.wl ?? 0;
  scratch.slot3Config[AT5_IDWL_CONFIG_GROUP] = selectedPlan?.group ?? 0;
  scratch.slot3Config[AT5_IDWL_CONFIG_BAND_COUNT] = selectedPlan?.bandCount ?? 0;
  scratch.slot3Config[AT5_IDWL_CONFIG_EXTRA_WORD] = scratch.extraWordByIndex[bestRow] | 0;
  scratch.slot3Config[AT5_IDWL_CONFIG_ROW] = bestRow | 0;

  return ((selectedPlan?.adjustedCost ?? 0) + 4) | 0;
}

function bestWlForSymbols(symbols, count, wlTables) {
  const tables = wlTables ?? [idwlWlcCodes(0), idwlWlcCodes(1), idwlWlcCodes(2), idwlWlcCodes(3)];
  if (tables.some((table) => !table)) {
    throw new CodecError("missing IDWL huffman codes");
  }

  let bitsWl0 = 0;
  let bitsWl1 = 0;
  let bitsWl2 = 0;
  let bitsWl3 = 0;
  for (let index = 0; index < (count | 0); index += 1) {
    const codeOffset = ((symbols[index] & 0x7) * 4 + 2) | 0;
    bitsWl0 = (bitsWl0 + (tables[0][codeOffset] | 0)) | 0;
    bitsWl1 = (bitsWl1 + (tables[1][codeOffset] | 0)) | 0;
    bitsWl2 = (bitsWl2 + (tables[2][codeOffset] | 0)) | 0;
    bitsWl3 = (bitsWl3 + (tables[3][codeOffset] | 0)) | 0;
  }

  let bestWl = 0;
  let bestBits = bitsWl0 | 0;
  if ((bitsWl1 | 0) < (bestBits | 0)) {
    bestBits = bitsWl1 | 0;
    bestWl = 1;
  }
  if ((bitsWl2 | 0) < (bestBits | 0)) {
    bestBits = bitsWl2 | 0;
    bestWl = 2;
  }
  if ((bitsWl3 | 0) < (bestBits | 0)) {
    bestBits = bitsWl3 | 0;
    bestWl = 3;
  }
  return { wl: bestWl | 0, bits: bestBits | 0 };
}

function ensureIdwlDeltaSymbolsScratch(scratch) {
  let symbols = scratch?.deltaSymbols ?? null;
  if (!(symbols instanceof Uint32Array) || symbols.length < AT5_IDWL_WORK_GROUP_VALUES) {
    symbols = new Uint32Array(AT5_IDWL_WORK_GROUP_VALUES);
    scratch.deltaSymbols = symbols;
  }
  return symbols;
}

function idwlMode4DeltaSymbols(currentValues, previousValues, bandCount, out) {
  const delta = out;
  for (let index = 0; index < (bandCount | 0); index += 1) {
    delta[index] = ((currentValues[index] | 0) - (previousValues[index] | 0)) & 0x7;
  }
  return delta;
}

function idwlMode5DeltaSymbols(currentValues, previousValues, bandCount, out) {
  const delta = out;
  const count = bandCount | 0;
  if (count <= 0) {
    return delta;
  }

  delta[0] = ((currentValues[0] | 0) - (previousValues[0] | 0)) & 0x7;
  for (let index = 1; index < count; index += 1) {
    const currentDelta = ((currentValues[index] | 0) - (previousValues[index] | 0)) & 0x7;
    const previousDelta = ((currentValues[index - 1] | 0) - (previousValues[index - 1] | 0)) & 0x7;
    delta[index] = (currentDelta - previousDelta) & 0x7;
  }
  return delta;
}

function calcStereoDeltaIdwlBits(channel, scratch, buildDeltaSymbols, output) {
  const bandLimit = idwlBandLimit(channel?.shared) | 0;
  const channelIndex = (channel?.channelIndex ?? 0) | 0;
  const currentValues = channel?.idwl?.values;
  const previousValues = (channel?.block0 ?? channel)?.idwl?.values;
  if (!currentValues || !previousValues) {
    throw new TypeError("calcStereoDeltaIdwlBits: missing idwl.values");
  }

  const wlTables = [idwlWlcCodes(0), idwlWlcCodes(1), idwlWlcCodes(2), idwlWlcCodes(3)];
  if (wlTables.some((table) => !table)) {
    throw new CodecError("missing IDWL huffman codes");
  }
  const deltaSymbols = ensureIdwlDeltaSymbolsScratch(scratch);

  const groupPlans = buildIdwlGroupPlans(scratch, bandLimit, channelIndex, (_group, bandCount) => {
    if ((bandCount | 0) <= 0) {
      return { rawCost: 0, wl: 0 };
    }

    const best = bestWlForSymbols(
      buildDeltaSymbols(currentValues, previousValues, bandCount, deltaSymbols),
      bandCount,
      wlTables
    );
    return { rawCost: (best.bits + 2) | 0, wl: best.wl | 0 };
  });
  const bestPlan = findCheapestIdwlGroupPlan(groupPlans);

  output[AT5_IDWL_CONFIG_WL] = bestPlan.wl | 0;
  output[AT5_IDWL_CONFIG_GROUP] = bestPlan.group | 0;
  output[AT5_IDWL_CONFIG_BAND_COUNT] = bestPlan.bandCount | 0;
  output[AT5_IDWL_CONFIG_EXTRA_WORD] = scratch.extraWordByIndex[0] | 0;
  output[AT5_IDWL_CONFIG_ROW] = 0;

  return ((bestPlan.adjustedCost | 0) + 2) | 0;
}

export function calcNbitsForIdwl4At5(channel, scratch) {
  return calcStereoDeltaIdwlBits(channel, scratch, idwlMode4DeltaSymbols, scratch.slot1Config);
}

export function calcNbitsForIdwl5At5(channel, scratch) {
  return calcStereoDeltaIdwlBits(channel, scratch, idwlMode5DeltaSymbols, scratch.slot2Config);
}

function huffIdwlTable(wl) {
  return AT5_HC_WL[wl] ?? AT5_HC_WL[0];
}

function idwlWlcCoeffOffset(channelIndex, wlc) {
  const widthContext = wlc >>> 0;
  if (widthContext === 0) {
    return -1;
  }
  return ((widthContext + (channelIndex >>> 0) * 3 - 1) * 32) | 0;
}

function idwlEncodeValue(channel, index) {
  const offset = idwlWlcCoeffOffset(channel.channelIndex >>> 0, channel.idwl.wlc >>> 0);
  const value = channel.idwl.values[index] | 0;
  return offset < 0 ? value >>> 0 : (value - (AT5_WLC_COEF[offset + index] | 0)) >>> 0;
}

function idwlShapeValueMod8(index, count, base, shift) {
  const bandCount = count | 0;
  if (bandCount <= 0) {
    return 0;
  }

  const shapeCount = (AT5_SG_SHAPE_INDEX[bandCount - 1] | 0) + 1;
  const shapeSlot = AT5_SG_SHAPE_INDEX[index] | 0;
  if (shapeSlot <= 0 || shapeSlot >= shapeCount) {
    return (base & 0x7) >>> 0;
  }

  const tableOffset = ((base | 0) * 144 + (shift | 0) * 9 + shapeSlot - 1) | 0;
  return ((base | 0) - (AT5_WLC_SG_CB[tableOffset] | 0)) & 0x7;
}

function packIdwlHeader(channel, extraBase, dst, bitState, includeWlc = false) {
  const { idwl } = channel;
  if (includeWlc && !at5PackStoreFromMsb(idwl.wlc & 0x3, 2, dst, bitState)) {
    return false;
  }

  const mode = idwl.mode >>> 0;
  if (!at5PackStoreFromMsb(mode, 2, dst, bitState)) {
    return false;
  }

  if (mode !== 0) {
    if (!at5PackStoreFromMsb(idwl.count & 0x1f, 5, dst, bitState)) {
      return false;
    }
    if (mode === 3 && !at5PackStoreFromMsb((idwl.extra - extraBase) & 0x3, 2, dst, bitState)) {
      return false;
    }
  }

  return true;
}

function packIdwlWl(wl, bitCount, dst, bitState) {
  return at5PackStoreFromMsb(wl & ((1 << bitCount) - 1), bitCount, dst, bitState);
}

function packIdwlSymbols(table, symbols, start, end, dst, bitState) {
  for (let index = start; index < end; index += 1) {
    if (!at5PackSym(table, symbols[index] & 0x7, dst, bitState)) {
      return false;
    }
  }
  return true;
}

function packIdwlStereoValues(channel, count, wlBits, dst, bitState, encodeSymbol) {
  const wl = channel.idwl.wl >>> 0;
  if (!packIdwlWl(wl, wlBits, dst, bitState)) {
    return false;
  }

  const table = huffIdwlTable(wl);
  const values = channel.idwl.values;
  const baseValues = (channel.block0 ?? channel).idwl.values;
  for (let index = 0; index < count; index += 1) {
    if (!at5PackSym(table, encodeSymbol(values, baseValues, index) & 0x7, dst, bitState)) {
      return false;
    }
  }
  return true;
}

function ensureIdwlEncodeSymbols(channel) {
  let { encodeSymbols } = channel.idwl;
  if (!(encodeSymbols instanceof Uint32Array) || encodeSymbols.length < 32) {
    encodeSymbols = new Uint32Array(32);
    channel.idwl.encodeSymbols = encodeSymbols;
  }
  return encodeSymbols;
}

function buildIdwlShapeSymbols(channel, count) {
  const symbols = ensureIdwlEncodeSymbols(channel);
  const { values, shapeBase, shapeShift } = channel.idwl;

  for (let index = 0; index < count; index += 1) {
    const baseValue = idwlShapeValueMod8(index, count, shapeBase | 0, shapeShift | 0);
    symbols[index] = (values[index] - baseValue) & 0x7;
  }

  return symbols;
}

function packIdwlChainedValues(channel, count, wlBits, dst, bitState, readValue) {
  if (count <= 0) {
    return true;
  }

  const wl = channel.idwl.wl >>> 0;
  if (!packIdwlWl(wl, wlBits, dst, bitState)) {
    return false;
  }

  const table = huffIdwlTable(wl);
  let previous = readValue(0) & 0x7;
  if (!at5PackStoreFromMsb(previous, 3, dst, bitState)) {
    return false;
  }

  for (let index = 1; index < count; index += 1) {
    const current = readValue(index) & 0x7;
    if (!at5PackSym(table, (current - previous) & 0x7, dst, bitState)) {
      return false;
    }
    previous = current;
  }

  return true;
}

function packIdwlPairedShapeSymbols(channel, count, table, symbols, dst, bitState) {
  const shared = channel.idwlState?.shared ?? channel.block0?.idwlState?.shared ?? null;
  const pairCount = Math.max(0, Math.min(shared?.pairCount ?? 0, count >>> 1));
  const pairFlags = shared?.pairFlags instanceof Uint32Array ? shared.pairFlags : null;

  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const index = pairIndex * 2;
    const flag =
      pairFlags?.[pairIndex] ?? (symbols[index] === 0 && symbols[index + 1] === 0 ? 1 : 0);

    if (!at5PackStoreFromMsb(flag & 1, 1, dst, bitState)) {
      return false;
    }
    if ((flag & 1) !== 0) {
      continue;
    }
    if (!packIdwlSymbols(table, symbols, index, index + 2, dst, bitState)) {
      return false;
    }
  }

  return packIdwlSymbols(table, symbols, pairCount * 2, count, dst, bitState);
}

function packPrimaryMode1Idwl(channel, count, dst, bitState) {
  const { idwl } = channel;
  const lead = idwl.lead >>> 0;
  const width = idwl.width >>> 0;
  const base = idwl.base >>> 0;
  if (
    !at5PackStoreFromMsb(lead & 0x1f, 5, dst, bitState) ||
    !at5PackStoreFromMsb(width & 0x3, 2, dst, bitState) ||
    !at5PackStoreFromMsb(base & 0x7, 3, dst, bitState)
  ) {
    return false;
  }

  for (let index = 0; index < lead; index += 1) {
    if (!at5PackStoreFromMsb(idwlEncodeValue(channel, index) & 0x7, 3, dst, bitState)) {
      return false;
    }
  }
  for (let index = lead; index < count && width !== 0; index += 1) {
    if (
      !at5PackStoreFromMsb((idwlEncodeValue(channel, index) - base) >>> 0, width, dst, bitState)
    ) {
      return false;
    }
  }

  return true;
}

function packPrimaryMode2Idwl(channel, count, dst, bitState) {
  const { idwl } = channel;
  const wl = idwl.wl >>> 0;
  if (
    !at5PackStoreFromMsb(idwl.pairFlag & 1, 1, dst, bitState) ||
    !packIdwlWl(wl, 1, dst, bitState) ||
    !at5PackStoreFromMsb(idwl.shapeBase & 0x7, 3, dst, bitState) ||
    !at5PackStoreFromMsb(idwl.shapeShift & 0xf, 4, dst, bitState)
  ) {
    return false;
  }

  const table = huffIdwlTable(wl);
  const symbols = buildIdwlShapeSymbols(channel, count);
  return (idwl.pairFlag & 1) !== 0
    ? packIdwlPairedShapeSymbols(channel, count, table, symbols, dst, bitState)
    : packIdwlSymbols(table, symbols, 0, count, dst, bitState);
}

function packSecondaryMode1Idwl(channel, count, dst, bitState) {
  return packIdwlStereoValues(
    channel,
    count,
    2,
    dst,
    bitState,
    (values, baseValues, index) => (values[index] - baseValues[index]) & 0x7
  );
}

function packSecondaryMode2Idwl(channel, count, dst, bitState) {
  return packIdwlStereoValues(channel, count, 2, dst, bitState, (values, baseValues, index) => {
    const diff = (values[index] - baseValues[index]) & 0x7;
    if (index === 0) {
      return diff;
    }
    const prevDiff = (values[index - 1] - baseValues[index - 1]) & 0x7;
    return (diff - prevDiff) & 0x7;
  });
}

function packSecondaryTailBits(channel, count, bandLimit, dst, bitState, readValue) {
  if ((channel.idwl.mode | 0) !== 2 || count >= (bandLimit | 0)) {
    return true;
  }

  for (let index = count; index < (bandLimit | 0); index += 1) {
    if (!at5PackStoreFromMsb(readValue(index) & 1, 1, dst, bitState)) {
      return false;
    }
  }

  return true;
}

export function packIdwlChannel(channel, bandLimit, dst, bitState) {
  const mode = channel.idwlPackMode >>> 0;
  const channelIndex = channel.channelIndex >>> 0;
  const count = channel.idwl.count >>> 0;

  if (mode === 0) {
    for (let index = 0; index < bandLimit; index += 1) {
      if (!at5PackStoreFromMsb(channel.idwl.values[index] & 0x7, 3, dst, bitState)) {
        return false;
      }
    }
    return true;
  }

  if (mode === 1 || mode === 2) {
    if (channelIndex === 0) {
      if (!packIdwlHeader(channel, 1, dst, bitState, mode === 1)) {
        return false;
      }
      if (count === 0) {
        return true;
      }
      return mode === 1
        ? packPrimaryMode1Idwl(channel, count, dst, bitState)
        : packPrimaryMode2Idwl(channel, count, dst, bitState);
    }

    if (!packIdwlHeader(channel, 3, dst, bitState)) {
      return false;
    }
    if (
      count > 0 &&
      !(mode === 1
        ? packSecondaryMode1Idwl(channel, count, dst, bitState)
        : packSecondaryMode2Idwl(channel, count, dst, bitState))
    ) {
      return false;
    }
    return packSecondaryTailBits(
      channel,
      count,
      bandLimit,
      dst,
      bitState,
      (index) => channel.idwl.values[index]
    );
  }

  if (!packIdwlHeader(channel, channelIndex === 0 ? 1 : 3, dst, bitState, true)) {
    return false;
  }
  if (
    !packIdwlChainedValues(channel, count, 2, dst, bitState, (index) =>
      idwlEncodeValue(channel, index)
    )
  ) {
    return false;
  }
  return channelIndex === 0
    ? true
    : packSecondaryTailBits(channel, count, bandLimit, dst, bitState, (index) =>
        idwlEncodeValue(channel, index)
      );
}

export function resolveInitialIdwlCostPlan(encodeMode, channelIndex) {
  const isPrimaryChannel = ((channelIndex | 0) === 0) | 0;
  const usesPrimaryAbsoluteModes = isPrimaryChannel && (encodeMode | 0) !== 2;

  return {
    slot1: usesPrimaryAbsoluteModes ? "mode1" : isPrimaryChannel ? null : "mode4",
    slot2: "mode2",
    slot3: "mode3",
  };
}

export function resolveIncrementalIdwlCostPlan(encodeMode, channelIndex, targetChannel) {
  const currentChannel = channelIndex | 0;
  const target = targetChannel | 0;
  const isPrimaryChannel = currentChannel === 0;
  const isStereoDeltaChannel = currentChannel === 1;
  const usesPrimaryAbsoluteModes = isPrimaryChannel && target === 0 && (encodeMode | 0) !== 2;

  return {
    slot1: usesPrimaryAbsoluteModes ? "mode1" : isStereoDeltaChannel ? "mode4" : null,
    slot2: usesPrimaryAbsoluteModes ? "mode2" : isStereoDeltaChannel ? "mode5" : null,
    slot3: currentChannel === target ? "mode3" : null,
  };
}

export function selectLowestIdwlCostSlot(costs) {
  let bestConfigSlot = 0;
  let bestValue = costs[0] | 0;

  for (let slot = 1; slot < 4; slot += 1) {
    const value = costs[slot] | 0;
    if (value < bestValue) {
      bestValue = value | 0;
      bestConfigSlot = slot | 0;
    }
  }

  return { bestConfigSlot: bestConfigSlot | 0, bestValue: bestValue | 0 };
}

function selectBestMode2GroupPlan(scratch, bandLimit, channelIndex) {
  let bestSelScratch = scratch?.mode2BestSelScratch ?? null;
  if (!(bestSelScratch instanceof Int32Array) || bestSelScratch.length < 1) {
    bestSelScratch = new Int32Array(1);
    scratch.mode2BestSelScratch = bestSelScratch;
  }

  const groupPlans = buildIdwlGroupPlans(scratch, bandLimit, channelIndex, (group) => {
    return {
      rawCost: calcNbitsForIdwl2SubAt5(scratch, bestSelScratch, group) | 0,
      selector: bestSelScratch[0] | 0,
    };
  });

  return findCheapestPositiveIdwlGroupPlan(groupPlans);
}

function storeMode2GroupPlan(scratch, plan, extraWord) {
  if (!plan) {
    scratch.costs[2] = 0x4000;
    return;
  }

  const selector = plan.selector | 0;
  scratch.slot2Config[AT5_IDWL_CONFIG_ROW] = 0;
  if (selector > 1) {
    scratch.slot2Config[AT5_IDWL_CONFIG_WL] = (selector - 2) | 0;
    idwlWorkSetMode2PairFlag(idwlWorkU8(scratch), 1);
  } else {
    scratch.slot2Config[AT5_IDWL_CONFIG_WL] = selector | 0;
    idwlWorkSetMode2PairFlag(idwlWorkU8(scratch), 0);
  }
  scratch.slot2Config[AT5_IDWL_CONFIG_GROUP] = plan.group | 0;
  scratch.slot2Config[AT5_IDWL_CONFIG_BAND_COUNT] = plan.bandCount | 0;
  scratch.slot2Config[AT5_IDWL_CONFIG_EXTRA_WORD] = extraWord | 0;
  scratch.costs[2] = ((plan.adjustedCost | 0) + 2) | 0;
}

function recomputeIdwlCandidateCosts(
  channel,
  scratch,
  plan,
  bandLimit,
  channelIndex,
  mode2RowMeta
) {
  switch (plan.slot1) {
    case "mode1":
      scratch.costs[1] = calcNbitsForIdwl1At5(channel, scratch) | 0;
      break;
    case "mode4":
      scratch.costs[1] = calcNbitsForIdwl4At5(channel, scratch) | 0;
      break;
  }

  switch (plan.slot2) {
    case "mode2": {
      const bestMode2Plan = selectBestMode2GroupPlan(scratch, bandLimit, channelIndex);
      storeMode2GroupPlan(scratch, bestMode2Plan, mode2RowMeta(bestMode2Plan));
      break;
    }
    case "mode5":
      scratch.costs[2] = calcNbitsForIdwl5At5(channel, scratch) | 0;
      break;
  }

  if (plan.slot3 === "mode3") {
    scratch.costs[3] = calcNbitsForIdwl3At5(channel, scratch) | 0;
  }
}

export function calcNbitsForIdwlChInitAt5(channel, scratch) {
  const shared = channel?.shared;
  let bandLimit = idwlBandLimit(shared) | 0;
  const channelIndex = (channel?.channelIndex ?? 0) | 0;

  const coeff = channel?.idwl?.values;
  if (!(coeff instanceof Uint32Array) && !(coeff instanceof Int32Array)) {
    throw new TypeError("calcNbitsForIdwlChInitAt5: missing channel.idwl.values");
  }

  scratch.rowEnabled[0] = 1;
  for (let i = 0; i < bandLimit; i += 1) {
    scratch.rowSeq[0][i] = coeff[i] | 0;
  }

  for (let row = 1; row <= 3; row += 1) {
    scratch.rowEnabled[row] = 1;
    const rowCoef = idwlWlcCoefRow(channelIndex >>> 0, row);
    for (let i = 0; i < bandLimit; i += 1) {
      const delta = ((coeff[i] | 0) - (rowCoef ? rowCoef[i] | 0 : 0)) | 0;
      scratch.rowSeq[row][i] = delta | 0;
      if (delta < 0) {
        scratch.rowEnabled[row] = 0;
      }
    }
  }

  for (let row = 0; row <= 3; row += 1) {
    const rowCoeffs = scratch.rowSeq[row];

    if ((scratch.rowEnabled[row] | 0) === 0) {
      resetIdwlRowBandCounts(scratch, row, bandLimit);
      continue;
    }

    computeRowMetaAndBandCountsForRow(channelIndex, bandLimit, rowCoeffs, scratch, row);
  }

  const encodeMode = idwlEncodeMode(channel) | 0;
  if (encodeMode !== 2 && channelIndex === 0) {
    calcIdwlSgAt5(channel, scratch, 1, 0);
    bandLimit = idwlBandLimit(shared) | 0;
  }

  scratch.slot0Config[AT5_IDWL_CONFIG_WL] = 0;
  scratch.slot0Config[AT5_IDWL_CONFIG_GROUP] = 0;
  scratch.slot0Config[AT5_IDWL_CONFIG_BAND_COUNT] = bandLimit | 0;
  scratch.slot0Config[AT5_IDWL_CONFIG_EXTRA_WORD] = 0;
  scratch.slot0Config[AT5_IDWL_CONFIG_ROW] = 0;

  scratch.costs[0] = (bandLimit + bandLimit * 2) | 0;
  recomputeIdwlCandidateCosts(
    channel,
    scratch,
    resolveInitialIdwlCostPlan(encodeMode, channelIndex),
    bandLimit,
    channelIndex,
    (bestMode2Plan) => {
      // Initial mode-2 setup keeps the historical extra-word lookup keyed by the chosen group.
      return scratch.extraWordByIndex[bestMode2Plan?.group ?? 0] | 0;
    }
  );

  const { bestConfigSlot, bestValue } = selectLowestIdwlCostSlot(scratch.costs);
  scratch.bestConfigSlot = bestConfigSlot | 0;
  return bestValue | 0;
}

export function calcNbitsForIdwlChAt5(channel, scratch, targetMode, coeffIndex) {
  const shared = channel?.shared ?? null;
  const bandLimit = idwlBandLimit(shared) | 0;
  const channelIndex = (channel?.channelIndex ?? 0) | 0;
  const target = targetMode | 0;
  const idx = coeffIndex | 0;

  const coeff = channel?.idwl?.values ?? null;
  if (!(coeff instanceof Uint32Array) && !(coeff instanceof Int32Array)) {
    throw new TypeError("calcNbitsForIdwlChAt5: missing channel.idwl.values");
  }

  if (channelIndex === target) {
    scratch.rowSeq[0][idx] = coeff[idx] | 0;

    for (let row = 1; row <= 3; row += 1) {
      scratch.rowEnabled[row] = 1;
      const rowCoef = idwlWlcCoefRow(channelIndex >>> 0, row);
      scratch.rowSeq[row][idx] = ((coeff[idx] | 0) - (rowCoef ? rowCoef[idx] | 0 : 0)) | 0;

      for (let i = 0; i < bandLimit; i += 1) {
        if ((scratch.rowSeq[row][i] | 0) < 0) {
          scratch.rowEnabled[row] = 0;
          break;
        }
      }
    }

    for (let row = 0; row <= 3; row += 1) {
      const rowCoeffs = scratch.rowSeq[row];

      if ((scratch.rowEnabled[row] | 0) === 0) {
        resetIdwlRowBandCounts(scratch, row, bandLimit);
        continue;
      }

      refreshIdwlRowBandCountsForIndex(channelIndex, bandLimit, rowCoeffs, scratch, row, idx);
    }

    const encodeMode = idwlEncodeMode(channel) | 0;
    if (encodeMode !== 2 && channelIndex === 0) {
      calcIdwlSgAt5(channel, scratch, 0, idx);
    }
  }

  const encodeMode = idwlEncodeMode(channel) | 0;
  recomputeIdwlCandidateCosts(
    channel,
    scratch,
    resolveIncrementalIdwlCostPlan(encodeMode, channelIndex, target),
    bandLimit,
    channelIndex,
    () => {
      // Incremental updates keep emitting the row-0 extra word even when a later group wins.
      return scratch.extraWordByIndex[0] | 0;
    }
  );

  const { bestConfigSlot, bestValue } = selectLowestIdwlCostSlot(scratch.costs);
  scratch.bestConfigSlot = bestConfigSlot | 0;
  return bestValue | 0;
}

export function copyWlcinfoAt5(srcList, dstList, count, mode, index) {
  const n = count | 0;
  const idx = index | 0;
  for (let i = 0; i < n; i += 1) {
    const src = srcList[i];
    const dst = dstList[i];
    dst.bestConfigSlot = src.bestConfigSlot | 0;
  }

  const src = srcList[idx];
  const dst = dstList[idx];

  for (let row = 0; row < 4; row += 1) {
    dst.rowEnabled[row] = src.rowEnabled[row] | 0;
    dst.rowSeq[row].set(src.rowSeq[row]);
  }
  dst.bandCountBySlot.set(src.bandCountBySlot);
  dst.mappedGroupBySlot.set(src.mappedGroupBySlot);
  dst.extraWordByIndex.set(src.extraWordByIndex);

  if (idx !== 0) {
    const src1 = srcList[1];
    const dst1 = dstList[1];
    dst1.costs.set(src1.costs.subarray(1, 4), 1);
    for (let slot = 1; slot <= 3; slot += 1) {
      idwlScratchConfigForSlot(dst1, slot)?.set(idwlScratchConfigForSlot(src1, slot));
    }
    return;
  }

  if ((mode | 0) === 2) {
    dst.costs[3] = src.costs[3] | 0;
    idwlScratchConfigForSlot(dst, 3)?.set(idwlScratchConfigForSlot(src, 3));
  } else {
    const dstWork = idwlWorkU8(dst);
    const srcWork = idwlWorkU8(src);
    dstWork.set(srcWork.subarray(0, AT5_IDWL_WORK_SG_COPY_BYTES), 0);

    dst.costs.set(src.costs.subarray(1, 4), 1);
    for (let slot = 1; slot <= 3; slot += 1) {
      idwlScratchConfigForSlot(dst, slot)?.set(idwlScratchConfigForSlot(src, slot));
    }
  }

  if (n === 2) {
    const src1 = srcList[1];
    const dst1 = dstList[1];
    dst1.costs.set(src1.costs.subarray(1, 3), 1);
    idwlScratchConfigForSlot(dst1, 1)?.set(idwlScratchConfigForSlot(src1, 1));
    idwlScratchConfigForSlot(dst1, 2)?.set(idwlScratchConfigForSlot(src1, 2));
  }
}
