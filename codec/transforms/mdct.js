/** Carta3 Audio Codec - Forward and inverse block transforms. */

import {
  BAND_PART_FLOATS,
  DECODER_MAX_UNITS,
  DECODER_SPECTRAL_LINES_PER_UNIT,
  DECODER_SPECTRUM_FLOATS_PER_UNIT,
  FLOAT32_NEGATIVE_ZERO_BITS,
  FRAME_SAMPLES,
  GAIN_SCALE_SAMPLES,
  HALF_FRAME_SAMPLES,
  INVERSE_SQUARE_ROOT_TWO_BITS,
  LAYER_GAIN_HISTORY_OFFSET,
  LAYER_TRANSFORM_HISTORY_OFFSET,
  LAYER_WINDOW_MATRIX_OFFSET,
  LAYER_WORDS,
  MDCT_NORMALIZATION_SCALE,
  PAIR_BLOCK_BASE_WORD,
  PAIR_BLOCK_GAIN_LEVEL_OFFSET,
  PAIR_BLOCK_WORDS,
  RESIDUAL_DELAY_SAMPLES,
  SUBBAND_COUNT,
} from '../core/constants.js'
import {
  ANALYSIS_POWER_OF_TWO_SCALES,
  ANALYSIS_ROTATION_SCALES,
  ANALYSIS_TWIDDLES,
  INVERSE_TRANSFORM_COEFFICIENTS,
  INVERSE_TRANSFORM_SCALES,
  INVERSE_TRANSFORM_TWIDDLES,
  MDCT_BIT_REVERSE_PAIRS,
  REVERSE_OUTPUT_BY_SUBBAND,
  SPECTRUM_RECONSTRUCTION_SCALE,
  TRANSFORM_REORDER_INDICES,
  transformTables,
} from '../core/tables.js'
import { MdctScratch } from '../state/encoder.js'
import {
  float32Add,
  float32FromBits,
  float32Multiply,
  float32Subtract,
  float32ToBits,
} from '../utils.js'

// Preserve the readable table shape without pair iteration in the hot loop.
const bitReverseIndices = Uint8Array.from(MDCT_BIT_REVERSE_PAIRS.flat())

/**
 * Transform a 512-sample current/previous window into 256 ATRAC3 coefficients.
 * Every f32 operation is explicitly rounded to preserve reference evaluation order.
 *
 * @param {Float32Array} source Prepared 512-sample gain-adjusted window.
 * @param {Float32Array} destination Destination 256-line spectrum.
 * @param {boolean} reverseOutput Whether to publish coefficients in reverse order.
 * @param {MdctScratch} scratch Reusable forward-transform storage.
 * @returns {Float32Array} `destination` after the transform.
 */
