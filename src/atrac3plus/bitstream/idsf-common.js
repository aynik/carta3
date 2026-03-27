import { AT5_IDSF_MODE2_DELTA, AT5_SFC_SG_CB, AT5_SG_SHAPE_INDEX } from "../tables/unpack.js";

export const AT5_ERROR_IDSF_VALUE_RANGE = 0x110;
export const AT5_ERROR_IDSF_WIDTH_TOO_LARGE = 0x111;
export const AT5_ERROR_IDSF_BAD_LEAD = 0x112;
export const AT5_ERROR_IDSF_BAD_LEAD_MODE2_3 = 0x113;

export const AT5_IDSF_MAX_VALUES = 32;

export function asInt8(value) {
  return (value & 0xff) > 127 ? (value & 0xff) - 256 : value & 0xff;
}

export function setIdsfBlockError(channel, code) {
  channel.blockErrorCode = code >>> 0;
}

export function idsfCount(channel) {
  return channel.shared.idsfCount >>> 0;
}

export function idsfShapeCount(count) {
  return (count | 0) <= 0 ? 0 : ((AT5_SG_SHAPE_INDEX[count - 1] | 0) + 1) | 0;
}

export function idsfApplyMode2Delta(mode2, values, count, wrap = false) {
  if (mode2 === 0 || mode2 > 2) {
    return;
  }

  const limit = Math.min(count, AT5_IDSF_MAX_VALUES);
  const delta = AT5_IDSF_MODE2_DELTA[mode2 - 1];
  for (let index = 0; index < limit; index += 1) {
    const value = (values[index] | 0) - (delta[index] | 0);
    values[index] = wrap ? value & 0x3f : value >>> 0;
  }
}

export function idsfInitShape(values, count, baseValue, cbIndex, wrap = false) {
  const shapeCount = idsfShapeCount(count);
  if (shapeCount === 0) {
    return;
  }

  const cbOffset = cbIndex * 9;
  for (let index = 0; index < count; index += 1) {
    const shapeSlot = AT5_SG_SHAPE_INDEX[index] | 0;
    const value =
      shapeSlot > 0 && shapeSlot < shapeCount
        ? (baseValue | 0) - asInt8(AT5_SFC_SG_CB[cbOffset + shapeSlot - 1])
        : baseValue | 0;
    values[index] = wrap ? value & 0x3f : value >>> 0;
  }
}

export function signedNibble(value) {
  return (value & 0x8) === 0 ? value & 0xf : (value & 0xf) | ~0xf;
}

export function wrapSigned6(value) {
  let wrapped = value | 0;
  if (wrapped > 0x1f) {
    wrapped -= 0x40;
  } else if (wrapped < -0x20) {
    wrapped += 0x40;
  }
  return wrapped | 0;
}
