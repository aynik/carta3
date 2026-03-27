import {
  AT5_ERROR_IDSF_BAD_LEAD,
  AT5_ERROR_IDSF_BAD_LEAD_MODE2_3,
  AT5_ERROR_IDSF_VALUE_RANGE,
  AT5_ERROR_IDSF_WIDTH_TOO_LARGE,
  AT5_IDSF_MAX_VALUES,
  idsfApplyMode2Delta,
  idsfCount,
  idsfInitShape,
  setIdsfBlockError,
  signedNibble,
} from "./idsf-common.js";
import { at5DecodeSym, at5ReadBits } from "./bitstream.js";
import { AT5_HC_SF, AT5_HC_SF_SG } from "../tables/unpack.js";

export function createAt5IdsfSharedState(idsfCount) {
  return {
    idsfCount: idsfCount >>> 0,
    idsfGroupCount: 0,
  };
}

export function createAt5IdsfChannelState(channelIndex, shared, block0 = null) {
  return {
    channelIndex: channelIndex >>> 0,
    shared,
    block0: block0 ?? null,
    blockErrorCode: 0,
    idsf: {
      values: new Uint32Array(AT5_IDSF_MAX_VALUES),
      modeSelect: 0,
      lead: 0,
      width: 0,
      base: 0,
      mode: 0,
      mode2: 0,
      cbIndex: 0,
      baseValue: 0,
    },
  };
}

export const AT5_IDSF_ERROR_CODES = {
  VALUE_RANGE: AT5_ERROR_IDSF_VALUE_RANGE,
  WIDTH_TOO_LARGE: AT5_ERROR_IDSF_WIDTH_TOO_LARGE,
  BAD_LEAD: AT5_ERROR_IDSF_BAD_LEAD,
  BAD_LEAD_MODE2_3: AT5_ERROR_IDSF_BAD_LEAD_MODE2_3,
};

function huffSfTable(mode) {
  return AT5_HC_SF[mode] ?? AT5_HC_SF[0];
}

function huffSfSgTable(mode) {
  return AT5_HC_SF_SG[mode] ?? AT5_HC_SF_SG[0];
}

function readIdsfLead(channel, count, frame, bitState, errorCode) {
  const lead = at5ReadBits(frame, bitState, 5);
  channel.idsf.lead = lead;
  if (lead > count) {
    setIdsfBlockError(channel, errorCode);
    return -1;
  }
  return lead;
}

function readIdsfShape(channel, count, values, frame, bitState) {
  const idsf = channel.idsf;
  idsf.baseValue = at5ReadBits(frame, bitState, 6);
  idsf.cbIndex = at5ReadBits(frame, bitState, 6);
  idsfInitShape(values, count, idsf.baseValue, idsf.cbIndex);
}

function unpackPrimaryIdsf0(channel, frame, bitState) {
  const count = idsfCount(channel);
  const values = channel.idsf.values;
  for (let index = 0; index < count; index += 1) {
    values[index] = at5ReadBits(frame, bitState, 6);
  }
  return true;
}

function unpackPrimaryIdsfMode1Shape(channel, frame, bitState, count, values) {
  readIdsfShape(channel, count, values, frame, bitState);

  const lead = readIdsfLead(channel, count, frame, bitState, AT5_ERROR_IDSF_BAD_LEAD_MODE2_3);
  if (lead < 0) {
    return false;
  }

  const idsf = channel.idsf;
  idsf.width = at5ReadBits(frame, bitState, 2);
  idsf.base = (at5ReadBits(frame, bitState, 4) | 0) - 7;

  for (let index = 0; index < lead; index += 1) {
    values[index] = ((values[index] | 0) + (at5ReadBits(frame, bitState, 4) | 0) - 7) >>> 0;
  }

  if (idsf.width > 0) {
    for (let index = lead; index < count; index += 1) {
      values[index] =
        ((values[index] | 0) + (at5ReadBits(frame, bitState, idsf.width) | 0) + idsf.base) >>> 0;
    }
  } else if (lead < count) {
    for (let index = lead; index < count; index += 1) {
      values[index] = ((values[index] | 0) + idsf.base) >>> 0;
    }
  }

  for (let index = 0; index < count; index += 1) {
    values[index] &= 0x3f;
  }
  return true;
}

function unpackPrimaryIdsfMode1Direct(channel, frame, bitState, count, values) {
  const lead = readIdsfLead(channel, count, frame, bitState, AT5_ERROR_IDSF_BAD_LEAD);
  if (lead < 0) {
    return false;
  }

  const idsf = channel.idsf;
  idsf.width = at5ReadBits(frame, bitState, 3);
  if (idsf.width > 6) {
    setIdsfBlockError(channel, AT5_ERROR_IDSF_WIDTH_TOO_LARGE);
    return false;
  }

  idsf.base = at5ReadBits(frame, bitState, 6);
  for (let index = 0; index < lead; index += 1) {
    values[index] = at5ReadBits(frame, bitState, 6);
  }

  if (idsf.width > 0) {
    for (let index = lead; index < count; index += 1) {
      values[index] = at5ReadBits(frame, bitState, idsf.width) + idsf.base;
    }
  } else {
    values.fill(idsf.base >>> 0, lead, count);
  }

  idsfApplyMode2Delta(idsf.mode2, values, count);
  return true;
}

