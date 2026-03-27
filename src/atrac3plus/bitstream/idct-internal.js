import { at5HcValueMask, at5PackStoreFromMsb, at5PackSym } from "./bitstream.js";
import { at5RebitallocPackState } from "../rebitalloc-layout.js";
import { CodecError } from "../../common/errors.js";
import {
  AT5_IDCT_MAX_VALUES,
  AT5_IDCT_MODE_COPY,
  AT5_IDCT_MODE_DIFF,
  AT5_IDCT_MODE_DIRECT,
  AT5_IDCT_MODE_FIXED,
  clampIdctCount,
  idctTables,
  setIdctTypes,
} from "./idct-common.js";

/**
 * Internal IDCT bitstream helpers.
 *
 * Public IDCT callers only need state builders, error codes, and unpacking.
 * Encode-side cost planning, codebook metadata, and type classification stay
 * here.
 */
export {
  AT5_IDCT_ERROR_CODES,
  AT5_IDCT_MAX_VALUES,
  AT5_IDCT_MODE_COPY,
  AT5_IDCT_MODE_DIFF,
  AT5_IDCT_MODE_DIRECT,
  AT5_IDCT_MODE_FIXED,
  clampIdctCount,
  createAt5IdctChannelState,
  createAt5IdctSharedState,
  idctTables,
  setIdctTypes,
} from "./idct-common.js";

export { unpackIdct } from "./idct.js";

const AT5_IDCT_INVALID_BITS = 0x4000;

function packIdctHeader(channel, maxCount, dst, bitState) {
  const flag = channel.idct.flag & 1;
  if (!at5PackStoreFromMsb(flag, 1, dst, bitState)) {
    return null;
  }

  if (flag === 0) {
    return maxCount | 0;
  }

  const count = Math.max(0, Math.min(channel.idct.count | 0, maxCount | 0));
  if (!at5PackStoreFromMsb(count & 0x1f, 5, dst, bitState)) {
    return null;
  }
  return count | 0;
}

function packIdctTypedValues(channel, count, dst, bitState, packType1) {
  const { types, values } = channel.idct;
  for (let index = 0; index < (count | 0); index += 1) {
    if (types[index] >>> 0 === 1) {
      if (!packType1(values[index] >>> 0, index)) {
        return false;
      }
    } else if (types[index] >>> 0 === 2) {
      if (!at5PackStoreFromMsb(values[index] & 1, 1, dst, bitState)) {
        return false;
      }
    }
  }
  return true;
}

export function packIdctChannel(channel, bandCount, dst, bitState) {
  const mode = channel.idctModeSelect >>> 0;
  if (mode === AT5_IDCT_MODE_COPY && channel.channelIndex >>> 0 === 0) {
    return true;
  }

  const count = packIdctHeader(channel, bandCount | 0, dst, bitState);
  if (count === null) {
    return false;
  }

  const tables = idctTables(channel.shared?.gainModeFlag);
  switch (mode) {
    case AT5_IDCT_MODE_FIXED:
      return packIdctTypedValues(channel, count, dst, bitState, (value) =>
        at5PackStoreFromMsb(value, tables.fixBits, dst, bitState)
      );
    case AT5_IDCT_MODE_DIRECT:
      return packIdctTypedValues(channel, count, dst, bitState, (value) =>
        at5PackSym(tables.directTable, value, dst, bitState)
      );
    case AT5_IDCT_MODE_DIFF: {
      const mask = at5HcValueMask(tables.diffTable);
      let previous = 0;
      return packIdctTypedValues(channel, count, dst, bitState, (value, index) => {
        if (index === 0) {
          previous = value;
          return at5PackSym(tables.directTable, value, dst, bitState);
        }
        if (!at5PackSym(tables.diffTable, (value - previous) & mask, dst, bitState)) {
          return false;
        }
        previous = value;
        return true;
      });
    }
    default: {
      const table = tables.pairTable;
      const mask = at5HcValueMask(table);
      const baseValues = (channel.block0 ?? channel).idct.values;
      return packIdctTypedValues(channel, count, dst, bitState, (value, index) =>
        at5PackSym(table, (value - (baseValues[index] >>> 0)) & mask, dst, bitState)
      );
    }
  }
}

function requireCtHuffCodes(table) {
  const codes = table?.codes;
  if (codes instanceof Uint8Array) {
    return codes;
  }
  throw new CodecError("calcNbitsForIdctAt5: missing CT Huffman codes");
}

function writeIdctPackState(block, types, maxCount, mode, count, flag) {
  const packState = at5RebitallocPackState(block?.rebitallocScratch ?? null);
  if (!packState) {
    return;
  }

  // Cache the chosen pack mode and the per-band type map so the later block
  // packer can emit the same IDCT coding decision without recomputing it.
  packState.mode = (mode >>> 0) & 3;
  packState.bandCount = count >>> 0;
  packState.flag = (flag >>> 0) & 1;

  const limit = clampIdctCount(maxCount);
  packState.types.fill(0);
  packState.types.set(types.subarray(0, limit), 0);
}

function applyIdctPackChoice(channel, block, types, maxCount, entry, count) {
  const mode = entry.mode >>> 0;
  channel.idctModeSelect = mode;
  channel.idct.modeSelect = mode;
  channel.idct.flag = entry.flag | 0;
  channel.idct.count = count >>> 0;
  writeIdctPackState(block, types, maxCount, mode, count, entry.flag | 0);
}

function idctCountUsed(values, maxCount) {
  const limit = clampIdctCount(maxCount);
  if (limit === 0) {
    return 0;
  }
  for (let index = limit - 1; index >= 0; index -= 1) {
    if ((values[index] | 0) > 0) {
      return (index + 1) | 0;
    }
  }
  return limit;
}

