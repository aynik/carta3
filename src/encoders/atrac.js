import { CodecError } from "../common/errors.js";
import { buildAtracWavBuffer } from "../container/wav-build.js";
import { encodeAtrac3FramesFromInterleavedPcm } from "./atrac3.js";
import { encodeAtrac3ScxFramesFromInterleavedPcm } from "./atrac3-scx.js";
import { encodeAtrac3plusFramesFromInterleavedPcm } from "./atrac3plus.js";
import { selectAtracEncodeProfile } from "./profiles.js";

/**
 * Encodes interleaved PCM with the authored ATRAC profile selected for the
 * requested transport.
 *
 * ATRAC3plus-only flags such as `encodeMode`, `useExactQuant`,
 * `maxOutputFrames`, and `collectDebug` stay on this shared dispatcher
 * surface, but they are forwarded only to the ATRAC3plus wrapper that owns
 * them.
 */
export function encodeAtracFramesFromInterleavedPcm(pcmI16, options = {}) {
  const {
    codec,
    bitrateKbps = 132,
    channels = 2,
    sampleRate = 44100,
    loopEnd = -1,
    context = null,
    encodeMode,
    useExactQuant,
    maxOutputFrames,
    collectDebug,
  } = options ?? {};
  const profile = selectAtracEncodeProfile(bitrateKbps, channels, sampleRate, codec);
  const sharedWrapperRequest = {
    bitrateKbps,
    channels,
    sampleRate,
    loopEnd,
    context,
    profile,
  };

  switch (profile.encodeVariant) {
    case "atrac3-algorithm0":
      return encodeAtrac3FramesFromInterleavedPcm(pcmI16, sharedWrapperRequest);
    case "atrac3-scx":
      return encodeAtrac3ScxFramesFromInterleavedPcm(pcmI16, sharedWrapperRequest);
    case "atrac3plus": {
      const atrac3plusWrapperRequest = {
        ...sharedWrapperRequest,
        encodeMode,
        useExactQuant,
        maxOutputFrames,
        collectDebug,
      };

      return encodeAtrac3plusFramesFromInterleavedPcm(pcmI16, atrac3plusWrapperRequest);
    }
    default:
      throw new CodecError(
        `encode path not implemented yet for variant=${profile.encodeVariant} ` +
          `bitrate=${profile.bitrateKbps} channels=${profile.channels} sampleRate=${profile.sampleRate}`
      );
  }
}

export function encodeAtracWavBufferFromInterleavedPcm(pcmI16, options = {}) {
  const { loopStart = -1, loopEnd = -1, factMode = 1 } = options ?? {};
  const encoded = encodeAtracFramesFromInterleavedPcm(pcmI16, options);
  let validateTrim = true;
  if (encoded.profile.codec === "atrac3plus") {
    const handle = encoded.context?.handle ?? null;
    if (
      (Number.isInteger(handle?.flushFramesRemaining) && handle.flushFramesRemaining > 0) ||
      (Number.isInteger(handle?.delayFramesRemaining) && handle.delayFramesRemaining > 0)
    ) {
      validateTrim = false;
    }
  }
  const wavBuildRequest = {
    profile: encoded.profile,
    encodedFrames: encoded.encodedFrames,
    totalSamples: encoded.totalSamples,
    loopStart,
    loopEnd,
    factMode,
    validateTrim,
  };

  return {
    ...encoded,
    buffer: buildAtracWavBuffer(wavBuildRequest),
  };
}