export function forwardMdct256(
  source,
  destination,
  reverseOutput,
  scratch = new MdctScratch()
) {
  if (source.length < 512 || destination.length < 256) {
    throw new RangeError('ATRAC3 MDCT requires 512 input and 256 output values')
  }
  if (
    !scratch ||
    scratch.preWindowed?.length < 256 ||
    scratch.real?.length < 128 ||
    scratch.imaginary?.length < 128
  ) {
    throw new RangeError('ATRAC3 MDCT scratch has invalid geometry')
  }

  const tables = transformTables()
  const window = tables.mdctWindow
  const preWindowed = scratch.preWindowed
  const real = scratch.real
  const imaginary = scratch.imaginary

  for (let sampleIndex = 0; sampleIndex < 64; sampleIndex++) {
    const forwardIndex = 384 + sampleIndex * 2
    const reverseIndex = 383 - sampleIndex * 2
    preWindowed[sampleIndex] = float32Subtract(
      -float32Multiply(source[forwardIndex], window[forwardIndex]),
      float32Multiply(window[reverseIndex], source[reverseIndex])
    )
  }
  for (let sampleIndex = 0; sampleIndex < 128; sampleIndex++) {
    const forwardIndex = sampleIndex * 2
    const reverseIndex = 255 - sampleIndex * 2
    preWindowed[64 + sampleIndex] = float32Subtract(
      float32Multiply(window[forwardIndex], source[forwardIndex]),
      float32Multiply(window[reverseIndex], source[reverseIndex])
    )
  }
  for (let sampleIndex = 0; sampleIndex < 64; sampleIndex++) {
    const forwardIndex = 256 + sampleIndex * 2
    const reverseIndex = 511 - sampleIndex * 2
    preWindowed[192 + sampleIndex] = float32Add(
      float32Multiply(window[forwardIndex], source[forwardIndex]),
      float32Multiply(window[reverseIndex], source[reverseIndex])
    )
  }

  for (let coefficient = 0; coefficient < 128; coefficient++) {
    const evenSample = preWindowed[coefficient * 2]
    const oddSample = preWindowed[coefficient * 2 + 1]
    const cosine = tables.mdctPreRotationCosines[coefficient]
    const sine = tables.mdctPreRotationSines[coefficient]
    real[coefficient] = float32Subtract(
      float32Multiply(evenSample, cosine),
      float32Multiply(oddSample, sine)
    )
    imaginary[coefficient] = float32Add(
      float32Multiply(evenSample, sine),
      float32Multiply(oddSample, cosine)
    )
  }

  for (let pair = 0; pair < bitReverseIndices.length; pair += 2) {
    const sourceIndex = bitReverseIndices[pair]
    const destinationIndex = bitReverseIndices[pair + 1]
    const realValue = real[sourceIndex]
    real[sourceIndex] = real[destinationIndex]
    real[destinationIndex] = realValue
    const imaginaryValue = imaginary[sourceIndex]
    imaginary[sourceIndex] = imaginary[destinationIndex]
    imaginary[destinationIndex] = imaginaryValue
  }

  let step = 64
  let butterflyLength = 2
  for (let stage = 0; stage <= 6; stage++) {
    const half = butterflyLength >> 1
    let base = 0
    let secondLaneBase = half
    let groups = step
    while (groups !== 0) {
      let twiddleIndex = 0
      let butterflyCount = half
      let firstLane = base
      let secondLane = secondLaneBase
      while (butterflyCount !== 0) {
        const twiddleCosine = tables.mdctTwiddleCosines[twiddleIndex]
        const twiddleSine = tables.mdctTwiddleSines[twiddleIndex]
        const firstReal = real[firstLane]
        const firstImaginary = imaginary[firstLane]
        const secondReal = real[secondLane]
        const secondImaginary = imaginary[secondLane]
        const rotatedReal = float32Subtract(
          float32Multiply(secondReal, twiddleCosine),
          float32Multiply(secondImaginary, twiddleSine)
        )
        const rotatedImaginary = float32Add(
          float32Multiply(secondImaginary, twiddleCosine),
          float32Multiply(secondReal, twiddleSine)
        )
        real[secondLane] = float32Subtract(firstReal, rotatedReal)
        imaginary[secondLane] = float32Subtract(
          firstImaginary,
          rotatedImaginary
        )
        real[firstLane] = float32Add(firstReal, rotatedReal)
        imaginary[firstLane] = float32Add(firstImaginary, rotatedImaginary)
        twiddleIndex += step
        firstLane++
        secondLane++
        butterflyCount--
      }
      base += butterflyLength
      secondLaneBase += butterflyLength
      groups--
    }
    step >>= 1
    butterflyLength <<= 1
  }

  for (let coefficient = 0; coefficient < 128; coefficient++) {
    const reverseIndex = 127 - coefficient
    const forwardReal = real[coefficient]
    const reverseReal = real[reverseIndex]
    const forwardImaginary = imaginary[coefficient]
    const reverseImaginary = imaginary[reverseIndex]
    const minus = tables.mdctBaseCosineMinusFifthSine[coefficient]
    const plus = tables.mdctBaseCosinePlusFifthSine[coefficient]
    const fifthPlus = tables.mdctFifthCosinePlusBaseSine[coefficient]
    const fifthMinus = tables.mdctFifthCosineMinusBaseSine[coefficient]

    preWindowed[coefficient] = float32Add(
      float32Add(
        float32Add(
          float32Multiply(forwardReal, minus),
          float32Multiply(reverseReal, plus)
        ),
        float32Multiply(forwardImaginary, fifthPlus)
      ),
      float32Multiply(reverseImaginary, fifthMinus)
    )
    preWindowed[255 - coefficient] = float32Add(
      float32Subtract(
        float32Subtract(
          float32Multiply(forwardReal, fifthPlus),
          float32Multiply(reverseReal, fifthMinus)
        ),
        float32Multiply(forwardImaginary, minus)
      ),
      float32Multiply(reverseImaginary, plus)
    )
  }

  if (reverseOutput) {
    for (let coefficient = 0; coefficient < 256; coefficient++) {
      destination[coefficient] = float32Multiply(
        MDCT_NORMALIZATION_SCALE,
        preWindowed[255 - coefficient]
      )
    }
  } else {
    for (let coefficient = 0; coefficient < 256; coefficient++) {
      destination[coefficient] = float32Multiply(
        MDCT_NORMALIZATION_SCALE,
        preWindowed[coefficient]
      )
    }
  }
  return destination
}

