import { normalizeInputBytes } from "../common/bytes.js";
import { CodecError } from "../common/errors.js";
import { resolveAtracEncodeFactPlan } from "../common/atrac-fact.js";
import { ATRAC3_DELAY_SAMPLES } from "../atrac3/constants.js";
import { ATRAC3PLUS_DELAY_SAMPLES } from "../atrac3plus/constants.js";
import { buildRiffWaveBuffer } from "./wav-bytes.js";
import { createAtracWavChunks } from "./wav-chunks.js";
import { createAtracEncodeWavFormat } from "./wav-format.js";

function resolveAtracDecodeSkipSamples(codec, factMode, factPlan) {
  const { factParam, alignedSampleCount } = factPlan ?? {};

  switch (codec) {
    case "atrac3":
      return alignedSampleCount + ATRAC3_DELAY_SAMPLES;
    case "atrac3plus": {
      const leadInSamples = factMode === 1 ? factParam : alignedSampleCount;
      return leadInSamples + ATRAC3PLUS_DELAY_SAMPLES;
    }
    default:
      throw new CodecError(`unsupported ATRAC codec: ${codec}`);
  }
}

function validateAtracWavEncodeWindow(profile, frameCount, totalSamples, loopEnd, factMode) {
  if (!profile || typeof profile !== "object") {
    throw new CodecError("profile is required");
  }
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new CodecError(`invalid frameCount: ${frameCount}`);
  }

  const frameSamples = profile.frameSamples;
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new CodecError(`invalid frameSamples: ${frameSamples}`);
  }

  const totalDecodedSamples = frameCount * frameSamples;
  const factPlan = resolveAtracEncodeFactPlan(profile, loopEnd);
  const skipSamples = resolveAtracDecodeSkipSamples(profile.codec, factMode, factPlan);
  const availableSamples = totalDecodedSamples - Math.min(skipSamples, totalDecodedSamples);

  if (totalSamples > availableSamples) {
    throw new CodecError(
      `encoded frames are too short for totalSamples=${totalSamples} ` +
        `(decoded=${totalDecodedSamples} skip=${skipSamples} available=${availableSamples})`
    );
  }
}

/**
 * Serializes ATRAC frames into an authored RIFF/WAVE container with `fmt `,
 * `fact`, optional `smpl`, and `data` chunks in that order.
 */
export function buildAtracWavBuffer(request) {
  const {
    profile,
    encodedFrames: encodedFrameInput,
    totalSamples,
    loopStart = -1,
    loopEnd = -1,
    factMode = 1,
    validateTrim = false,
  } = request ?? {};
  if (!profile || typeof profile !== "object") {
    throw new CodecError("profile is required");
  }
  if (!Number.isInteger(totalSamples) || totalSamples < 0) {
    throw new CodecError(`invalid totalSamples: ${totalSamples}`);
  }
  if (!Number.isInteger(loopStart) || loopStart < -1) {
    throw new CodecError(`invalid loopStart: ${loopStart}`);
  }
  if (!Number.isInteger(loopEnd) || loopEnd < -1) {
    throw new CodecError(`invalid loopEnd: ${loopEnd}`);
  }
  if (loopStart >= 0 && loopEnd < loopStart) {
    throw new CodecError(`loopEnd ${loopEnd} must be >= loopStart ${loopStart}`);
  }
  if (loopStart >= 0 && loopStart >= totalSamples) {
    throw new CodecError(`loopStart ${loopStart} must be < totalSamples ${totalSamples}`);
  }
  if (loopEnd >= 0 && loopEnd >= totalSamples) {
    throw new CodecError(`loopEnd ${loopEnd} must be < totalSamples ${totalSamples}`);
  }

  const frameBytes = profile.frameBytes;
  if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
    throw new CodecError(`invalid frame size: ${frameBytes}`);
  }

  const format = createAtracEncodeWavFormat(profile);
  let dataBytes;

  if (Array.isArray(encodedFrameInput)) {
    dataBytes = new Uint8Array(encodedFrameInput.length * frameBytes);
    for (const [index, input] of encodedFrameInput.entries()) {
      const frame = normalizeInputBytes(input);
      if (frame.length !== frameBytes) {
        throw new CodecError(
          `encoded frame ${index} has ${frame.length} bytes, expected ${frameBytes}`
        );
      }
      dataBytes.set(frame, index * frameBytes);
    }
  } else {
    dataBytes = normalizeInputBytes(encodedFrameInput);
    if (dataBytes.length % frameBytes !== 0) {
      throw new CodecError(
        `encoded frame data size ${dataBytes.length} is not aligned to frame size ${frameBytes}`
      );
    }
  }

  if (validateTrim) {
    const frameCount = dataBytes.length / frameBytes;
    validateAtracWavEncodeWindow(profile, frameCount, totalSamples, loopEnd, factMode);
  }

  return buildRiffWaveBuffer(
    createAtracWavChunks({
      format,
      profile,
      dataBytes,
      totalSamples,
      loopStart,
      loopEnd,
      factMode,
    })
  );
}
