/**
 * Intensity-difference word-length bitstream state and unpacking.
 *
 * This mirrors the top-level layout used by the other ATRAC3plus block payload
 * modules so callers can find the stable IDWL transport surface without
 * stepping through an extra folder.
 */
import { at5DecodeSym, at5ReadBits } from "./bitstream.js";
import { AT5_HC_WL, AT5_SG_SHAPE_INDEX, AT5_WLC_COEF, AT5_WLC_SG_CB } from "../tables/unpack.js";

const AT5_ERROR_BAD_MODE3_END_CH0 = 0x10c;
const AT5_ERROR_BAD_LEAD_COUNT = 0x10d;
const AT5_ERROR_BAD_MODE3_END_CHN = 0x10e;
const AT5_ERROR_COUNT_EXCEEDS_LIMIT = 0x10f;
const AT5_ERROR_IDWL_VALUE_RANGE = 0x10b;

const AT5_IDWL_MAX_VALUES = 32;

export function createAt5IdwlSharedState(codedBandLimit) {
  return {
    codedBandLimit: codedBandLimit >>> 0,
    pairCount: 0,
    pairFlags: new Uint32Array(16),
  };
}

export function createAt5IdwlChannelState(channelIndex, shared, block0 = null) {
  return {
    channelIndex: channelIndex >>> 0,
    shared,
    block0: block0 ?? null,
    blockErrorCode: 0,
    idwl: {
      values: new Uint32Array(AT5_IDWL_MAX_VALUES),
      lead: 0,
      width: 0,
      base: 0,
      wlc: 0,
      wl: 0,
      mode: 0,
      count: 0,
      extra: 0,
      shapeShift: 0,
      shapeBase: 0,
      pairFlag: 0,
    },
  };
}

function setBlockError(channel, code) {
  channel.blockErrorCode = code >>> 0;
}

function idwlLimit(channel) {
  return channel.shared.codedBandLimit >>> 0;
}

function fillIdwlTail(channel, frame, bitState, count, limit, mode) {
  const values = channel.idwl.values;
  const isPrimaryChannel = channel.channelIndex === 0;

  if (mode === 1) {
    values.fill(0, count, limit);
    return true;
  }

  if (mode === 2) {
    if (isPrimaryChannel) {
      values.fill(1, count, limit);
    } else {
      for (let i = count; i < limit; i += 1) {
        values[i] = at5ReadBits(frame, bitState, 1);
      }
    }
    return true;
  }

  if (mode === 3) {
    const extra = channel.idwl.extra;
    const end = isPrimaryChannel ? limit - extra : count + extra;
    const invalid = isPrimaryChannel ? count > end || end >= limit : count >= end || end > limit;
    if (invalid) {
      setBlockError(
        channel,
        isPrimaryChannel ? AT5_ERROR_BAD_MODE3_END_CH0 : AT5_ERROR_BAD_MODE3_END_CHN
      );
      return false;
    }

    values.fill(1, count, end);
    values.fill(0, end, limit);
  }

  return true;
}

function applyIdwlWlc(channel, limit, wlc) {
  if (wlc === 0 || limit === 0) {
    return;
  }

  const coeffOffset = (wlc + channel.channelIndex * 3 - 1) * 32;
  const values = channel.idwl.values;
  for (let i = 0; i < limit; i += 1) {
    values[i] = ((values[i] | 0) + (AT5_WLC_COEF[coeffOffset + i] | 0)) >>> 0;
  }
}

function huffIdwlTable(wl) {
  return AT5_HC_WL[wl] ?? AT5_HC_WL[0];
}