/**
 * Transform four already-prepared windows into one 1024-line spectrum.
 *
 * Window construction, gain application, and overlap publication deliberately
 * happen before this function; this operation owns only the MDCT.
 *
 * @param {Float32Array} windows Four contiguous 512-sample time windows.
 * @param {Float32Array} spectrum Destination for four 256-line spectra.
 * @param {object} scratch Reusable MDCT work buffers.
 * @returns {Float32Array} `spectrum`.
 */
export function transformPreparedSubbands(windows, spectrum, scratch) {
  if (
    windows?.length < SUBBAND_COUNT * GAIN_SCALE_SAMPLES ||
    spectrum?.length < SUBBAND_COUNT * BAND_PART_FLOATS
  ) {
    throw new RangeError('ATRAC3 prepared MDCT has invalid geometry')
  }
  for (let band = 0; band < SUBBAND_COUNT; band++) {
    forwardMdct256(
      windows.subarray(
        band * GAIN_SCALE_SAMPLES,
        (band + 1) * GAIN_SCALE_SAMPLES
      ),
      spectrum.subarray(band * BAND_PART_FLOATS, (band + 1) * BAND_PART_FLOATS),
      REVERSE_OUTPUT_BY_SUBBAND[band] !== 0,
      scratch
    )
  }
  return spectrum
}

/**
 * Bit-exact forward MDCT for the 66/105 kbps layered transform.
 *
 * This kernel shares the MDCT responsibility with `forwardMdct256`, but
 * preserves the low-rate port's interleaved word-image arithmetic.
 */
const inverseSquareRootTwo = float32FromBits(INVERSE_SQUARE_ROOT_TWO_BITS)
const LAYER_MDCT_ROWS = HALF_FRAME_SAMPLES / SUBBAND_COUNT
const LAYER_MDCT_ROW_WORDS = SUBBAND_COUNT * 2
const LAYER_MDCT_QUARTER_WORDS = FRAME_SAMPLES / 4
const LAYER_MDCT_THREE_QUARTER_WORDS = LAYER_MDCT_QUARTER_WORDS * 3
const LAYER_MDCT_LAST_WORD = FRAME_SAMPLES - 1
const LAYER_MDCT_MIRROR_BASE = FRAME_SAMPLES - SUBBAND_COUNT

/**
 * Run the interleaved forward kernel over gain-prepared matrix rows.
 *
 * @param {Uint32Array} words
 * @param {object} transform
 * @param {Float32Array} initialGainScales
 */
