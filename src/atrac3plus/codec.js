/**
 * ATRAC3plus encoder and decoder state, handles, and frame entrypoints.
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
export { ATX_FRAME_SAMPLES, createAtxDecodeHandle } from "./handle.js";
export {
  ATRAC3PLUS_DEFAULT_FRAME_SAMPLES,
  ATRAC3PLUS_DELAY_SAMPLES,
  createAtrac3PlusDecoderState,
  parseAtrac3PlusCodecBytes,
} from "./state.js";
