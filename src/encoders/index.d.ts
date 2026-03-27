import type {
  Atrac3ScxEncodeOptions,
  Atrac3ScxEncodeResult,
  Atrac3ScxEncodeWavResult,
  AtracEncodeOptions,
  AtracEncodePcmStagingRequest,
  AtracEncodePadPlan,
  AtracEncodeProfile,
  AtracEncodeResult,
  AtracEncodeWavFormat,
  AtracEncodeWavResult,
  BuildAtracWavOptions,
  PreparedAtracEncodeFrames,
} from "../public-types.js";

/**
 * Stable encoder package declarations.
 */
export const ATRAC3_DELAY_SAMPLES: number;
export const ATRAC3PLUS_DELAY_SAMPLES: number;
export function atxChannelCountForMode(mode: number): number | null;
export function atxModeForChannelCount(channels: number): number | null;
export function atxChannelMaskForChannelCount(channels: number): number | null;
export function roundDivU32(numerator: number, denom: number): number;
export function atracEncoderDelaySamples(
  codecOrProfile: "atrac3" | "atrac3plus" | AtracEncodeProfile
): number;
export function computeAtracEncodeFactParam(
  loopEnd: number,
  frameSamples: number,
  factBaseDelaySamples: number,
  encoderDelaySamples: number
): number;
export function findAtracEncodeProfile(
  bitrateKbps: number,
  channels: number,
  sampleRate: number
): AtracEncodeProfile | null;
export function listAtracEncodeProfiles(): AtracEncodeProfile[];
export function selectAtracEncodeProfile(
  bitrateKbps: number,
  channels: number,
  sampleRate: number,
  requestedCodec?: "atrac3" | "atrac3plus" | null
): AtracEncodeProfile;

export function computeAtracEncodePadPlan(
  frameSamples: number,
  factParam: number,
  encoderDelaySamples: number
): AtracEncodePadPlan;
export function interleavedFrameToPlanar(pcmI16: Int16Array, channels: number): Int16Array[];
export function splitInterleavedPcmFrames(
  pcmI16: Int16Array,
  channels: number,
  frameSamples: number
): Int16Array[];
export function prepareAtracEncodePcmFrames(
  request: AtracEncodePcmStagingRequest
): PreparedAtracEncodeFrames;

export function encodeAtrac3ScxFramesFromInterleavedPcm(
  pcmI16: Int16Array,
  options?: Atrac3ScxEncodeOptions
): Atrac3ScxEncodeResult;
export function encodeAtrac3ScxWavBufferFromInterleavedPcm(
  pcmI16: Int16Array,
  options?: Atrac3ScxEncodeOptions
): Atrac3ScxEncodeWavResult;
export function encodeAtracFramesFromInterleavedPcm(
  pcmI16: Int16Array,
  options?: AtracEncodeOptions
): AtracEncodeResult;
export function encodeAtracWavBufferFromInterleavedPcm(
  pcmI16: Int16Array,
  options?: AtracEncodeOptions
): AtracEncodeWavResult;

export function createAtracEncodeWavFormat(profile: AtracEncodeProfile): AtracEncodeWavFormat;
export function buildAtracWavBuffer(options: BuildAtracWavOptions): Uint8Array;