function transformLayeredRows(words, transform, initialGainScales) {
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

  for (let coefficient = 0; coefficient < FRAME_SAMPLES; coefficient++) {
    let bits = words[coefficient]
    if (bits === FLOAT32_NEGATIVE_ZERO_BITS) bits = 0
    words[LAYER_WINDOW_MATRIX_OFFSET + coefficient] = bits
  }

  let blockBase = 0
  for (let index = -LAYER_MDCT_ROWS; index < 0; index += 2) {
    const scale = ANALYSIS_ROTATION_SCALES[index + LAYER_MDCT_ROWS + 1]
    let laneOffset = blockBase
    for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
      const fourth = transform[laneOffset + 12]
      const secondDifference = float32Multiply(
        float32Subtract(transform[laneOffset + 4], fourth),
        scale
      )
      const firstDifference = float32Multiply(
        float32Subtract(transform[laneOffset], transform[laneOffset + 8]),
        scale
      )
      transform[laneOffset + 12] = secondDifference
      transform[laneOffset] = float32Add(
        float32Add(transform[laneOffset], transform[laneOffset + 8]),
        secondDifference
      )
      transform[laneOffset + 8] = firstDifference
      transform[laneOffset + 4] = float32Add(
        float32Add(transform[laneOffset + 4], fourth),
        firstDifference
      )
      laneOffset++
    }
    blockBase += 16
  }

  for (let span = SUBBAND_COUNT; span !== LAYER_MDCT_ROWS; span *= 2) {
    let phase = (span >> 1) - LAYER_MDCT_ROWS
    let base = 0
    while (phase < 1) {
      const scale = ANALYSIS_ROTATION_SCALES[LAYER_MDCT_ROWS + phase]
      const limit = base + span * SUBBAND_COUNT
      while (base !== limit) {
        let upperSecond = base + span * SUBBAND_COUNT + SUBBAND_COUNT
        let lower = base
        for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
          const upperFirst = base + span * SUBBAND_COUNT + lane
          const firstValue = transform[upperFirst]
          const secondValue = transform[upperSecond]
          transform[upperFirst] = float32Multiply(
            float32Subtract(transform[lower], firstValue),
            scale
          )
          transform[upperSecond] = float32Multiply(
            float32Subtract(transform[lower + SUBBAND_COUNT], secondValue),
            scale
          )
          transform[lower] = float32Add(transform[lower], firstValue)
          transform[lower + SUBBAND_COUNT] = float32Add(
            transform[lower + SUBBAND_COUNT],
            secondValue
          )
          upperSecond++
          lower++
        }
        base += LAYER_MDCT_ROW_WORDS
      }
      let wing = span * 2 - 1
      base -= span * SUBBAND_COUNT
      while (wing > 0) {
        const wingOffset = wing * SUBBAND_COUNT
        for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
          transform[base + lane] = float32Add(
            transform[base + lane],
            transform[base + wingOffset + lane]
          )
          transform[base + lane + 4] = float32Add(
            transform[base + lane + 4],
            transform[base + wingOffset + lane - 4]
          )
          transform[base + lane + 8] = float32Add(
            transform[base + lane + 8],
            transform[base + wingOffset + lane - 8]
          )
          transform[base + lane + 12] = float32Add(
            transform[base + lane + 12],
            transform[base + wingOffset + lane - 12]
          )
        }
        base += LAYER_MDCT_ROW_WORDS * 2
        wing -= LAYER_MDCT_ROW_WORDS
      }
      base += span * SUBBAND_COUNT
      phase += span
    }
  }

  for (let row = 0; row < LAYER_MDCT_ROWS; row++) {
    for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
      const lower =
        HALF_FRAME_SAMPLES + lane + (row - LAYER_MDCT_ROWS) * SUBBAND_COUNT
      const value = transform[lower]
      transform[lower] = float32Add(
        value,
        transform[lower + HALF_FRAME_SAMPLES]
      )
      transform[lower + HALF_FRAME_SAMPLES] = float32Multiply(
        float32Subtract(value, transform[lower + HALF_FRAME_SAMPLES]),
        inverseSquareRootTwo
      )
    }
  }

  for (let row = 0; row < LAYER_MDCT_ROWS; row++) {
    for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
      transform[SUBBAND_COUNT * row + lane] = float32Add(
        transform[SUBBAND_COUNT * row + lane],
        transform[LAYER_MDCT_MIRROR_BASE - SUBBAND_COUNT * row + lane]
      )
    }
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
 * Transform a gain-prepared low-rate layer and commit its persistent history.
 *
 * @param {object} layer Transaction-local layer state.
 * @param {object} transformState State prepared by layered gain analysis.
 * @returns {object} The transformed `layer`.
 */
