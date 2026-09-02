/** ATRAC3 spectral analysis application. */

import {
  BAND_PART_FLOATS,
  FLOAT32_NEGATIVE_ZERO_BITS,
  FRAME_SAMPLES,
  GAIN_SCALE_SAMPLES,
  HALF_FRAME_SAMPLES,
  LAYER_GAIN_HISTORY_OFFSET,
  LAYER_MDCT_LAST_WORD,
  LAYER_MDCT_MIRROR_BASE,
  LAYER_MDCT_QUARTER_WORDS,
  LAYER_MDCT_ROWS,
  LAYER_MDCT_ROW_WORDS,
  LAYER_MDCT_THREE_QUARTER_WORDS,
  LAYER_TRANSFORM_HISTORY_OFFSET,
  LAYER_WINDOW_MATRIX_OFFSET,
  LAYER_WORDS,
  PAIR_BLOCK_BASE_WORD,
  PAIR_BLOCK_GAIN_LEVEL_OFFSET,
  PAIR_BLOCK_WORDS,
  SUBBAND_COUNT,
} from '../core/constants.js'
import {
  ANALYSIS_POWER_OF_TWO_SCALES,
  ANALYSIS_TWIDDLES,
  REVERSE_OUTPUT_BY_SUBBAND,
  TRANSFORM_REORDER_INDICES,
  transformTables,
} from '../core/tables.js'
import { MDCT, transformLayeredMdct } from '../signal/mdct.js'
import { float32FromBits, float32Multiply, float32ToBits } from '../utils.js'

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
 * Prepare the four-lane transform matrix from transaction-local codec state.
 *
 * @param {Uint32Array} words Mutable layered transform word image.
 * @param {Float32Array} transform Transform matrix destination.
 * @param {Float32Array} initialGainScales Initial-gain workspace.
 */
function prepareLayeredMdct(words, transform, initialGainScales) {
  for (let unit = 0; unit < SUBBAND_COUNT; unit++) {
    const gainIndex =
      words[
        PAIR_BLOCK_BASE_WORD +
          unit * PAIR_BLOCK_WORDS +
          PAIR_BLOCK_GAIN_LEVEL_OFFSET
      ]
    initialGainScales[unit] = ANALYSIS_POWER_OF_TWO_SCALES[gainIndex]
  }

  transform.fill(0)
  for (let row = 0; row < LAYER_MDCT_ROWS; row++) {
    const reorderedRow = TRANSFORM_REORDER_INDICES[row]
    const twiddleBase = reorderedRow * SUBBAND_COUNT
    const twiddle1 = ANALYSIS_TWIDDLES[twiddleBase]
    const twiddle2 = ANALYSIS_TWIDDLES[twiddleBase + 1]
    const twiddle3 = ANALYSIS_TWIDDLES[twiddleBase + 2]
    const twiddle0 = ANALYSIS_TWIDDLES[twiddleBase + 3]
    for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
      const historyIndex = lane + row * SUBBAND_COUNT
      const previousValue = float32FromBits(
        words[LAYER_TRANSFORM_HISTORY_OFFSET + historyIndex]
      )
      const weightedHistory = initialGainScales[lane] * previousValue
      const reorderedIndex = lane + reorderedRow * SUBBAND_COUNT
      const mirroredIndex =
        (LAYER_MDCT_ROWS - 1 - reorderedRow) * SUBBAND_COUNT + lane
      const reorderedValue = float32FromBits(
        words[LAYER_GAIN_HISTORY_OFFSET + reorderedIndex]
      )
      const mirroredValue = float32FromBits(
        words[LAYER_WINDOW_MATRIX_OFFSET + mirroredIndex]
      )
      const rotatedSum = (mirroredValue * twiddle1 + reorderedValue) * twiddle3
      words[LAYER_TRANSFORM_HISTORY_OFFSET + historyIndex] = float32ToBits(
        (reorderedValue * twiddle1 - mirroredValue) * twiddle2
      )
      const signedOffset = lane + (row - LAYER_MDCT_ROWS) * LAYER_MDCT_ROW_WORDS
      const side = (rotatedSum - weightedHistory) * twiddle0
      const main = rotatedSum + weightedHistory + side
      const index = LAYER_WINDOW_MATRIX_OFFSET + signedOffset
      transform[index + SUBBAND_COUNT] = side
      transform[index] = main
    }
  }
}

/**
 * Publish transformed coefficients and the next layered window history.
 *
 * @param {Uint32Array} words Mutable layered transform word image.
 * @param {Float32Array} transform Completed four-lane transform matrix.
 */
function publishLayeredMdct(words, transform) {
  for (let coefficient = 0; coefficient < FRAME_SAMPLES; coefficient++) {
    let bits = words[coefficient]
    if (bits === FLOAT32_NEGATIVE_ZERO_BITS) bits = 0
    words[LAYER_WINDOW_MATRIX_OFFSET + coefficient] = bits
  }

  for (let row = 0; row < LAYER_MDCT_ROWS; row++) {
    words[row] = float32ToBits(transform[SUBBAND_COUNT * row])
    words[HALF_FRAME_SAMPLES - 1 - row] = float32ToBits(
      transform[SUBBAND_COUNT * row + 1]
    )
    words[row + HALF_FRAME_SAMPLES] = float32ToBits(
      transform[SUBBAND_COUNT * row + 2]
    )
    words[LAYER_MDCT_LAST_WORD - row] = float32ToBits(
      transform[SUBBAND_COUNT * row + 3]
    )
    words[LAYER_MDCT_QUARTER_WORDS - 1 - row] = float32ToBits(
      transform[LAYER_MDCT_MIRROR_BASE - SUBBAND_COUNT * row]
    )
    words[row + LAYER_MDCT_QUARTER_WORDS] = float32ToBits(
      transform[LAYER_MDCT_MIRROR_BASE + 1 - SUBBAND_COUNT * row]
    )
    words[LAYER_MDCT_THREE_QUARTER_WORDS - 1 - row] = float32ToBits(
      transform[LAYER_MDCT_MIRROR_BASE + 2 - SUBBAND_COUNT * row]
    )
    words[row + LAYER_MDCT_THREE_QUARTER_WORDS] = float32ToBits(
      transform[LAYER_MDCT_MIRROR_BASE + 3 - SUBBAND_COUNT * row]
    )
  }
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
  prepareLayeredMdct(words, scratch.transformValues, scratch.initialGainScales)
  transformLayeredMdct(scratch.transformValues)
  publishLayeredMdct(words, scratch.transformValues)
  return layer.loadFrom(words)
}
