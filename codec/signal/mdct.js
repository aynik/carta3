/** Carta3 floating-point and layered modified discrete cosine transforms. */

import {
  DECODER_SPECTRAL_LINES_PER_UNIT,
  DECODER_SPECTRUM_FLOATS_PER_UNIT,
  FRAME_SAMPLES,
  HALF_FRAME_SAMPLES,
  INVERSE_SQUARE_ROOT_TWO_BITS,
  LAYER_MDCT_MIRROR_BASE,
  LAYER_MDCT_ROWS,
  LAYER_MDCT_ROW_WORDS,
  SUBBAND_COUNT,
} from '../core/constants.js'
import {
  ANALYSIS_ROTATION_SCALES,
  INVERSE_TRANSFORM_TWIDDLES,
  SPECTRUM_RECONSTRUCTION_SCALE,
  transformTables,
} from '../core/tables.js'
import { FFT } from './fft.js'
import {
  float32Add,
  float32FromBits,
  float32Multiply,
  float32Subtract,
} from '../utils.js'

/** Pinned inverse square root of two for layered MDCT post-rotation. */
const inverseSquareRootTwo = float32FromBits(INVERSE_SQUARE_ROOT_TWO_BITS)

/**
 * Transform one caller-prepared four-lane layered MDCT matrix in place.
 *
 * This bit-exact low-rate kernel shares the mathematical MDCT responsibility
 * with {@link MDCT}, while preserving its four interleaved transform lanes.
 *
 * @param {Float32Array} transform Prepared transform matrix and destination.
 * @returns {Float32Array} The transformed matrix.
 */
export function transformLayeredMdct(transform) {
  if (
    !(transform instanceof Float32Array) ||
    transform.length < FRAME_SAMPLES
  ) {
    throw new RangeError('ATRAC3 layered MDCT matrix has invalid geometry')
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
  }
  return transform
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