function readIdwlHeader(
  channel,
  frame,
  bitState,
  { includeWlc = false, zeroCountMeansLimit = false } = {}
) {
  const limit = idwlLimit(channel);
  const idwl = channel.idwl;

  if (includeWlc) {
    idwl.wlc = at5ReadBits(frame, bitState, 2);
  }

  const mode = at5ReadBits(frame, bitState, 2);
  idwl.mode = mode;

  if (mode === 0) {
    idwl.count = limit;
    return { count: limit, limit, mode };
  }

  let count = at5ReadBits(frame, bitState, 5);
  if (zeroCountMeansLimit && count === 0) {
    count = limit;
  } else if (count > limit) {
    setBlockError(channel, AT5_ERROR_COUNT_EXCEEDS_LIMIT);
    return null;
  }

  idwl.count = count;
  if (mode === 3) {
    idwl.extra = at5ReadBits(frame, bitState, 2) + (channel.channelIndex === 0 ? 1 : 3);
  }

  return { count, limit, mode };
}

function readIdwlTable(channel, frame, bitState, bitCount) {
  const wl = at5ReadBits(frame, bitState, bitCount);
  channel.idwl.wl = wl;
  return huffIdwlTable(wl);
}

function addDecodedSymbols(values, start, count, table, frame, bitState) {
  for (let i = start; i < count; i += 1) {
    values[i] = (values[i] + at5DecodeSym(table, frame, bitState)) >>> 0;
  }
}

function fillIdwlShapeValues(values, count, base, shift) {
  const shapeCount = (AT5_SG_SHAPE_INDEX[count - 1] | 0) + 1;
  const tableOffset = base * 144 + shift * 9;

  for (let i = 0; i < count; i += 1) {
    const shapeSlot = AT5_SG_SHAPE_INDEX[i] | 0;
    values[i] =
      shapeSlot > 0 && shapeSlot < shapeCount
        ? (base - (AT5_WLC_SG_CB[tableOffset + shapeSlot - 1] | 0)) >>> 0
        : base >>> 0;
  }
}

function unpackPrimaryWidthValues(channel, count, frame, bitState) {
  const values = channel.idwl.values;
  const idwl = channel.idwl;

  const lead = at5ReadBits(frame, bitState, 5);
  idwl.lead = lead;
  if (lead > count) {
    setBlockError(channel, AT5_ERROR_BAD_LEAD_COUNT);
    return false;
  }

  const width = at5ReadBits(frame, bitState, 2);
  idwl.width = width;
  const base = at5ReadBits(frame, bitState, 3);
  idwl.base = base;

  for (let i = 0; i < lead; i += 1) {
    values[i] = at5ReadBits(frame, bitState, 3);
  }

  if (width > 0) {
    for (let i = lead; i < count; i += 1) {
      values[i] = at5ReadBits(frame, bitState, width) + base;
    }
  } else {
    values.fill(base >>> 0, lead, count);
  }

  return true;
}

function unpackShapeValues(channel, count, frame, bitState) {
  const idwl = channel.idwl;
  const values = idwl.values;

  const pairFlag = at5ReadBits(frame, bitState, 1);
  idwl.pairFlag = pairFlag;

  const table = readIdwlTable(channel, frame, bitState, 1);
  const base = at5ReadBits(frame, bitState, 3);
  idwl.shapeBase = base;
  const shift = at5ReadBits(frame, bitState, 4);
  idwl.shapeShift = shift;

  fillIdwlShapeValues(values, count, base, shift);

  if (pairFlag !== 0) {
    const pairCount = count >>> 1;
    channel.shared.pairCount = pairCount;

    for (let i = 0; i < pairCount; i += 1) {
      if (at5ReadBits(frame, bitState, 1) !== 0) {
        continue;
      }

      const index = i * 2;
      values[index] = (values[index] + at5DecodeSym(table, frame, bitState)) >>> 0;
      values[index + 1] = (values[index + 1] + at5DecodeSym(table, frame, bitState)) >>> 0;
    }

    addDecodedSymbols(values, pairCount * 2, count, table, frame, bitState);
  } else {
    addDecodedSymbols(values, 0, count, table, frame, bitState);
  }

  for (let i = 0; i < count; i += 1) {
    values[i] &= 0x7;
  }

  return true;
}

function unpackSequentialValues(channel, count, frame, bitState) {
  const values = channel.idwl.values;
  const table = readIdwlTable(channel, frame, bitState, 2);

  values[0] = at5ReadBits(frame, bitState, 3);
  for (let i = 1; i < count; i += 1) {
    values[i] = (at5DecodeSym(table, frame, bitState) + values[i - 1]) & 0x7;
  }
}

