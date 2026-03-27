import { at5DecodeSym, at5HcValueMask, at5ReadBits } from "./bitstream.js";
import { AT5_HC_CT, AT5_IDCT_FIXBITS } from "../tables/unpack.js";
import { AT5_IDCT_ERROR_CODES, setIdctBlockError } from "./idct-common.js";

export {
  AT5_IDCT_ERROR_CODES,
  createAt5IdctChannelState,
  createAt5IdctSharedState,
} from "./idct-common.js";

function idctCountFromHeader(channel, frame, bitState, maxCount) {
  const flag = at5ReadBits(frame, bitState, 1);
  channel.idct.flag = flag;
  if (flag === 0) {
    return maxCount >>> 0;
  }

  const count = at5ReadBits(frame, bitState, 5);
  channel.idct.count = count;
  if (count > maxCount) {
    setIdctBlockError(channel, AT5_IDCT_ERROR_CODES.BAD_COUNT);
    return null;
  }

  return count >>> 0;
}

function zeroIdctValues(values, start, end) {
  values.fill(0, start >>> 0, end >>> 0);
}

function unpackIdctTypedValues(channel, frame, bitState, readType1) {
  const maxCount = channel.shared.maxCount >>> 0;
  const count = idctCountFromHeader(channel, frame, bitState, maxCount);
  if (count === null) {
    return false;
  }

  const { types, values: out } = channel.idct;
  for (let i = 0; i < count; i += 1) {
    const type = types[i] >>> 0;
    out[i] = type === 1 ? readType1(i) : type === 2 ? at5ReadBits(frame, bitState, 1) : 0;
  }
  zeroIdctValues(out, count, maxCount);
  return true;
}

function validateIdctRange(channel) {
  const maxIdct = channel.shared.gainModeFlag === 0 ? 4 : 8;
  const values = channel.idct.values;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] | 0;
    if (value < 0 || value >= maxIdct) {
      setIdctBlockError(channel, AT5_IDCT_ERROR_CODES.RANGE);
      return false;
    }
  }
  return true;
}

function unpackIdctFixed(channel, frame, bitState) {
  const fixIdx = channel.shared.fixIdx >>> 0;
  const fixBits = AT5_IDCT_FIXBITS[fixIdx] ?? AT5_IDCT_FIXBITS[0];
  return unpackIdctTypedValues(channel, frame, bitState, () =>
    at5ReadBits(frame, bitState, fixBits)
  );
}

function unpackIdctDirect(channel, frame, bitState) {
  const table = channel.shared.fixIdx >>> 0 !== 0 ? AT5_HC_CT[1] : AT5_HC_CT[0];
  return unpackIdctTypedValues(channel, frame, bitState, () =>
    at5DecodeSym(table, frame, bitState)
  );
}

function unpackIdctDiff(channel, frame, bitState) {
  const fixIdx = channel.shared.fixIdx >>> 0;
  const diffTable = fixIdx !== 0 ? AT5_HC_CT[2] : AT5_HC_CT[0];
  const firstTable = fixIdx !== 0 ? AT5_HC_CT[1] : AT5_HC_CT[0];
  const mask = at5HcValueMask(diffTable);
  let prev = 0;

  return unpackIdctTypedValues(channel, frame, bitState, (index) => {
    const value =
      index === 0
        ? at5DecodeSym(firstTable, frame, bitState)
        : (at5DecodeSym(diffTable, frame, bitState) + prev) & mask;
    prev = value;
    return value;
  });
}

function unpackIdctCopy(channel, frame, bitState) {
  if (channel.channelIndex === 0) {
    zeroIdctValues(channel.idct.values, 0, channel.shared.maxCount >>> 0);
    return true;
  }

  const table = channel.shared.fixIdx >>> 0 !== 0 ? AT5_HC_CT[3] : AT5_HC_CT[0];
  const mask = at5HcValueMask(table);
  const refValues = channel.block0?.idct?.values ?? channel.idct.values;
  return unpackIdctTypedValues(
    channel,
    frame,
    bitState,
    (index) => (at5DecodeSym(table, frame, bitState) + refValues[index]) & mask
  );
}

const UNPACK_IDCT_MODES = [unpackIdctFixed, unpackIdctDirect, unpackIdctDiff, unpackIdctCopy];

export function unpackIdct(channel, frame, bitState, modeSelect) {
  channel.blockErrorCode = 0;
  const unpackMode = UNPACK_IDCT_MODES[modeSelect | 0] ?? unpackIdctCopy;
  const ok = unpackMode(channel, frame, bitState);
  if (!ok) {
    return false;
  }
  return validateIdctRange(channel);
}
