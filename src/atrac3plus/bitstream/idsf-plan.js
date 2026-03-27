/**
 * IDSF encode-side bit planning helpers.
 *
 * Split out from `idsf-internal.js` so packing helpers can stay lean.
 */
import { at5HcValueMask } from "./bitstream.js";
import { AT5_HC_SF, AT5_HC_SF_SG, AT5_SFC_SG_CB } from "../tables/unpack.js";
import { CodecError } from "../../common/errors.js";
import {
  AT5_IDSF_MAX_VALUES,
  asInt8,
  idsfApplyMode2Delta,
  idsfShapeCount,
  wrapSigned6,
} from "./idsf-common.js";

const AT5_IDSF_MODE_COUNT = 4;
const AT5_IDSF_RANGE_LIMIT = [0, 1, 3, 7, 15, 31];
const AT5_IDSF_AVG_BIAS = 0.5;
const AT5_IDSF_AVG_MUL5 = 0.19999995827674866; // 0x1.99999a0000000p-3f
const AT5_IDSF_INVALID_COST = 0x4000;

let cachedIdsfHuffCodes = null;

function hcCodes(desc) {
  return desc?.codes instanceof Uint8Array ? desc.codes : null;
}

function addHuffBits(codes4, sym, sums) {
  const index = ((sym >>> 0) * 4 + 2) >>> 0;
  sums[0] += codes4[0][index] | 0;
  sums[1] += codes4[1][index] | 0;
  sums[2] += codes4[2][index] | 0;
  sums[3] += codes4[3][index] | 0;
}

function selectBest4(sums) {
  let bestMode = 0;
  let bestSum = sums[0] | 0;
  for (let mode = 1; mode < AT5_IDSF_MODE_COUNT; mode += 1) {
    const sum = sums[mode] | 0;
    if (sum < bestSum) {
      bestMode = mode;
      bestSum = sum;
    }
  }
  return { mode: bestMode | 0, sum: bestSum | 0 };
}

function createHuffSums(seed = 0) {
  return [seed, seed, seed, seed];
}

function requireIdsfHuffCodes() {
  if (cachedIdsfHuffCodes) {
    return cachedIdsfHuffCodes;
  }

  const sf = AT5_HC_SF.slice(0, AT5_IDSF_MODE_COUNT).map(hcCodes);
  const sg = AT5_HC_SF_SG.slice(0, AT5_IDSF_MODE_COUNT).map(hcCodes);
  if (sf.some((codes) => !codes) || sg.some((codes) => !codes)) {
    throw new CodecError("calcNbitsForIdsfChAt5: missing Huffman code tables");
  }

  cachedIdsfHuffCodes = { sf, sg };
  return cachedIdsfHuffCodes;
}

function idsfCalcWidthLeadBase(values, count) {
  const widthActive = new Int32Array(6);
  const lead = new Int32Array(7);
  const base = new Int32Array(7);

  for (let width = 0; width < 6; width += 1) {
    widthActive[width] = 1;
    lead[width] = count | 0;
  }
  lead[6] = count | 0;

  let maxValue = 0;
  let minValue = 0x3f;
  for (let index = (count | 0) - 1; index >= 0; index -= 1) {
    const value = values[index] | 0;
    maxValue = Math.max(maxValue, value);
    minValue = Math.min(minValue, value);

    const range = (maxValue - minValue) | 0;
    for (let width = 0; width < 6; width += 1) {
      if (widthActive[width] === 0) {
        continue;
      }
      if (range > (AT5_IDSF_RANGE_LIMIT[width] | 0)) {
        widthActive[width] = 0;
        lead[width] = (index + 1) | 0;
        continue;
      }

      lead[width] = index | 0;
      base[width] = minValue | 0;
    }
  }

  let bestWidth = 6;
  let bestCost = (count | 0) * 6;
  for (let width = 0; width < 6; width += 1) {
    const leadCount = lead[width] | 0;
    const cost = (((count | 0) - leadCount) * width + leadCount * 6) | 0;
    if (cost < bestCost) {
      bestWidth = width;
      bestCost = cost;
    }
  }

  return {
    bits: (bestCost + 0x10) | 0,
    params: {
      lead: lead[bestWidth] | 0,
      width: bestWidth | 0,
      base: base[bestWidth] | 0,
    },
  };
}

