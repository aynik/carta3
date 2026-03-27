import { at5PackStoreFromMsb, at5PackSym } from "./bitstream.js";
import { AT5_HC_SF, AT5_HC_SF_SG, AT5_IDSF_MODE2_DELTA } from "../tables/unpack.js";
import { AT5_IDSF_MAX_VALUES, idsfCount, idsfInitShape, wrapSigned6 } from "./idsf-common.js";

/**
 * Internal IDSF bitstream helpers.
 *
 * Public IDSF callers only need state builders, error codes, and unpacking.
 * Encode-side packers stay here, while the bit planner lives in `idsf-plan.js`.
 */
export {
  AT5_IDSF_ERROR_CODES,
  createAt5IdsfChannelState,
  createAt5IdsfSharedState,
  unpackIdsf,
} from "./idsf.js";

const idsfShapeDiffScratch = new Int32Array(AT5_IDSF_MAX_VALUES);

function huffSfTable(mode) {
  return AT5_HC_SF[mode] ?? AT5_HC_SF[0];
}

function huffSfSgTable(mode) {
  return AT5_HC_SF_SG[mode] ?? AT5_HC_SF_SG[0];
}

function idsfMode2EncodedValue(mode2, index, value) {
  if (mode2 <= 0 || mode2 > 2) {
    return value >>> 0;
  }
  return ((value | 0) + (AT5_IDSF_MODE2_DELTA[mode2 - 1]?.[index] ?? 0)) >>> 0;
}

function packIdsfShapeHeader(idsf, dst, bitState) {
  return (
    at5PackStoreFromMsb(idsf.baseValue & 0x3f, 6, dst, bitState) &&
    at5PackStoreFromMsb(idsf.cbIndex & 0x3f, 6, dst, bitState)
  );
}

function createIdsfShapeDiffs(idsf, count) {
  const diffs = idsfShapeDiffScratch;
  idsfInitShape(diffs, count, idsf.baseValue | 0, idsf.cbIndex | 0);
  for (let index = 0; index < count; index += 1) {
    diffs[index] = ((idsf.values[index] & 0x3f) - (diffs[index] & 0x3f)) & 0x3f;
  }
  return diffs;
}

function packMode0Idsf(idsf, count, dst, bitState) {
  for (let index = 0; index < count; index += 1) {
    if (!at5PackStoreFromMsb(idsf.values[index] & 0x3f, 6, dst, bitState)) {
      return false;
    }
  }
  return true;
}

function packSecondaryMode1Idsf(idsf, count, baseValues, dst, bitState) {
  if (!at5PackStoreFromMsb(idsf.mode & 0x3, 2, dst, bitState)) {
    return false;
  }

  const table = huffSfTable(idsf.mode >>> 0);
  for (let index = 0; index < count; index += 1) {
    if (!at5PackSym(table, (idsf.values[index] - baseValues[index]) & 0x3f, dst, bitState)) {
      return false;
    }
  }
  return true;
}

function packPrimaryMode1Idsf(idsf, count, dst, bitState) {
  const mode2 = idsf.mode2 >>> 0;
  if (!at5PackStoreFromMsb(mode2 & 0x3, 2, dst, bitState)) {
    return false;
  }

  const lead = idsf.lead >>> 0;
  const width = idsf.width >>> 0;
  if (mode2 === 3) {
    const diffs = createIdsfShapeDiffs(idsf, count);
    const base = idsf.base | 0;
    if (
      !packIdsfShapeHeader(idsf, dst, bitState) ||
      !at5PackStoreFromMsb(lead & 0x1f, 5, dst, bitState) ||
      !at5PackStoreFromMsb(width & 0x3, 2, dst, bitState) ||
      !at5PackStoreFromMsb((base + 7) & 0xf, 4, dst, bitState)
    ) {
      return false;
    }

    for (let index = 0; index < lead; index += 1) {
      if (!at5PackStoreFromMsb((wrapSigned6(diffs[index]) + 7) >>> 0, 4, dst, bitState)) {
        return false;
      }
    }
    for (let index = lead; index < count && width !== 0; index += 1) {
      if (!at5PackStoreFromMsb((diffs[index] - base) & 0x3f, width, dst, bitState)) {
        return false;
      }
    }
    return true;
  }

  const base = idsf.base & 0x3f;
  if (
    !at5PackStoreFromMsb(lead & 0x1f, 5, dst, bitState) ||
    !at5PackStoreFromMsb(width & 0x7, 3, dst, bitState) ||
    !at5PackStoreFromMsb(base, 6, dst, bitState)
  ) {
    return false;
  }

  for (let index = 0; index < lead; index += 1) {
    if (
      !at5PackStoreFromMsb(
        idsfMode2EncodedValue(mode2, index, idsf.values[index]) & 0x3f,
        6,
        dst,
        bitState
      )
    ) {
      return false;
    }
  }
  for (let index = lead; index < count && width !== 0; index += 1) {
    if (
      !at5PackStoreFromMsb(
        (idsfMode2EncodedValue(mode2, index, idsf.values[index]) - base) >>> 0,
        width,
        dst,
        bitState
      )
    ) {
      return false;
    }
  }

  return true;
}

