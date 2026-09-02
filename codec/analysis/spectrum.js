/** ATRAC3 spectral analysis application. */

import {
  BAND_PART_FLOATS,
  FRAME_SAMPLES,
  GAIN_SCALE_SAMPLES,
  LAYER_WORDS,
  SUBBAND_COUNT,
} from '../core/constants.js'
import { REVERSE_OUTPUT_BY_SUBBAND, transformTables } from '../core/tables.js'
import { MDCT, transformLayeredMdct } from '../signal/mdct.js'
import { float32Multiply } from '../utils.js'

const forwardMdct = new MDCT(GAIN_SCALE_SAMPLES, 4)

/**
 * Window, transform, and order one independent ATRAC3 subband.
 *
 * @param {Float32Array} source Prepared gain-adjusted time samples.
 * @param {Float32Array} destination Caller-owned spectrum.
 * @param {boolean} reverseOutput Whether the codec reverses this subband.
 * @param {object} scratch Reusable transform storage.
 * @param {number} [destinationOffset=0] First output coefficient.
 * @returns {Float32Array} Destination containing the transformed subband.
 */
export function transformMdctSubband(
  source,
  destination,
  reverseOutput,
  scratch,
  destinationOffset = 0
) {
  if (
    !(source instanceof Float32Array) ||
    source.length < GAIN_SCALE_SAMPLES ||
    !(destination instanceof Float32Array) ||
    destinationOffset < 0 ||
    destinationOffset + BAND_PART_FLOATS > destination.length ||
    !(scratch?.windowed instanceof Float32Array) ||
    scratch.windowed.length < GAIN_SCALE_SAMPLES
  ) {
    throw new RangeError('ATRAC3 MDCT buffers have invalid geometry')
  }

  const window = transformTables().mdctWindow
  for (let sample = 0; sample < GAIN_SCALE_SAMPLES; sample++) {
    scratch.windowed[sample] = float32Multiply(source[sample], window[sample])
  }
  forwardMdct.transform(
    scratch.windowed,
    scratch,
    destination,
    destinationOffset
  )

  if (reverseOutput) {
    for (
      let coefficient = 0;
      coefficient < BAND_PART_FLOATS >> 1;
      coefficient++
    ) {
      const first = destinationOffset + coefficient
      const second = destinationOffset + BAND_PART_FLOATS - 1 - coefficient
      const value = destination[first]
      destination[first] = destination[second]
      destination[second] = value
    }
  }
  return destination
}

/**
 * Transform four already-prepared windows into one 1024-line spectrum.
 *
 * @param {Float32Array} windows Four contiguous 512-sample time windows.
 * @param {Float32Array} spectrum Destination for four 256-line spectra.
 * @param {object} scratch Reusable MDCT work buffers.
 * @returns {Float32Array} The completed `spectrum`.
 */
export function writeIndependentMdctOutputs(windows, spectrum, scratch) {
  if (
    windows?.length < SUBBAND_COUNT * GAIN_SCALE_SAMPLES ||
    spectrum?.length < SUBBAND_COUNT * BAND_PART_FLOATS
  ) {
    throw new RangeError('ATRAC3 prepared MDCT has invalid geometry')
  }
  for (let band = 0; band < SUBBAND_COUNT; band++) {
    transformMdctSubband(
      windows.subarray(
        band * GAIN_SCALE_SAMPLES,
        (band + 1) * GAIN_SCALE_SAMPLES
      ),
      spectrum,
      REVERSE_OUTPUT_BY_SUBBAND[band] !== 0,
      scratch,
      band * BAND_PART_FLOATS
    )
  }
  return spectrum
}

/**
 * Transform a gain-prepared low-rate layer and publish its detached result.
 *
 * @param {object} layer Transaction-local layer state.
 * @param {Uint32Array} words Gain-prepared layered transform image.
 * @param {object} scratch Reusable layered MDCT storage.
 * @returns {object} The transformed `layer`.
 */
export function writeLayeredMdctOutputs(layer, words, scratch) {
  if (
    !layer ||
    words?.length < LAYER_WORDS ||
    scratch?.transformValues?.length < FRAME_SAMPLES ||
    scratch.initialGainScales?.length < SUBBAND_COUNT
  ) {
    throw new RangeError('ATRAC3 layered MDCT has invalid state geometry')
  }
  transformLayeredMdct(
    words,
    scratch.transformValues,
    scratch.initialGainScales
  )
  return layer.loadFrom(words)
}
