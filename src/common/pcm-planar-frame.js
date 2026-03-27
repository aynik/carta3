import { CodecError } from "./errors.js";

export function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CodecError(`invalid ${name}: ${value}`);
  }
}

export function createPlanarF32Frame(channelCount, frameSamples) {
  assertPositiveInteger(channelCount, "channel count");
  assertPositiveInteger(frameSamples, "frameSamples");
  return Array.from({ length: channelCount }, () => new Float32Array(frameSamples));
}

function canReusePlanarF32Frame(scratch, channelCount, frameSamples) {
  if (!Array.isArray(scratch) || scratch.length < channelCount) {
    return false;
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    if (
      !(scratch[channelIndex] instanceof Float32Array) ||
      scratch[channelIndex].length < frameSamples
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Reuses caller-owned planar Float32 scratch when it already exposes enough
 * channel lanes of the requested size; otherwise returns a replacement frame
 * with the requested shape.
 */
export function ensurePlanarF32Frame(scratch, channelCount, frameSamples) {
  return canReusePlanarF32Frame(scratch, channelCount, frameSamples)
    ? scratch
    : createPlanarF32Frame(channelCount, frameSamples);
}

/**
 * Validates reusable planar Float32 scratch buffers used by shared and codec-
 * specific PCM staging paths.
 */
export function assertPlanarF32Scratch(
  scratch,
  channelCount,
  frameSamples,
  arrayName = "scratch",
  channelName = "output channel"
) {
  if (!Array.isArray(scratch) || scratch.length < channelCount) {
    throw new CodecError(`${arrayName} must provide one Float32Array per ${channelName}`);
  }
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    if (
      !(scratch[channelIndex] instanceof Float32Array) ||
      scratch[channelIndex].length < frameSamples
    ) {
      throw new CodecError(
        `${arrayName}[${channelIndex}] must be a Float32Array of length >= ${frameSamples}`
      );
    }
  }

  return scratch;
}
