/**
 * Stable ATRAC3plus bitstream transport surface.
 *
 * This barrel keeps the higher-level state builders and unpacking entrypoints
 * together so callers can study the frame structure without also pulling in
 * encode-only packers and bit-cost planners. Those lower-level helpers live in
 * `internal.js`.
 */
export {
  at5DecodeHcspecSymbols,
  at5ExpandHcspecToCoeffs,
  at5HcspecDescForBand,
  createAt5PresenceTable,
  createAt5SpectraChannelState,
  decodeAt5Presence,
  unpackChannelSpectra,
} from "./bitstream.js";

export { at5ActiveBandCount, createAt5RegularBlockState } from "./block-state.js";
export { AT5_CHANNEL_BLOCK_ERROR_CODES, unpackChannelBlockAt5Reg } from "./block-regular.js";
export { ATX_FRAME_UNPACK_ERROR_CODES, unpackAtxFrame } from "./frame-unpack.js";

export {
  AT5_GAIN_ERROR_CODES,
  AT5_GAIN_RECORDS,
  clearAt5GainRecords,
  createAt5GainChannelState,
  unpackGainIdlev,
  unpackGainIdloc,
  unpackGainNgc,
  unpackGainRecords,
} from "./gain.js";

export {
  AT5_GH_ERROR_CODES,
  clearAt5GhSlot,
  createAt5GhChannelState,
  createAt5GhSharedState,
  unpackGh,
} from "./gh.js";

export {
  AT5_IDCT_ERROR_CODES,
  createAt5IdctChannelState,
  createAt5IdctSharedState,
  unpackIdct,
} from "./idct.js";

export {
  AT5_IDSF_ERROR_CODES,
  createAt5IdsfChannelState,
  createAt5IdsfSharedState,
  unpackIdsf,
} from "./idsf.js";

export {
  AT5_IDWL_ERROR_CODES,
  createAt5IdwlChannelState,
  createAt5IdwlSharedState,
  unpackIdwl,
} from "./idwl.js";
