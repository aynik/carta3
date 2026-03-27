import { AT5_HC_CT, AT5_IDCT_FIXBITS } from "../tables/unpack.js";

const AT5_ERROR_IDCT_RANGE = 0x104;
const AT5_ERROR_BAD_IDCT_COUNT = 0x114;

export const AT5_IDCT_MAX_VALUES = 32;
export const AT5_IDCT_MODE_FIXED = 0;
export const AT5_IDCT_MODE_DIRECT = 1;
export const AT5_IDCT_MODE_DIFF = 2;
export const AT5_IDCT_MODE_COPY = 3;

export const AT5_IDCT_ERROR_CODES = {
  RANGE: AT5_ERROR_IDCT_RANGE,
  BAD_COUNT: AT5_ERROR_BAD_IDCT_COUNT,
};

export function setIdctBlockError(channel, code) {
  channel.blockErrorCode = code >>> 0;
}

export function clampIdctCount(count) {
  return Math.max(0, Math.min(count | 0, AT5_IDCT_MAX_VALUES));
}

export function setIdctTypes(channel, maxCount, typesOut = channel?.idct?.types) {
  if (!typesOut?.fill) {
    return typesOut;
  }

  typesOut.fill(0);

  const limit = clampIdctCount(Math.min(maxCount | 0, typesOut.length | 0));
  const idwl = channel?.idwl?.values;
  if (limit === 0 || !idwl) {
    return typesOut;
  }

  const referenceIdwl =
    (channel?.channelIndex | 0) === 0 ? null : (channel?.block0?.idwl?.values ?? idwl);
  for (let index = 0; index < limit; index += 1) {
    if (idwl[index] >>> 0 > 0) {
      typesOut[index] = 1;
    } else if (referenceIdwl && referenceIdwl[index] >>> 0 > 0) {
      typesOut[index] = 2;
    }
  }

  return typesOut;
}

export function createAt5IdctSharedState(options) {
  const { fixIdx = 0, maxCount = 0, gainModeFlag = 0 } = options ?? {};
  return {
    fixIdx: fixIdx >>> 0,
    maxCount: maxCount >>> 0,
    gainModeFlag: gainModeFlag >>> 0,
  };
}

export function createAt5IdctChannelState(channelIndex, shared, block0 = null) {
  return {
    channelIndex: channelIndex >>> 0,
    shared,
    block0: block0 ?? null,
    blockErrorCode: 0,
    idct: {
      count: 0,
      flag: 0,
      types: new Uint32Array(AT5_IDCT_MAX_VALUES),
      values: new Uint32Array(AT5_IDCT_MAX_VALUES),
    },
  };
}

export function idctTables(gainModeFlag) {
  const fixIdx = gainModeFlag >>> 0;
  const directTable = fixIdx !== 0 ? AT5_HC_CT[1] : AT5_HC_CT[0];
  return {
    fixBits: AT5_IDCT_FIXBITS[fixIdx] ?? AT5_IDCT_FIXBITS[0],
    directTable,
    diffTable: fixIdx !== 0 ? AT5_HC_CT[2] : AT5_HC_CT[0],
    firstDiffTable: directTable,
    pairTable: fixIdx !== 0 ? AT5_HC_CT[3] : AT5_HC_CT[0],
  };
}
