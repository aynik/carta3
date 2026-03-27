/**
 * Shared utilities used across package-level helpers and codec internals.
 *
 * Keeping them under a single `common/` namespace makes it easier to study the
 * project structure without bouncing between top-level folders for basic data
 * handling, validation, PCM reshaping, and decode trim-window math.
 */
export { normalizeInputBytes } from "./bytes.js";
export {
  assertInterleavedPcmInput,
  assertPlanarF32Scratch,
  createPlanarF32Frame,
  ensurePlanarF32Frame,
  copyInterleavedPcmToPlanarF32,
  interleavedFrameToPlanar,
} from "./pcm-planar.js";
export { pcmI16FromF32Sample } from "./pcm-i16.js";
export { CodecError } from "./errors.js";
export { roundDivU32 } from "./math.js";
export {
  resolveCodecDecodedSampleWindow,
  resolveDecodedSampleWindow,
  resolveFactLeadInSamples,
  trimInterleavedPcm,
} from "./trim.js";