function idsfMode3Cost(values, count) {
  let bestCost = AT5_IDSF_INVALID_COST;
  let bestLead = 0;
  let bestWidth = 0;
  let bestBase = 0;

  for (let lead = 0; lead < (count | 0); lead += 1) {
    let leadCost = 0;
    let valid = true;
    for (let index = 0; index < lead; index += 1) {
      if ((values[index] + 7) >>> 0 > 0x0f) {
        valid = false;
        break;
      }
      leadCost += 4;
    }
    if (!valid) {
      continue;
    }

    let minValue = values[lead] | 0;
    let maxValue = values[lead] | 0;
    for (let index = lead + 1; index < (count | 0); index += 1) {
      const value = values[index] | 0;
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);
    }
    if ((minValue + 7) >>> 0 > 0x0f) {
      continue;
    }

    const range = (maxValue - minValue) | 0;
    const width = range === 0 ? 0 : range <= 1 ? 1 : range <= 3 ? 2 : range <= 7 ? 3 : -1;
    if (width < 0) {
      continue;
    }

    const cost = (leadCost + ((count | 0) - lead) * width) | 0;
    if (cost < bestCost) {
      bestCost = cost;
      bestLead = lead | 0;
      bestWidth = width | 0;
      bestBase = minValue | 0;
    }
  }

  if (bestCost === AT5_IDSF_INVALID_COST) {
    return null;
  }

  return {
    bits: (bestCost + 0x19) | 0,
    params: {
      lead: bestLead | 0,
      width: bestWidth | 0,
      base: bestBase | 0,
    },
  };
}

function idsfShapeError(avg, shapeCount, cbIndex) {
  const cbOffset = cbIndex * 9;
  let error = 0;
  for (let index = 1; index < shapeCount; index += 1) {
    const diff = (avg[index] | 0) - asInt8(AT5_SFC_SG_CB[cbOffset + index - 1] | 0);
    error += diff * diff;
  }
  return error;
}

function createPrimaryIdsfScratch(channel) {
  const mode2Values = channel.idsf.mode2Values ?? [
    new Uint32Array(AT5_IDSF_MAX_VALUES),
    new Uint32Array(AT5_IDSF_MAX_VALUES),
    new Uint32Array(AT5_IDSF_MAX_VALUES),
  ];
  const sgSymbols = channel.idsf.sgSymbols ?? new Int32Array(AT5_IDSF_MAX_VALUES);
  channel.idsf.mode2Values = mode2Values;
  channel.idsf.sgSymbols = sgSymbols;
  return { mode2Values, sgSymbols };
}

function fillMode2Blocks(mode2Values, idsf, count) {
  const valid = [true, true, true];
  for (let index = 0; index < count; index += 1) {
    mode2Values[0][index] = (idsf[index] | 0) & 0x3f;
  }

  for (let mode2 = 1; mode2 <= 2; mode2 += 1) {
    const block = mode2Values[mode2];
    const divisor = mode2 + 1;
    for (let index = 0; index < count; index += 1) {
      const value = ((idsf[index] | 0) + Math.trunc(index / divisor)) | 0;
      block[index] = value & 0x3f;
      if (value > 0x3f) {
        valid[mode2] = false;
      }
    }
  }

  return valid;
}

