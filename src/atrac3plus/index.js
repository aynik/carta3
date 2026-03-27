/**
 * Stable ATRAC3plus public surface.
 *
 * This module collects the decode-facing ATRAC3plus entrypoints that external
 * callers can study directly: decoder lifecycle helpers, regular-block
 * bitstream transport, and the public DSP transforms used by synthesis.
 * Encode-only planners and staging helpers stay under codec internals.
 */
export {
  Atrac3PlusDecoder,
  createAtxDecodeHandle,
  createAtrac3PlusDecoderState,
  parseAtrac3PlusCodecBytes,
} from "./codec.js";
export {
  ATX_FRAME_UNPACK_ERROR_CODES,
  AT5_CHANNEL_BLOCK_ERROR_CODES,
  AT5_GAIN_ERROR_CODES,
  AT5_GAIN_RECORDS,
  AT5_GH_ERROR_CODES,
  AT5_IDCT_ERROR_CODES,
  AT5_IDSF_ERROR_CODES,
  AT5_IDWL_ERROR_CODES,
  at5ActiveBandCount,
  at5DecodeHcspecSymbols,
  at5ExpandHcspecToCoeffs,
  at5HcspecDescForBand,
  clearAt5GainRecords,
  clearAt5GhSlot,
  createAt5GainChannelState,
  createAt5GhChannelState,
  createAt5GhSharedState,
  createAt5IdctChannelState,
  createAt5IdctSharedState,
  createAt5IdsfChannelState,
  createAt5IdsfSharedState,
  createAt5IdwlChannelState,
  createAt5IdwlSharedState,
  createAt5PresenceTable,
  createAt5RegularBlockState,
  createAt5SpectraChannelState,
  decodeAt5Presence,
  unpackChannelSpectra,
  unpackGainIdlev,
  unpackGainIdloc,
  unpackGainNgc,
  unpackGainRecords,
  unpackGh,
  unpackIdct,
  unpackIdsf,
  unpackIdwl,
  unpackAtxFrame,
  unpackChannelBlockAt5Reg,
} from "./bitstream/index.js";

export {
  addSeqAt5,
  backwardTransformAt5,
  copyGainRecordToGaincBlock,
  createAt5GaincBlock,
  invmixSeqAt5,
  mixSeqAt5,
  subSeqAt5,
  synthesisWavAt5,
  winormalMdct128ExAt5,
} from "./dsp.js";
