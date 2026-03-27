import { CodecError } from "../common/errors.js";
import { assertPositiveInteger } from "../common/pcm-planar-frame.js";
import { decodeAtrac3plusCodecConfig } from "./encode-handle.js";
import { createAtxDecodeHandle } from "./handle.js";
import { ATRAC3PLUS_DELAY_SAMPLES, ATRAC3PLUS_FRAME_SAMPLES } from "./constants.js";
import { blockChannelsForMode } from "./topology.js";
import { ATX_MODE_CHANNEL_COUNT } from "./tables/core.js";

export const ATRAC3PLUS_DEFAULT_FRAME_SAMPLES = ATRAC3PLUS_FRAME_SAMPLES;
export { ATRAC3PLUS_DELAY_SAMPLES };

/**
 * Parses the 2-byte ATRAC3plus codec-info payload embedded in ATRACX WAV
 * headers into the fields the decoder actually needs. Short or missing
 * payloads preserve the current null-filled fallback while keeping the WAV
 * container frame size as `derivedFrameBytes`.
 */
export function parseAtrac3PlusCodecBytes(codecBytes, frameBytes) {
  if (!codecBytes || codecBytes.length < 2) {
    return {
      sampleRateCode: null,
      sampleRate: null,
      mode: null,
      derivedFrameBytes: frameBytes,
    };
  }

  const codec = decodeAtrac3plusCodecConfig(codecBytes);

  return {
    sampleRateCode: codec.sampleRateCode,
    sampleRate: codec.sampleRate,
    mode: codec.mode,
    derivedFrameBytes: codec.frameBytes,
  };
}

function assertFrameByteMatch(codec, frameBytes) {
  if (
    Number.isInteger(codec.derivedFrameBytes) &&
    codec.derivedFrameBytes > 0 &&
    codec.derivedFrameBytes !== frameBytes
  ) {
    throw new CodecError(
      `ATRAC3plus frame byte mismatch: fmt=${frameBytes} codec=${codec.derivedFrameBytes}`
    );
  }
}

function resolveAtrac3PlusCodecConfig(atracxCodecBytes, frameBytes, fallbackSampleRate) {
  const codec = parseAtrac3PlusCodecBytes(atracxCodecBytes, frameBytes);
  assertFrameByteMatch(codec, frameBytes);
  const mode = codec.mode === null ? 0 : codec.mode;
  if (mode < 1 || mode > 7) {
    if (codec.mode === null) {
      return {
        sampleRateCode: codec.sampleRateCode,
        sampleRate: codec.sampleRate ?? fallbackSampleRate ?? null,
        mode: 0,
      };
    }
    throw new CodecError(`unsupported ATRAC3plus mode: ${codec.mode}`);
  }

  return {
    sampleRateCode: codec.sampleRateCode,
    sampleRate: codec.sampleRate ?? fallbackSampleRate ?? null,
    mode,
  };
}

/**
 * Builds the mutable runtime state used by the ATRAC3plus frame decoder.
 *
 * @param {object} config Container-derived ATRAC3plus stream metadata.
 * @returns {object}
 */
export function createAtrac3PlusDecoderState(config) {
  if (!config || typeof config !== "object") {
    throw new CodecError("config must be an object");
  }

  const {
    channels,
    frameBytes,
    frameSamples,
    atracxCodecBytes,
    sampleRate: fallbackSampleRate,
  } = config;

  assertPositiveInteger(channels, "ATRAC3plus channel count");
  assertPositiveInteger(frameBytes, "ATRAC3plus frame byte count");

  const { sampleRateCode, sampleRate, mode } = resolveAtrac3PlusCodecConfig(
    atracxCodecBytes,
    frameBytes,
    fallbackSampleRate
  );
  const blockChannels = blockChannelsForMode(mode);
  const blockCount = blockChannels.length;
  const resolvedFrameSamples =
    mode === 0
      ? Number.isInteger(frameSamples) && frameSamples > 0
        ? frameSamples
        : ATRAC3PLUS_DEFAULT_FRAME_SAMPLES
      : ATRAC3PLUS_DEFAULT_FRAME_SAMPLES;

  return {
    outputChannels: channels,
    streamChannels: mode === 0 ? channels : ATX_MODE_CHANNEL_COUNT[mode],
    mode,
    blockCount,
    blockChannels,
    sampleRateCode,
    sampleRate,
    frameBytes,
    frameSamples: resolvedFrameSamples,
    handle:
      blockCount === 0 || !sampleRate
        ? null
        : createAtxDecodeHandle({
            sampleRate,
            mode,
            frameBytes,
            outputChannels: channels,
          }),
  };
}
