import { CodecError } from "./errors.js";
import {
  assertPlanarF32Scratch,
  assertPositiveInteger,
  createPlanarF32Frame,
} from "./pcm-planar-frame.js";
export {
  assertPlanarF32Scratch,
  createPlanarF32Frame,
  ensurePlanarF32Frame,
} from "./pcm-planar-frame.js";

/**
 * Public options for copying one interleaved PCM window into planar scratch.
 *
 * `packedSampleCount` counts interleaved Int16 words. The source and target
 * offsets stay in per-channel samples.
 *
 * @typedef {object} InterleavedPcmCopyOptions
 * @property {number} [outputChannels]
 * @property {number} [packedSampleCount]
 * @property {number} [totalSamples]
 * @property {number} [sourceSampleOffset]
 * @property {number} [targetSampleOffset]
 */

export function assertInterleavedPcmInput(pcmI16, channels) {
  if (!(pcmI16 instanceof Int16Array)) {
    throw new CodecError("pcmI16 must be an Int16Array");
  }
  assertPositiveInteger(channels, "channel count");
  if (pcmI16.length % channels !== 0) {
    throw new CodecError(
      `PCM sample length ${pcmI16.length} is not divisible by channel count ${channels}`
    );
  }
}

/**
 * Deinterleaves one packed Int16 PCM window into planar Float32 scratch and
 * zero-fills the unused head, tail, and any extra output channels.
 *
 * `packedSampleCount` names the count in interleaved Int16 words. The older
 * `totalSamples` option remains as a compatibility alias for the same value.
 * `sourceSampleOffset` and `targetSampleOffset` stay in per-channel samples.
 *
 * @param {Int16Array} srcPcm
 * @param {number} inputChannels
 * @param {number} frameSamples
 * @param {object} [options={}]
 * @param {Float32Array[] | null} [options.scratch]
 * @param {number} [options.outputChannels]
 * @param {number} [options.packedSampleCount]
 * @param {number} [options.totalSamples]
 * @param {number} [options.sourceSampleOffset]
 * @param {number} [options.targetSampleOffset]
 */
export function copyInterleavedPcmToPlanarF32(
  srcPcm,
  inputChannels,
  frameSamples,
  {
    scratch = null,
    outputChannels = inputChannels,
    packedSampleCount = undefined,
    totalSamples = undefined,
    sourceSampleOffset = 0,
    targetSampleOffset = 0,
  } = {}
) {
  assertPositiveInteger(outputChannels, "output channel count");
  if (outputChannels < inputChannels) {
    throw new CodecError(
      `output channel count ${outputChannels} cannot be smaller than input channel count ${inputChannels}`
    );
  }
  if (!(srcPcm instanceof Int16Array)) {
    throw new CodecError("srcPcm must be an Int16Array");
  }
  assertPositiveInteger(inputChannels, "channel count");
  assertPositiveInteger(frameSamples, "frameSamples");
  if (!Number.isInteger(sourceSampleOffset) || sourceSampleOffset < 0) {
    throw new CodecError(`invalid sourceSampleOffset: ${sourceSampleOffset}`);
  }
  if (
    !Number.isInteger(targetSampleOffset) ||
    targetSampleOffset < 0 ||
    targetSampleOffset > frameSamples
  ) {
    throw new CodecError(`invalid targetSampleOffset: ${targetSampleOffset}`);
  }

  const sourceStartWord = sourceSampleOffset * inputChannels;
  if (sourceStartWord > srcPcm.length) {
    throw new CodecError(`invalid sourceSampleOffset: ${sourceSampleOffset}`);
  }
  const availablePackedWords = srcPcm.length - sourceStartWord;

  if (
    packedSampleCount !== undefined &&
    totalSamples !== undefined &&
    packedSampleCount !== totalSamples
  ) {
    throw new CodecError(
      `packedSampleCount ${packedSampleCount} does not match legacy totalSamples ${totalSamples}`
    );
  }

  const requestedPackedWords =
    packedSampleCount !== undefined
      ? packedSampleCount
      : totalSamples !== undefined
        ? totalSamples
        : availablePackedWords;
  if (
    !Number.isInteger(requestedPackedWords) ||
    requestedPackedWords < 0 ||
    requestedPackedWords > availablePackedWords
  ) {
    throw new CodecError(`invalid packedSampleCount: ${requestedPackedWords}`);
  }
  if (requestedPackedWords % inputChannels !== 0) {
    throw new CodecError(
      `PCM sample length ${requestedPackedWords} is not divisible by channel count ${inputChannels}`
    );
  }

  const sourceSampleCount = requestedPackedWords / inputChannels;
  if (targetSampleOffset + sourceSampleCount > frameSamples) {
    throw new CodecError(
      `PCM frame count ${sourceSampleCount} exceeds frame length ${frameSamples}`
    );
  }

  const out = scratch
    ? assertPlanarF32Scratch(scratch, outputChannels, frameSamples)
    : createPlanarF32Frame(outputChannels, frameSamples);

  if (scratch) {
    const tailStart = targetSampleOffset + sourceSampleCount;
    for (let channelIndex = 0; channelIndex < out.length; channelIndex += 1) {
      const channel = out[channelIndex];
      if (channelIndex >= inputChannels) {
        channel.fill(0, 0, frameSamples);
        continue;
      }

      if (targetSampleOffset > 0) {
        channel.fill(0, 0, targetSampleOffset);
      }
      if (tailStart < frameSamples) {
        channel.fill(0, tailStart, frameSamples);
      }
    }
  }

  for (let sampleIndex = 0; sampleIndex < sourceSampleCount; sampleIndex += 1) {
    const sourceIndex = sourceStartWord + sampleIndex * inputChannels;
    const targetIndex = targetSampleOffset + sampleIndex;
    for (let channelIndex = 0; channelIndex < inputChannels; channelIndex += 1) {
      out[channelIndex][targetIndex] = srcPcm[sourceIndex + channelIndex];
    }
  }

  return out;
}

export function interleavedFrameToPlanar(pcmI16, channels) {
  assertInterleavedPcmInput(pcmI16, channels);
  const samplesPerChannel = pcmI16.length / channels;
  const out = Array.from({ length: channels }, () => new Int16Array(samplesPerChannel));

  for (let sampleIndex = 0; sampleIndex < samplesPerChannel; sampleIndex += 1) {
    const sourceOffset = sampleIndex * channels;
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      out[channelIndex][sampleIndex] = pcmI16[sourceOffset + channelIndex];
    }
  }

  return out;
}