function fillIdsfGroupAverage(avg, idsf, groupCount) {
  for (let group = 0, index = 0; group < groupCount; group += 1, index += 3) {
    const sum = (idsf[index] | 0) + (idsf[index + 1] | 0) + (idsf[index + 2] | 0);
    avg[group] = Math.trunc(sum / 3 + AT5_IDSF_AVG_BIAS);
  }

  if (groupCount === 0x0a) {
    let sum = 0;
    for (let index = 0x1b; index <= 0x1f; index += 1) {
      sum += idsf[index] | 0;
    }
    avg[9] = Math.trunc(sum * AT5_IDSF_AVG_MUL5 + AT5_IDSF_AVG_BIAS);
  }
}

function selectIdsfShape(avg, shapeCount) {
  if (shapeCount <= 1) {
    return 0;
  }

  let bestCb = 0;
  let bestError = idsfShapeError(avg, shapeCount, 0);
  for (let cbIndex = 1; cbIndex < 0x40; cbIndex += 1) {
    const error = idsfShapeError(avg, shapeCount, cbIndex);
    if (error < bestError) {
      bestCb = cbIndex;
      bestError = error;
    }
  }
  return bestCb;
}

function fillIdsfSgSymbols(sgSymbols, idsf, groupCount, baseValue, cbIndex, count) {
  const groupBase = new Int32Array(16);
  groupBase[0] = baseValue | 0;
  const cbOffset = cbIndex * 9;
  for (let group = 1; group < groupCount; group += 1) {
    groupBase[group] = ((baseValue | 0) - asInt8(AT5_SFC_SG_CB[cbOffset + group - 1] | 0)) | 0;
  }

  for (let group = 0; group < groupCount; group += 1) {
    const base = groupBase[group] | 0;
    const index = group * 3;
    sgSymbols[index] = (idsf[index] | 0) - base;
    sgSymbols[index + 1] = (idsf[index + 1] | 0) - base;
    sgSymbols[index + 2] = (idsf[index + 2] | 0) - base;
  }
  if (groupCount === 0x0a) {
    const base = groupBase[9] | 0;
    for (let index = 0x1b; index <= 0x1f; index += 1) {
      sgSymbols[index] = (idsf[index] | 0) - base;
    }
  }

  for (let index = 0; index < count; index += 1) {
    sgSymbols[index] = wrapSigned6(sgSymbols[index] | 0);
  }
}

function preparePrimaryIdsfScratch(channel, count, groupCount) {
  const idsf = channel.idsf.values;
  const { mode2Values, sgSymbols } = createPrimaryIdsfScratch(channel);
  const validMode2 = fillMode2Blocks(mode2Values, idsf, count);

  const avg = new Int32Array(16);
  fillIdsfGroupAverage(avg, idsf, groupCount);

  const baseValue = avg[0] | 0;
  channel.idsf.baseValue = baseValue & 0x3f;
  for (let group = 1; group < groupCount; group += 1) {
    avg[group] = (baseValue - avg[group]) | 0;
  }
  for (let group = groupCount; group <= 9; group += 1) {
    avg[group] = 0;
  }

  channel.idsf.cbIndex = selectIdsfShape(avg, idsfShapeCount(count)) & 0x3f;
  fillIdsfSgSymbols(sgSymbols, idsf, groupCount, baseValue, channel.idsf.cbIndex, count);

  return { mode2Values, sgSymbols, validMode2 };
}

function syncMode2Scratch(channel, count) {
  const blocks = channel.idsf.mode2Values;
  if (!blocks) {
    return;
  }

  const values = channel.idsf.values;
  for (let mode2 = 0; mode2 < 3; mode2 += 1) {
    const block = blocks[mode2];
    if (!block) {
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      block[index] = values[index] & 0x3f;
    }
    idsfApplyMode2Delta(mode2, block, count, true);
  }
}