function packPrimaryMode2Idsf(idsf, count, dst, bitState) {
  if (
    !at5PackStoreFromMsb(idsf.mode & 0x3, 2, dst, bitState) ||
    !packIdsfShapeHeader(idsf, dst, bitState)
  ) {
    return false;
  }

  const diffs = createIdsfShapeDiffs(idsf, count);
  const table = huffSfSgTable(idsf.mode >>> 0);
  for (let index = 0; index < count; index += 1) {
    if (!at5PackSym(table, wrapSigned6(diffs[index]) & 0xf, dst, bitState)) {
      return false;
    }
  }
  return true;
}

function packSecondaryMode2Idsf(idsf, count, baseValues, dst, bitState) {
  if (!at5PackStoreFromMsb(idsf.mode & 0x3, 2, dst, bitState)) {
    return false;
  }

  const table = huffSfTable(idsf.mode >>> 0);
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const current = (idsf.values[index] - baseValues[index]) & 0x3f;
    const symbol = index === 0 ? current : (current - previous) & 0x3f;
    if (!at5PackSym(table, symbol, dst, bitState)) {
      return false;
    }
    previous = current;
  }
  return true;
}

function packPrimaryMode3Idsf(idsf, count, dst, bitState) {
  const mode2 = idsf.mode2 >>> 0;
  const mode = idsf.mode >>> 0;
  if (
    !at5PackStoreFromMsb(mode2 & 0x3, 2, dst, bitState) ||
    !at5PackStoreFromMsb(mode & 0x3, 2, dst, bitState)
  ) {
    return false;
  }

  if (mode2 === 3) {
    if (!packIdsfShapeHeader(idsf, dst, bitState)) {
      return false;
    }

    const diffs = createIdsfShapeDiffs(idsf, count);
    const table = huffSfSgTable(mode);
    let previous = 0;
    for (let index = 0; index < count; index += 1) {
      const current = diffs[index] >>> 0;
      if (index === 0) {
        if (!at5PackStoreFromMsb(current + 8, 4, dst, bitState)) {
          return false;
        }
      } else if (!at5PackSym(table, (current - previous) & 0xf, dst, bitState)) {
        return false;
      }
      previous = current;
    }
    return true;
  }

  const table = huffSfTable(mode);
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const current = idsfMode2EncodedValue(mode2, index, idsf.values[index]) & 0x3f;
    if (index === 0) {
      if (!at5PackStoreFromMsb(current, 6, dst, bitState)) {
        return false;
      }
    } else if (!at5PackSym(table, (current - previous) & 0x3f, dst, bitState)) {
      return false;
    }
    previous = current;
  }
  return true;
}

export function packIdsfChannel(channel, dst, bitState) {
  const count = idsfCount(channel);
  if (count === 0) {
    return true;
  }

  const primaryChannel = channel.channelIndex >>> 0 === 0;
  const idsf = channel.idsf;
  const baseValues = (channel.block0 ?? channel).idsf.values;
  switch (channel.idsfModeSelect >>> 0) {
    case 0:
      return packMode0Idsf(idsf, count, dst, bitState);
    case 1:
      return primaryChannel
        ? packPrimaryMode1Idsf(idsf, count, dst, bitState)
        : packSecondaryMode1Idsf(idsf, count, baseValues, dst, bitState);
    case 2:
      return primaryChannel
        ? packPrimaryMode2Idsf(idsf, count, dst, bitState)
        : packSecondaryMode2Idsf(idsf, count, baseValues, dst, bitState);
    default:
      return primaryChannel ? packPrimaryMode3Idsf(idsf, count, dst, bitState) : true;
  }
}

export { calcNbitsForIdsfChAt5 } from "./idsf-plan.js";
