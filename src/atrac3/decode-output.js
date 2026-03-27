import { normalizeCodecFrames } from "../common/bytes.js";
import { pcmI16FromF32Sample } from "../common/pcm-i16.js";
import { resolveCodecDecodedSampleWindow } from "../common/trim.js";
import { ATRAC3_DELAY_SAMPLES } from "./constants.js";
import { decodeAtrac3Frame } from "./decode.js";
import { ATRAC3_TRANSPORT_SWAPPED_TAIL } from "./profiles.js";

const ATRAC3_FACT_LEAD_IN_WORDS = Object.freeze([1]);
const ATRAC3_NATIVE_PCM_CHANNELS = 2;

/**
 * Resolves the public decode output layout for one ATRAC3 stream request.
 *
 * ATRAC3 synthesis always rebuilds a canonical stereo lane pair internally.
 * Public decode keeps that pair when the caller explicitly asks for stereo,
 * even on stream layouts that otherwise resolve to mono. When no explicit
 * request exists, decode falls back to the stream layout.
 *
 * @param {number | null | undefined} requestedChannels
 * @param {number} streamChannels
 * @returns {1 | 2}
 */
export function resolveAtrac3DecodeOutputChannels(requestedChannels, streamChannels) {
  if (requestedChannels === 1) {
    return 1;
  }
  if (requestedChannels === ATRAC3_NATIVE_PCM_CHANNELS) {
    return ATRAC3_NATIVE_PCM_CHANNELS;
  }
  if (streamChannels === 1) {
    return 1;
  }
  return ATRAC3_NATIVE_PCM_CHANNELS;
}

/**
 * Decodes ATRAC3 transport frames to trimmed public PCM16 output.
 *
 * The decode core always returns one canonical stereo lane pair. This owner
 * normalizes container frames, accumulates that native stereo PCM, resolves
 * the codec/container trim window, and finally projects the historical mono
 * public path from the primary lane when the resolved output layout is mono.
 *
 * @param {import("./decoder.js").Atrac3DecoderState} state
 * @param {number | null | undefined} requestedChannels
 * @param {(ArrayBuffer | ArrayBufferView)[]} frames
 * @param {number | null | undefined} factSamples
 * @param {number[] | null | undefined} [factRaw=[]]
 * @returns {Int16Array}
 */
export function decodeAtrac3Frames(state, requestedChannels, frames, factSamples, factRaw = []) {
  const outputChannels = resolveAtrac3DecodeOutputChannels(requestedChannels, state.streamChannels);
  const normalizedFrames = normalizeCodecFrames(frames, state.frameBytes, "ATRAC3");
  const totalSamples = normalizedFrames.length * state.frameSamples;
  const sampleWindow = resolveCodecDecodedSampleWindow(
    totalSamples,
    factSamples,
    factRaw,
    state.frameSamples,
    ATRAC3_FACT_LEAD_IN_WORDS,
    ATRAC3_DELAY_SAMPLES
  );

  const startSample = sampleWindow.skipSamples | 0;
  const endSample = startSample + (sampleWindow.targetSamples | 0);

  if (outputChannels === ATRAC3_NATIVE_PCM_CHANNELS) {
    const pcm = new Int16Array(sampleWindow.targetSamples * ATRAC3_NATIVE_PCM_CHANNELS);
    let frameStart = 0;

    for (const frame of normalizedFrames) {
      const frameEnd = frameStart + state.frameSamples;
      const copyStart = Math.max(frameStart, startSample);
      const copyEnd = Math.min(frameEnd, endSample);

      if (copyEnd > copyStart) {
        const sourceSampleOffset = copyStart - frameStart;
        const copySamples = copyEnd - copyStart;
        const targetIndex = (copyStart - startSample) * ATRAC3_NATIVE_PCM_CHANNELS;
        decodeAtrac3Frame(state, frame, pcm, targetIndex, sourceSampleOffset, copySamples);
      } else {
        decodeAtrac3Frame(state, frame, pcm, 0, 0, 0);
      }

      frameStart = frameEnd;
    }

    return pcm;
  }

  const monoPcm = new Int16Array(sampleWindow.targetSamples);
  const decodeSecondary = state.secondaryChannel.transportMode === ATRAC3_TRANSPORT_SWAPPED_TAIL;
  let frameStart = 0;

  for (const frame of normalizedFrames) {
    decodeAtrac3Frame(state, frame, null, 0, 0, 0, decodeSecondary);
    const frameEnd = frameStart + state.frameSamples;
    const copyStart = Math.max(frameStart, startSample);
    const copyEnd = Math.min(frameEnd, endSample);

    if (copyEnd > copyStart) {
      const sourceSampleOffset = copyStart - frameStart;
      const copySamples = copyEnd - copyStart;
      const targetSampleOffset = copyStart - startSample;
      const primary = state.primaryChannel.workF32;

      for (let sampleIndex = 0; sampleIndex < copySamples; sampleIndex += 1) {
        monoPcm[targetSampleOffset + sampleIndex] = pcmI16FromF32Sample(
          primary[sourceSampleOffset + sampleIndex]
        );
      }
    }

    frameStart = frameEnd;
  }

  return monoPcm;
}