function selectSecondaryIdsfCoding(channel, count, sf) {
  const idsf = channel.idsf.values;
  const baseValues = channel.block0?.idsf?.values ?? idsf;
  let bestMode = 0;
  let bestEntry = { cost: count * 6, mode: 0, mode2: 0 };

  const absoluteSums = createHuffSums();
  for (let index = 0; index < count; index += 1) {
    addHuffBits(sf, ((idsf[index] | 0) - (baseValues[index] | 0)) & 0x3f, absoluteSums);
  }
  const bestAbsolute = selectBest4(absoluteSums);
  const absoluteEntry = { cost: (bestAbsolute.sum + 2) | 0, mode: bestAbsolute.mode | 0, mode2: 0 };
  if ((absoluteEntry.cost | 0) < (bestEntry.cost | 0)) {
    bestMode = 1;
    bestEntry = absoluteEntry;
  }

  const deltaSums = createHuffSums();
  if (count > 0) {
    let previous = ((idsf[0] | 0) - (baseValues[0] | 0)) | 0;
    addHuffBits(sf, previous & 0x3f, deltaSums);
    for (let index = 1; index < count; index += 1) {
      const current = ((idsf[index] | 0) - (baseValues[index] | 0)) | 0;
      addHuffBits(sf, (current - previous) & 0x3f, deltaSums);
      previous = current;
    }
  }
  const bestDelta = selectBest4(deltaSums);
  const deltaEntry = { cost: (bestDelta.sum + 2) | 0, mode: bestDelta.mode | 0, mode2: 0 };
  if ((deltaEntry.cost | 0) < (bestEntry.cost | 0)) {
    bestMode = 2;
    bestEntry = deltaEntry;
  }

  let copyCost = 0;
  for (let index = 0; index < count; index += 1) {
    if ((idsf[index] | 0) !== (baseValues[index] | 0)) {
      copyCost = AT5_IDSF_INVALID_COST;
      break;
    }
  }
  if ((copyCost | 0) < (bestEntry.cost | 0)) {
    bestMode = 3;
    bestEntry = { cost: copyCost | 0, mode: 0, mode2: 0 };
  }

  return { bestMode, bestEntry };
}

