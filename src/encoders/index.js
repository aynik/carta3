/**
 * Stable encoder public surface.
 *
 * The public encoder API is intentionally limited to profile lookup, PCM frame
 * preparation, the generic ATRAC dispatcher, the SCX convenience wrapper, and
 * WAV container helpers. Shared wrapper PCM staging lives in `encoders/pcm.js`,
 * container serialization lives under `container/`, and direct per-codec
 * runtime entrypoints stay in their codec-owned wrapper modules.
 */
export {
  atxChannelCountForMode,
  atxChannelMaskForChannelCount,
  atxModeForChannelCount,
  findAtracEncodeProfile,
  listAtracEncodeProfiles,
  roundDivU32,
  selectAtracEncodeProfile,
} from "./profiles.js";
export {
  ATRAC3_DELAY_SAMPLES,
  ATRAC3PLUS_DELAY_SAMPLES,
  atracEncoderDelaySamples,
  computeAtracEncodeFactParam,
} from "./fact.js";
export {
  computeAtracEncodePadPlan,
  prepareAtracEncodePcmFrames,
  splitInterleavedPcmFrames,
} from "./pcm.js";
export { interleavedFrameToPlanar } from "../common/pcm-planar.js";
export {
  encodeAtrac3ScxFramesFromInterleavedPcm,
  encodeAtrac3ScxWavBufferFromInterleavedPcm,
} from "./atrac3-scx.js";
export {
  encodeAtracFramesFromInterleavedPcm,
  encodeAtracWavBufferFromInterleavedPcm,
} from "./atrac.js";
export { buildAtracWavBuffer } from "../container/wav-build.js";
export { createAtracEncodeWavFormat } from "../container/wav-format.js";