function finalizeIdctBitCost(sum, total) {
  const threshold = (sum + 5) | 0;
  return (total | 0) > threshold
    ? { bits: (threshold + 1) | 0, flag: 1 }
    : { bits: (total + 1) | 0, flag: 0 };
}

function measureIdctBits(types, count, maxCount, readType1Bits) {
  const limit = maxCount | 0;
  const activeCount = count | 0;
  let sum = 0;
  let total = 0;

  for (let index = 0; index < limit; index += 1) {
    const type = types[index] | 0;
    const bits = type === 1 ? readType1Bits(index) : type === 2 ? 1 : 0;
    if (index < activeCount) {
      sum += bits;
    }
    total += bits;
  }

  return finalizeIdctBitCost(sum, total);
}

function idctBitsFixed(types, count, maxCount, fixBits) {
  return measureIdctBits(types, count, maxCount, () => fixBits | 0);
}

function idctBitsHuffDirect(types, values, count, maxCount, table) {
  const codes = requireCtHuffCodes(table);
  return measureIdctBits(
    types,
    count,
    maxCount,
    (index) => codes[((values[index] >>> 0) & 0xff) * 4 + 2] | 0
  );
}

function idctBitsHuffDiff(types, values, count, maxCount, tableFirst, tableMain) {
  const firstCodes = requireCtHuffCodes(tableFirst);
  const mainCodes = requireCtHuffCodes(tableMain);
  const mask = at5HcValueMask(tableMain) >>> 0;
  let prev = 0;

  return measureIdctBits(types, count, maxCount, (index) => {
    const current = values[index] | 0;
    if (index === 0) {
      prev = current;
      return firstCodes[((current >>> 0) & 0xff) * 4 + 2] | 0;
    }

    const symbol = (current - prev) & mask;
    prev = current;
    return mainCodes[(symbol >>> 0) * 4 + 2] | 0;
  });
}

function idctBitsHuffPair(types, values, refValues, count, maxCount, table) {
  const codes = requireCtHuffCodes(table);
  const mask = at5HcValueMask(table) >>> 0;

  return measureIdctBits(types, count, maxCount, (index) => {
    const symbol = ((values[index] | 0) - (refValues[index] | 0)) & mask;
    return codes[(symbol >>> 0) * 4 + 2] | 0;
  });
}

export function calcNbitsForIdctAt5(channelEntries, blocks, count, mode) {
  const channelCount = count | 0;
  if (channelCount <= 0) {
    return 0;
  }

  const shared = channelEntries?.[0]?.shared;
  const maxCount = clampIdctCount(shared?.idsfCount ?? 0);
  if (maxCount === 0) {
    return 0;
  }

  const tables = idctTables(shared?.gainModeFlag ?? 0);
  const types = new Int32Array(AT5_IDCT_MAX_VALUES);
  let totalBits = (channelCount * 3 + 1) | 0;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channelEntries[channelIndex];
    const block = blocks[channelIndex];
    if (!channel || !block) {
      continue;
    }

    setIdctTypes(channel, maxCount, types);

    const values = block?.rebitallocScratch?.specIndexByBand;
    if (!(values instanceof Int32Array || values instanceof Uint32Array)) {
      throw new CodecError("calcNbitsForIdctAt5: missing block.rebitallocScratch.specIndexByBand");
    }

    const selectionMode = mode | 0;
    const bandCount = selectionMode === 0 ? maxCount | 0 : idctCountUsed(values, maxCount);
    let choice = {
      mode: AT5_IDCT_MODE_FIXED,
      ...idctBitsFixed(types, bandCount, maxCount, tables.fixBits),
    };

    if (selectionMode !== 0) {
      const direct = {
        mode: AT5_IDCT_MODE_DIRECT,
        ...idctBitsHuffDirect(types, values, bandCount, maxCount, tables.directTable),
      };
      if ((direct.bits | 0) < (choice.bits | 0)) {
        choice = direct;
      }

      const diff = {
        mode: AT5_IDCT_MODE_DIFF,
        ...idctBitsHuffDiff(
          types,
          values,
          bandCount,
          maxCount,
          tables.firstDiffTable,
          tables.diffTable
        ),
      };
      if ((diff.bits | 0) < (choice.bits | 0)) {
        choice = diff;
      }

      // Mode 3 is asymmetric: channel 0 can only reuse an all-zero primary
      // payload, while channel 1 encodes deltas against the left channel.
      let copy = { mode: AT5_IDCT_MODE_COPY, bits: 0, flag: 0 };
      if ((channel.channelIndex | 0) === 0) {
        for (let index = 0; index < maxCount; index += 1) {
          if ((types[index] | 0) === 1 && (values[index] | 0) > 0) {
            copy.bits = AT5_IDCT_INVALID_BITS;
            break;
          }
        }
      } else {
        const baseValues = blocks?.[0]?.rebitallocScratch?.specIndexByBand;
        copy = {
          mode: AT5_IDCT_MODE_COPY,
          ...idctBitsHuffPair(
            types,
            values,
            baseValues instanceof Int32Array || baseValues instanceof Uint32Array
              ? baseValues
              : values,
            bandCount,
            maxCount,
            tables.pairTable
          ),
        };
      }
      if ((copy.bits | 0) < (choice.bits | 0)) {
        choice = copy;
      }
    }

    totalBits = (totalBits + (choice.bits | 0)) | 0;
    applyIdctPackChoice(channel, block, types, maxCount, choice, bandCount);
  }

  return totalBits | 0;
}