function unpackPrimaryIdsf1(channel, frame, bitState) {
  const count = idsfCount(channel);
  const idsf = channel.idsf;
  const values = idsf.values;

  idsf.mode2 = at5ReadBits(frame, bitState, 2);
  if (idsf.mode2 === 3) {
    return unpackPrimaryIdsfMode1Shape(channel, frame, bitState, count, values);
  }
  return unpackPrimaryIdsfMode1Direct(channel, frame, bitState, count, values);
}

function unpackPrimaryIdsf2(channel, frame, bitState) {
  const count = idsfCount(channel);
  const idsf = channel.idsf;
  const values = idsf.values;

  idsf.mode = at5ReadBits(frame, bitState, 2);
  readIdsfShape(channel, count, values, frame, bitState);

  const table = huffSfSgTable(idsf.mode);
  for (let index = 0; index < count; index += 1) {
    values[index] =
      ((values[index] | 0) + signedNibble(at5DecodeSym(table, frame, bitState))) & 0x3f;
  }
  return true;
}

function unpackPrimaryIdsf3(channel, frame, bitState) {
  const count = idsfCount(channel);
  const idsf = channel.idsf;
  const values = idsf.values;

  idsf.mode2 = at5ReadBits(frame, bitState, 2);
  idsf.mode = at5ReadBits(frame, bitState, 2);

  if (idsf.mode2 === 3) {
    readIdsfShape(channel, count, values, frame, bitState);

    const firstDelta = at5ReadBits(frame, bitState, 4);
    if (count === 0) {
      return true;
    }

    const table = huffSfSgTable(idsf.mode);
    let delta = (firstDelta - 8) & 0x3f;
    values[0] = (values[0] + delta) & 0x3f;

    for (let index = 1; index < count; index += 1) {
      delta = (delta + signedNibble(at5DecodeSym(table, frame, bitState))) & 0x3f;
      values[index] = (values[index] + delta) & 0x3f;
    }
    return true;
  }

  const table = huffSfTable(idsf.mode);
  values[0] = at5ReadBits(frame, bitState, 6);
  for (let index = 1; index < count; index += 1) {
    values[index] = (at5DecodeSym(table, frame, bitState) + values[index - 1]) & 0x3f;
  }

  idsfApplyMode2Delta(idsf.mode2, values, count);
  return true;
}

function unpackSecondaryIdsf1(channel, frame, bitState, count, values) {
  const idsf = channel.idsf;
  idsf.mode = at5ReadBits(frame, bitState, 2);
  if (count === 0) {
    return true;
  }

  const baseValues = channel.block0?.idsf?.values ?? values;
  const table = huffSfTable(idsf.mode);
  for (let index = 0; index < count; index += 1) {
    values[index] = (at5DecodeSym(table, frame, bitState) + baseValues[index]) & 0x3f;
  }
  return true;
}

function unpackSecondaryIdsf2(channel, frame, bitState, count, values) {
  const idsf = channel.idsf;
  idsf.mode = at5ReadBits(frame, bitState, 2);

  const baseValues = channel.block0?.idsf?.values ?? values;
  const table = huffSfTable(idsf.mode);
  if (count > 0) {
    values[0] = (at5DecodeSym(table, frame, bitState) + baseValues[0]) & 0x3f;
  }
  for (let index = 1; index < count; index += 1) {
    const delta = (values[index - 1] - baseValues[index - 1]) & 0x3f;
    values[index] = (at5DecodeSym(table, frame, bitState) + delta + baseValues[index]) & 0x3f;
  }
  return true;
}

function copyBlock0IdsfValues(channel, count, values) {
  const source = channel.block0?.idsf?.values ?? values;
  for (let index = 0; index < count; index += 1) {
    values[index] = source[index];
  }
  return true;
}

function validateIdsfValues(channel, count, values) {
  for (let index = 0; index < count; index += 1) {
    if (values[index] > 0x3f) {
      setIdsfBlockError(channel, AT5_ERROR_IDSF_VALUE_RANGE);
      return false;
    }
  }
  return true;
}

/**
 * Decode ATRAC3plus IDSF scalefactors from the bitstream into the channel state.
 */
export function unpackIdsf(channel, frame, bitState, modeSelect) {
  const count = idsfCount(channel);
  const values = channel.idsf.values;
  values.fill(0);
  channel.blockErrorCode = 0;
  channel.idsf.modeSelect = modeSelect >>> 0;

  const isPrimaryChannel = (channel.channelIndex | 0) === 0;
  let ok = false;
  switch (modeSelect) {
    case 0:
      ok = unpackPrimaryIdsf0(channel, frame, bitState);
      break;
    case 1:
      ok = isPrimaryChannel
        ? unpackPrimaryIdsf1(channel, frame, bitState)
        : unpackSecondaryIdsf1(channel, frame, bitState, count, values);
      break;
    case 2:
      ok = isPrimaryChannel
        ? unpackPrimaryIdsf2(channel, frame, bitState)
        : unpackSecondaryIdsf2(channel, frame, bitState, count, values);
      break;
    default:
      ok = isPrimaryChannel
        ? unpackPrimaryIdsf3(channel, frame, bitState)
        : copyBlock0IdsfValues(channel, count, values);
      break;
  }

  return ok && validateIdsfValues(channel, count, values);
}