function selectPrimaryIdsfCoding(channel, count, groupCount, sf, sg) {
  const primaryScratch = preparePrimaryIdsfScratch(channel, count, groupCount);
  let bestMode1 = null;
  let bestMode3 = null;

  for (let mode2 = 0; mode2 < 3; mode2 += 1) {
    if (!primaryScratch.validMode2[mode2]) {
      continue;
    }

    const values = primaryScratch.mode2Values[mode2];
    const widthLeadBase = idsfCalcWidthLeadBase(values, count);
    if (!bestMode1 || (widthLeadBase.bits | 0) < (bestMode1.cost | 0)) {
      bestMode1 = { cost: widthLeadBase.bits | 0, mode2: mode2 | 0, params: widthLeadBase.params };
    }

    const sequentialSums = createHuffSums(6);
    for (let index = 1; index < count; index += 1) {
      addHuffBits(sf, ((values[index] | 0) - (values[index - 1] | 0)) & 0x3f, sequentialSums);
    }
    const bestSequential = selectBest4(sequentialSums);
    const sequentialCost = (bestSequential.sum + 4) | 0;
    if (!bestMode3 || sequentialCost < (bestMode3.cost | 0)) {
      bestMode3 = { cost: sequentialCost, mode: bestSequential.mode | 0, mode2: mode2 | 0 };
    }
  }

  const mode1Shape = idsfMode3Cost(primaryScratch.sgSymbols, count);
  if (mode1Shape && (!bestMode1 || (mode1Shape.bits | 0) < (bestMode1.cost | 0))) {
    bestMode1 = { cost: mode1Shape.bits | 0, mode2: 3, params: mode1Shape.params };
  }
  Object.assign(channel.idsf, bestMode1?.params ?? {});

  let directShapeEntry = { cost: AT5_IDSF_INVALID_COST, mode: 0, mode2: 3 };
  const directShapeSums = createHuffSums();
  let validDirectShape = true;
  for (let index = 0; index < count; index += 1) {
    const value = primaryScratch.sgSymbols[index] | 0;
    if ((value + 7) >>> 0 > 0x0e) {
      validDirectShape = false;
      break;
    }
    addHuffBits(sg, value & 0xf, directShapeSums);
  }
  if (validDirectShape) {
    const bestDirectShape = selectBest4(directShapeSums);
    directShapeEntry = {
      cost: (bestDirectShape.sum + 0x0e) | 0,
      mode: bestDirectShape.mode | 0,
      mode2: 3,
    };
  }

  if (count > 0 && (primaryScratch.sgSymbols[0] + 8) >>> 0 <= 0x0f) {
    const sequentialShapeSums = createHuffSums(4);
    let validSequentialShape = true;
    for (let index = 1; index < count; index += 1) {
      const symbol =
        ((primaryScratch.sgSymbols[index] - primaryScratch.sgSymbols[index - 1]) & 0x3f) >>> 0;
      if ((symbol - 8) >>> 0 <= 0x30) {
        validSequentialShape = false;
        break;
      }
      addHuffBits(sg, symbol & 0xf, sequentialShapeSums);
    }
    if (validSequentialShape) {
      const bestSequentialShape = selectBest4(sequentialShapeSums);
      const sequentialShapeCost = (bestSequentialShape.sum + 0x10) | 0;
      if (!bestMode3 || sequentialShapeCost < (bestMode3.cost | 0)) {
        bestMode3 = {
          cost: sequentialShapeCost,
          mode: bestSequentialShape.mode | 0,
          mode2: 3,
        };
      }
    }
  }

  let bestMode = 0;
  let bestEntry = { cost: count * 6, mode: 0, mode2: 0 };

  const mode1Entry = {
    cost: bestMode1?.cost ?? AT5_IDSF_INVALID_COST,
    mode: 0,
    mode2: bestMode1?.mode2 ?? 0,
  };
  if ((mode1Entry.cost | 0) < (bestEntry.cost | 0)) {
    bestMode = 1;
    bestEntry = mode1Entry;
  }
  if ((directShapeEntry.cost | 0) < (bestEntry.cost | 0)) {
    bestMode = 2;
    bestEntry = directShapeEntry;
  }

  const mode3Entry = {
    cost: bestMode3?.cost ?? AT5_IDSF_INVALID_COST,
    mode: bestMode3?.mode ?? 0,
    mode2: bestMode3?.mode2 ?? 0,
  };
  if ((mode3Entry.cost | 0) < (bestEntry.cost | 0)) {
    bestMode = 3;
    bestEntry = mode3Entry;
  }

  return { bestMode, bestEntry };
}

/**
 * Estimate the encoded IDSF cost and cache the best coding parameters on the channel state.
 */
export function calcNbitsForIdsfChAt5(channel) {
  const shared = channel?.shared;
  if (!channel || !shared || !channel.idsf || !channel.idsf.values) {
    throw new TypeError("calcNbitsForIdsfChAt5: invalid channel");
  }

  const count = Math.max(0, Math.min(shared.idsfCount | 0, AT5_IDSF_MAX_VALUES));
  const groupCount = Math.max(0, Math.min(shared.bandCount | 0, 16));
  const { sf, sg } = requireIdsfHuffCodes();

  const { bestMode, bestEntry } =
    (channel.channelIndex | 0) === 0
      ? selectPrimaryIdsfCoding(channel, count, groupCount, sf, sg)
      : selectSecondaryIdsfCoding(channel, count, sf);

  channel.idsfModeSelect = bestMode >>> 0;
  channel.idsf.modeSelect = bestMode >>> 0;
  channel.idsf.mode = bestEntry.mode >>> 0;
  channel.idsf.mode2 = bestEntry.mode2 >>> 0;

  if ((channel.channelIndex | 0) === 0) {
    syncMode2Scratch(channel, count);
  }

  at5HcValueMask(AT5_HC_SF[0]);
  return bestEntry.cost | 0;
}
