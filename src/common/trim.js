/**
 * One resolved sample window applied to decoded PCM.
 *
 * @typedef {object} DecodedSampleWindow
 * @property {number} skipSamples
 * @property {number} targetSamples
 */
import { CodecError } from "./errors.js";

/**
 * Resolves the shared decoded sample window once the caller already knows the
 * authored skipped-sample count.
 *
 * @param {number} totalSamples
 * @param {number | null | undefined} factSamples
 * @param {number} skipSamples
 * @returns {DecodedSampleWindow}
 */
export function resolveDecodedSampleWindow(totalSamples, factSamples, skipSamples) {
  const clampedSkipSamples = Math.min(skipSamples, totalSamples);
  const availableSamples = totalSamples - clampedSkipSamples;
  if (availableSamples > 0 && Number.isInteger(factSamples) && factSamples > availableSamples) {
    throw new CodecError(
      `factSamples ${factSamples} exceeds available decoded samples ${availableSamples}`
    );
  }
  const targetSamples =
    Number.isInteger(factSamples) && factSamples > 0
      ? Math.min(factSamples, availableSamples)
      : availableSamples;

  return {
    skipSamples: clampedSkipSamples,
    targetSamples,
  };
}

/**
 * Resolves the codec lead-in sample count from a decoded WAV `fact` payload.
 *
 * Different ATRAC containers store that lead-in value in different words, so
 * callers provide the codec-specific precedence order explicitly.
 *
 * @param {number[] | null | undefined} factRaw
 * @param {number} fallbackLeadInSamples
 * @param {number[]} leadInWordIndexes
 * @returns {number}
 */
export function resolveFactLeadInSamples(factRaw, fallbackLeadInSamples, leadInWordIndexes) {
  if (Array.isArray(factRaw)) {
    for (const wordIndex of leadInWordIndexes) {
      const leadInSamples = factRaw[wordIndex] ?? null;
      if (Number.isInteger(leadInSamples) && leadInSamples >= 0) {
        return leadInSamples;
      }
    }
  }

  return fallbackLeadInSamples;
}

/**
 * Resolves the trimmed decode window once a codec provides its authored `fact`
 * precedence order and fixed decoder delay.
 *
 * The precedence order and delay remain codec-owned policy. This helper only
 * composes those inputs with the shared trim-window math.
 *
 * @param {number} totalSamples
 * @param {number | null | undefined} factSamples
 * @param {number[] | null | undefined} factRaw
 * @param {number} fallbackLeadInSamples
 * @param {number[]} leadInWordIndexes
 * @param {number} decoderDelaySamples
 * @returns {DecodedSampleWindow}
 */
export function resolveCodecDecodedSampleWindow(
  totalSamples,
  factSamples,
  factRaw,
  fallbackLeadInSamples,
  leadInWordIndexes,
  decoderDelaySamples
) {
  const leadInSamples = resolveFactLeadInSamples(factRaw, fallbackLeadInSamples, leadInWordIndexes);

  return resolveDecodedSampleWindow(totalSamples, factSamples, leadInSamples + decoderDelaySamples);
}

/**
 * Trims interleaved decoded PCM using codec/container sample-count metadata.
 *
 * @param {Int16Array} decodedPcm
 * @param {number} channels
 * @param {DecodedSampleWindow} sampleWindow
 * @returns {Int16Array}
 */
export function trimInterleavedPcm(decodedPcm, channels, sampleWindow) {
  const start = sampleWindow.skipSamples * channels;

  return decodedPcm.slice(start, start + sampleWindow.targetSamples * channels);
}