function unpackStereoValues(channel, count, frame, bitState, chained) {
  const values = channel.idwl.values;
  const prevValues = (channel.block0 ?? channel).idwl.values;
  const table = readIdwlTable(channel, frame, bitState, 2);

  if (!chained) {
    for (let i = 0; i < count; i += 1) {
      values[i] = (at5DecodeSym(table, frame, bitState) + prevValues[i]) & 0x7;
    }
    return;
  }

  values[0] = (at5DecodeSym(table, frame, bitState) + prevValues[0]) & 0x7;
  for (let i = 1; i < count; i += 1) {
    const delta = (values[i - 1] - prevValues[i - 1]) & 0x7;
    values[i] = (at5DecodeSym(table, frame, bitState) + delta + prevValues[i]) & 0x7;
  }
}

function unpackIdwl0(channel, frame, bitState) {
  const count = idwlLimit(channel);
  const values = channel.idwl.values;

  for (let i = 0; i < count; i += 1) {
    values[i] = at5ReadBits(frame, bitState, 3);
  }
  return true;
}

export function unpackIdwl(channel, frame, bitState, packMode) {
  const values = channel.idwl.values;
  values.fill(0);
  channel.blockErrorCode = 0;

  const isPrimaryChannel = channel.channelIndex === 0;
  switch (packMode) {
    case 0:
      unpackIdwl0(channel, frame, bitState);
      break;
    case 1: {
      const header = readIdwlHeader(channel, frame, bitState, {
        includeWlc: isPrimaryChannel,
        zeroCountMeansLimit: isPrimaryChannel,
      });
      if (!header) {
        return false;
      }

      const { count, limit, mode } = header;
      if (count > 0) {
        if (isPrimaryChannel) {
          if (!unpackPrimaryWidthValues(channel, count, frame, bitState)) {
            return false;
          }
        } else {
          unpackStereoValues(channel, count, frame, bitState, false);
        }
      }
      if (!fillIdwlTail(channel, frame, bitState, count, limit, mode)) {
        return false;
      }
      if (isPrimaryChannel) {
        applyIdwlWlc(channel, limit, channel.idwl.wlc);
      }
      break;
    }
    case 2: {
      const header = readIdwlHeader(channel, frame, bitState);
      if (!header) {
        return false;
      }

      const { count, limit, mode } = header;
      if (count > 0) {
        if (isPrimaryChannel) {
          unpackShapeValues(channel, count, frame, bitState);
        } else {
          unpackStereoValues(channel, count, frame, bitState, true);
        }
      }
      if (!fillIdwlTail(channel, frame, bitState, count, limit, mode)) {
        return false;
      }
      break;
    }
    default: {
      const header = readIdwlHeader(channel, frame, bitState, { includeWlc: true });
      if (!header) {
        return false;
      }

      const { count, limit, mode } = header;
      if (count > 0) {
        unpackSequentialValues(channel, count, frame, bitState);
      }
      if (!fillIdwlTail(channel, frame, bitState, count, limit, mode)) {
        return false;
      }

      applyIdwlWlc(channel, limit, channel.idwl.wlc);
      break;
    }
  }

  const limit = idwlLimit(channel);
  for (let i = 0; i < limit; i += 1) {
    if (values[i] > 7) {
      setBlockError(channel, AT5_ERROR_IDWL_VALUE_RANGE);
      return false;
    }
  }

  return true;
}

export const AT5_IDWL_ERROR_CODES = {
  BAD_MODE3_END_CH0: AT5_ERROR_BAD_MODE3_END_CH0,
  BAD_LEAD_COUNT: AT5_ERROR_BAD_LEAD_COUNT,
  BAD_MODE3_END_CHN: AT5_ERROR_BAD_MODE3_END_CHN,
  COUNT_EXCEEDS_LIMIT: AT5_ERROR_COUNT_EXCEEDS_LIMIT,
  VALUE_RANGE: AT5_ERROR_IDWL_VALUE_RANGE,
};