export function runLayeredMdct(layer, transformState) {
  if (
    !layer ||
    transformState?.words?.length < LAYER_WORDS ||
    transformState.transformValues?.length < FRAME_SAMPLES ||
    transformState.initialGainScales?.length < SUBBAND_COUNT
  ) {
    throw new RangeError('ATRAC3 layered MDCT has invalid state geometry')
  }
  transformLayeredRows(
    transformState.words,
    transformState.transformValues,
    transformState.initialGainScales
  )
  return layer.loadFrom(transformState.words)
}

/**
 * Bit-exact inverse MDCT and overlap reconstruction used by decoding.
 *
 * Gain-envelope application is deliberately owned by `gain-scale.js`.
 */
/**
 * Read one field from the interleaved inverse-transform coefficient table.
 *
 * @param {number} index
 * @param {string} field
 * @returns {number}
 */
function coefficient(index, field) {
  return INVERSE_TRANSFORM_COEFFICIENTS[index * SUBBAND_COUNT + field]
}

/**
 * Inverse-transform one spectral unit and update its overlap history.
 *
 * @param {Float32Array} spectrum Mutable reconstructed spectrum.
 * @param {number} blockIndex Interleaved subband index.
 * @param {number} gainIndex Initial transform scale selector.
 * @param {object} synthesis Transaction-staged decoder channel state.
 * @returns {void}
 */
