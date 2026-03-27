/**
 * Internal ATRAC3plus codec helper barrel.
 *
 * The stable `codec.js` surface keeps the major encoder/decoder lifecycle
 * entrypoints together. Lower-level topology, synthesis, stereo-map, and
 * spectral reconstruction helpers live here for internal callers and focused
 * tests.
 */
export {
  ENCODE_SETTING_FIELDS,
  buildAtrac3plusCodecConfig,
  channelCountForBlockMode,
  computeCoreModeForBitBudget,
  createAtrac3plusEncodeHandle,
  decodeAtrac3plusCodecConfig,
  findAtrac3plusEncodeSetting,
  parseAtrac3plusCodecConfig,
} from "./encode-handle.js";

export {
  analyzeAtrac3plusRuntimeFrame,
  analyzeAtrac3plusSignalBlocks,
  coerceAtrac3plusInputChannels,
  encodeAtrac3plusRuntimeFrame,
  packAndProbeAtrac3plusFrameFromRegularBlocks,
  packAtrac3plusFrameFromRegularBlocks,
  prepareAtrac3plusInputFrame,
  updateAtrac3plusFlushFrames,
  zeroPadAtrac3plusFramePcm,
} from "./encode.js";
export { createAtrac3plusEncodeRuntime, normalizeAtrac3plusEncodeRuntime } from "./runtime.js";

export { Atrac3PlusDecoder } from "./decoder.js";
export { decodeAtrac3PlusFrame } from "./decode.js";
export { decodeAtrac3PlusFrames } from "./decode-output.js";
export { ATX_FRAME_SAMPLES, createAtxDecodeHandle } from "./handle.js";
export {
  ATRAC3PLUS_DEFAULT_FRAME_SAMPLES,
  ATRAC3PLUS_DELAY_SAMPLES,
  createAtrac3PlusDecoderState,
  parseAtrac3PlusCodecBytes,
} from "./state.js";

export { reconstructBlockSpectra } from "./decode-spectrum.js";

export {
  createAt5GhBandSynthesisState,
  createAt5GhSlotSynthesisState,
  resolveGhBandSynthesisState,
  resolveGhBandEnd,
  resolveGhBandStart,
  shouldApplyCurrentGhOverlapWindow,
  shouldApplyPreviousGhOverlapWindow,
  shouldUseSeparateGhOverlapWindows,
} from "./gh-synthesis.js";

export {
  addSpcNoiseBand,
  computeSpcBandNoiseScale,
  computeSpcNoiseBaseScale,
  resolveSpcSourceChannelIndex,
} from "./spc.js";

export {
  applyStereoMapTransforms,
  isStereoMapSwapped,
  resolveStereoMapSourceChannelIndex,
} from "./stereo-maps.js";

export { applySynthesisFilterbank } from "./synthesis-filterbank.js";

export {
  ATX_MAX_BLOCKS,
  blockChannelsForMode,
  blockCountForMode,
  blockLayoutForMode,
  resolveBlockMode,
} from "./topology.js";
