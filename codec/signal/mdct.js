/** Carta3 floating-point and layered modified discrete cosine transforms. */

import {
  DECODER_SPECTRAL_LINES_PER_UNIT,
  DECODER_SPECTRUM_FLOATS_PER_UNIT,
  FLOAT32_NEGATIVE_ZERO_BITS,
  FRAME_SAMPLES,
  HALF_FRAME_SAMPLES,
  INVERSE_SQUARE_ROOT_TWO_BITS,
  LAYER_GAIN_HISTORY_OFFSET,
  LAYER_TRANSFORM_HISTORY_OFFSET,
  LAYER_WINDOW_MATRIX_OFFSET,
  PAIR_BLOCK_BASE_WORD,
  PAIR_BLOCK_GAIN_LEVEL_OFFSET,
  PAIR_BLOCK_WORDS,
  SUBBAND_COUNT,
} from '../core/constants.js'
import {
  ANALYSIS_POWER_OF_TWO_SCALES,
  ANALYSIS_ROTATION_SCALES,
  ANALYSIS_TWIDDLES,
  INVERSE_TRANSFORM_TWIDDLES,
  SPECTRUM_RECONSTRUCTION_SCALE,
  TRANSFORM_REORDER_INDICES,
  transformTables,
} from '../core/tables.js'
import { FFT } from './fft.js'
import {
  float32Add,
  float32FromBits,
  float32Multiply,
  float32Subtract,
  float32ToBits,
} from '../utils.js'

/**
 * Bit-exact forward MDCT for the 66/105 kbps layered transform.
 *
 * This kernel shares the MDCT responsibility with {@link MDCT}, but
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
 * @param {Uint32Array} words Mutable layered transform word image.
 * @param {Float32Array} transform Reusable transform workspace.
 * @param {Float32Array} initialGainScales Reusable initial-gain workspace.
 */
export function transformLayeredMdct(words, transform, initialGainScales) {
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

/** Forward MDCT with Carta3's pinned Float32 evaluation order. */
export class MDCT {
  /**
   * @param {number} size Time-domain transform size.
   * @param {number} [scale=4] Transform normalization.
   */
  constructor(size, scale = 4) {
    if (size !== 512 || !Number.isFinite(scale)) {
      throw new RangeError('Carta3 MDCT requires size 512 and a finite scale')
    }
    this.size = size
    this.halfSize = size >> 1
    this.scale = Math.fround(scale / size)
  }

  /**
   * Transform windowed time-domain samples into MDCT coefficients.
   *
   * @param {Float32Array} input Windowed time-domain samples.
   * @param {object} scratch Reusable transform storage.
   * @param {Float32Array|null} [destination=null] Optional caller-owned output.
   * @param {number} [destinationOffset=0] First output coefficient.
   * @returns {Float32Array} Destination containing the coefficients.
   */
  transform(input, scratch, destination = null, destinationOffset = 0) {
    const output = destination ?? new Float32Array(this.halfSize)
    if (
      !(input instanceof Float32Array) ||
      input.length < this.size ||
      !(output instanceof Float32Array) ||
      destinationOffset < 0 ||
      destinationOffset + this.halfSize > output.length ||
      !(scratch?.folded instanceof Float32Array) ||
      scratch.folded.length < this.halfSize ||
      !(scratch?.real instanceof Float32Array) ||
      scratch.real.length < 128 ||
      !(scratch?.imaginary instanceof Float32Array) ||
      scratch.imaginary.length < 128
    ) {
      throw new RangeError('Carta3 MDCT buffers have invalid geometry')
    }

    const tables = transformTables()
    const folded = scratch.folded
    const real = scratch.real
    const imaginary = scratch.imaginary

    for (let sample = 0; sample < 64; sample++) {
      folded[sample] = float32Subtract(
        -input[384 + sample * 2],
        input[383 - sample * 2]
      )
    }
    for (let sample = 0; sample < 128; sample++) {
      folded[64 + sample] = float32Subtract(
        input[sample * 2],
        input[255 - sample * 2]
      )
    }
    for (let sample = 0; sample < 64; sample++) {
      folded[192 + sample] = float32Add(
        input[256 + sample * 2],
        input[511 - sample * 2]
      )
    }

    for (let coefficientIndex = 0; coefficientIndex < 128; coefficientIndex++) {
      const evenSample = folded[coefficientIndex * 2]
      const oddSample = folded[coefficientIndex * 2 + 1]
      const cosine = tables.mdctPreRotationCosines[coefficientIndex]
      const sine = tables.mdctPreRotationSines[coefficientIndex]
      real[coefficientIndex] = float32Subtract(
        float32Multiply(evenSample, cosine),
        float32Multiply(oddSample, sine)
      )
      imaginary[coefficientIndex] = float32Add(
        float32Multiply(evenSample, sine),
        float32Multiply(oddSample, cosine)
      )
    }

    FFT.transform(real, imaginary)

    for (let coefficientIndex = 0; coefficientIndex < 128; coefficientIndex++) {
      const reverseIndex = 127 - coefficientIndex
      const forwardReal = real[coefficientIndex]
      const reverseReal = real[reverseIndex]
      const forwardImaginary = imaginary[coefficientIndex]
      const reverseImaginary = imaginary[reverseIndex]
      const minus = tables.mdctBaseCosineMinusFifthSine[coefficientIndex]
      const plus = tables.mdctBaseCosinePlusFifthSine[coefficientIndex]
      const fifthPlus = tables.mdctFifthCosinePlusBaseSine[coefficientIndex]
      const fifthMinus = tables.mdctFifthCosineMinusBaseSine[coefficientIndex]

      folded[coefficientIndex] = float32Add(
        float32Add(
          float32Add(
            float32Multiply(forwardReal, minus),
            float32Multiply(reverseReal, plus)
          ),
          float32Multiply(forwardImaginary, fifthPlus)
        ),
        float32Multiply(reverseImaginary, fifthMinus)
      )
      folded[255 - coefficientIndex] = float32Add(
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

    for (let coefficientIndex = 0; coefficientIndex < 256; coefficientIndex++) {
      output[destinationOffset + coefficientIndex] = float32Multiply(
        this.scale,
        folded[coefficientIndex]
      )
    }
    return output
  }
}

/**
 * Apply the bit-exact inverse MDCT butterfly to one spectral unit.
 *
 * @param {Float32Array} spectrum Mutable reconstructed spectrum.
 * @returns {Float32Array} The transformed `spectrum`.
 */
export function inverseMdct256(spectrum) {
  if (spectrum.length !== DECODER_SPECTRAL_LINES_PER_UNIT) {
    throw new RangeError('Invalid ATRAC3 inverse block geometry')
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
  while (step > 2) {
    const half = step >> 1
    let twiddlePosition = DECODER_SPECTRUM_FLOATS_PER_UNIT - 1 - half
    while (twiddlePosition >= 0) {
      const span = step * 2
      let end = spectrumOffset
      let remaining = span
      while (remaining > 0) {
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
      }
      const endOffset = end
      const twiddle = INVERSE_TRANSFORM_TWIDDLES[twiddlePosition]
      while (spectrumOffset !== endOffset) {
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
      }
      twiddlePosition -= step
      spectrumOffset += step
    }
    spectrumOffset -= DECODER_SPECTRAL_LINES_PER_UNIT
    step = half
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

  return spectrum
}