export function applyInverseBlockTransform(
  spectrum,
  blockIndex,
  gainIndex,
  synthesis
) {
  if (
    spectrum.length !== DECODER_SPECTRAL_LINES_PER_UNIT ||
    blockIndex < 0 ||
    blockIndex >= DECODER_MAX_UNITS
  ) {
    throw new RangeError('Invalid ATRAC3 inverse block geometry')
  }

  if ((blockIndex & 1) === 0) {
    for (let lower = 0; lower < DECODER_SPECTRUM_FLOATS_PER_UNIT; lower++) {
      spectrum[lower] = float32Subtract(
        spectrum[lower],
        spectrum[DECODER_SPECTRAL_LINES_PER_UNIT - 1 - lower]
      )
    }
  } else {
    for (let lower = 0; lower < DECODER_SPECTRUM_FLOATS_PER_UNIT; lower++) {
      const mirror = DECODER_SPECTRAL_LINES_PER_UNIT - 1 - lower
      const lowerValue = spectrum[lower]
      spectrum[lower] = float32Subtract(spectrum[mirror], lowerValue)
      spectrum[mirror] = lowerValue
    }
  }

  for (let lower = 0; lower < DECODER_SPECTRUM_FLOATS_PER_UNIT; lower++) {
    const upperIndex = lower + DECODER_SPECTRUM_FLOATS_PER_UNIT
    const lowerValue = spectrum[lower]
    const upper = spectrum[upperIndex]
    spectrum[upperIndex] = float32Subtract(
      lowerValue,
      float32Multiply(upper, SPECTRUM_RECONSTRUCTION_SCALE)
    )
    spectrum[lower] = float32Add(
      lowerValue,
      float32Multiply(upper, SPECTRUM_RECONSTRUCTION_SCALE)
    )
  }

  let step = DECODER_SPECTRUM_FLOATS_PER_UNIT / 2
  let spectrumOffset = 0
  for (;;) {
    const half = step >> 1
    let twiddlePosition = DECODER_SPECTRUM_FLOATS_PER_UNIT - 1 - half
    for (;;) {
      const span = step * 2
      let end = spectrumOffset
      let remaining = span
      for (;;) {
        spectrum[end] = float32Subtract(
          spectrum[end],
          spectrum[end + remaining - 1]
        )
        spectrum[end + 1] = float32Subtract(
          spectrum[end + 1],
          spectrum[end + remaining - 2]
        )
        spectrum[end + 2] = float32Subtract(
          spectrum[end + 2],
          spectrum[end + remaining - 3]
        )
        spectrum[end + 3] = float32Subtract(
          spectrum[end + 3],
          spectrum[end + remaining - 4]
        )
        end += 4
        remaining -= 8
        if (remaining <= 0) break
      }
      const endOffset = end
      const twiddle = INVERSE_TRANSFORM_TWIDDLES[twiddlePosition]
      for (;;) {
        const first = spectrumOffset
        const second = spectrumOffset + step
        const firstRotated = float32Multiply(twiddle, spectrum[second])
        const secondRotated = float32Multiply(twiddle, spectrum[second + 1])
        spectrum[second] = float32Subtract(spectrum[first], firstRotated)
        spectrum[second + 1] = float32Subtract(
          spectrum[first + 1],
          secondRotated
        )
        spectrum[first] = float32Add(spectrum[first], firstRotated)
        spectrum[first + 1] = float32Add(spectrum[first + 1], secondRotated)
        spectrumOffset += 2
        if (spectrumOffset === endOffset) break
      }
      twiddlePosition -= step
      spectrumOffset += step
      if (twiddlePosition < 0) break
    }
    spectrumOffset -= DECODER_SPECTRAL_LINES_PER_UNIT
    step = half
    if (step === 2) break
  }

  for (let group = 0; group < DECODER_SPECTRUM_FLOATS_PER_UNIT / 2; group++) {
    const offset = group * SUBBAND_COUNT
    const twiddle =
      INVERSE_TRANSFORM_TWIDDLES[
        DECODER_SPECTRUM_FLOATS_PER_UNIT - 2 - group * 2
      ]
    const firstDifference = float32Subtract(
      spectrum[offset],
      spectrum[offset + 3]
    )
    const secondDifference = float32Subtract(
      spectrum[offset + 1],
      spectrum[offset + 2]
    )
    const rotatedSecond = float32Multiply(spectrum[offset + 2], twiddle)
    const rotatedThird = float32Multiply(spectrum[offset + 3], twiddle)
    spectrum[offset] = float32Add(firstDifference, rotatedSecond)
    spectrum[offset + 2] = float32Subtract(firstDifference, rotatedSecond)
    spectrum[offset + 1] = float32Add(secondDifference, rotatedThird)
    spectrum[offset + 3] = float32Subtract(secondDifference, rotatedThird)
  }

  const synthesisBase = RESIDUAL_DELAY_SAMPLES + blockIndex
  const gain = INVERSE_TRANSFORM_SCALES[gainIndex]
  for (
    let tableIndex = 0;
    tableIndex < DECODER_SPECTRUM_FLOATS_PER_UNIT;
    tableIndex++
  ) {
    const reorder = TRANSFORM_REORDER_INDICES[tableIndex]
    const source = tableIndex * 2
    const first = Number(spectrum[source])
    const second = Number(spectrum[source + 1])
    const difference = first - second
    const scaledSum = Number(coefficient(reorder, 3)) * second
    const previous = Number(synthesis.overlap[blockIndex][reorder])
    const rotatedDifference =
      (difference - scaledSum) * Number(gain) * Number(coefficient(reorder, 2))
    const lowerOutput =
      synthesisBase +
      (DECODER_SPECTRUM_FLOATS_PER_UNIT - 1 - reorder) * SUBBAND_COUNT
    const upperOutput =
      synthesisBase + reorder * SUBBAND_COUNT + HALF_FRAME_SAMPLES
    synthesis.synthesisBuffer[lowerOutput] = Math.fround(
      previous - Number(coefficient(reorder, 0)) * rotatedDifference
    )
    synthesis.synthesisBuffer[upperOutput] = Math.fround(
      Number(coefficient(reorder, 0)) * previous + rotatedDifference
    )
    synthesis.overlap[blockIndex][reorder] = Math.fround(
      (difference + scaledSum) * Number(coefficient(reorder, 1))
    )
  }
}
