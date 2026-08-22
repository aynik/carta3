/** Carta3 residual symbol quantization. */

/** Carta3 Audio Codec - Residual codebooks, quantization, and pricing. */

import {
  QUANTIZATION_SCALE_THRESHOLDS,
  QUANTIZATION_UNIT_OFFSETS,
  RESIDUAL_CODE_PAIRS,
  RESIDUAL_SYMBOL_MASKS,
  RESIDUAL_VALUE_BITS,
} from '../../core/tables.js'
import {
  CODEBOOK_ZERO_SCALE_BITS,
  FLOAT_ROUNDING_BIAS,
} from '../../core/constants.js'
import { float32FromBits, float32ToBits } from '../../utils.js'

/**
 * Expand one compact residual mode into encoder and decoder tables.
 *
 * @param {number} mode
 * @returns {object}
 */
function buildCodebook(mode) {
  const pairs = RESIDUAL_CODE_PAIRS[mode - 1]
  const count = pairs.length / 2
  const codes = new Uint16Array(count)
  const bitLengths = new Uint8Array(count)
  const firstValues = new Float32Array(count)
  const secondValues = new Float32Array(count)
  for (let index = 0; index < count; index++) {
    codes[index] = pairs[index * 2]
    bitLengths[index] = pairs[index * 2 + 1]
  }
  if (mode === 1) {
    const firstBits = new Uint32Array([
      0, 0, 0, 0, 1059760811, 1059760811, 0, 1059760811, 0, 0, 0, 0, 3207244459,
      3207244459, 0, 3207244459,
    ])
    const secondBits = new Uint32Array([
      0, 1059760811, 0, 3207244459, 0, 1059760811, 0, 3207244459, 0, 0, 0, 0, 0,
      1059760811, 0, 3207244459,
    ])
    for (let index = 0; index < count; index++) {
      firstValues[index] = float32FromBits(firstBits[index])
      secondValues[index] = float32FromBits(secondBits[index])
    }
  } else {
    const values = RESIDUAL_VALUE_BITS[mode - 2]
    for (let index = 0; index < count; index++) {
      firstValues[index] = float32FromBits(values[index])
    }
  }
  return Object.freeze({
    paired: mode === 1,
    codes,
    bitLengths,
    firstValues,
    secondValues,
  })
}
let residualCodebooks

/**
 * Lazily build and cache all seven residual codebooks.
 *
 * @returns {object[]}
 */
function codebooks() {
  residualCodebooks ??= Array.from(
    {
      length: 7,
    },
    (_, index) => buildCodebook(index + 1)
  )
  return residualCodebooks
}

/**
 * Resolve one cached low-rate residual codebook.
 *
 * @param {number} mode Coded residual mode from 1 through 7.
 * @returns {object|null} Codebook, or null for an invalid mode.
 */
export function residualCodebook(mode) {
  return Number.isInteger(mode) && mode >= 1 && mode <= 7
    ? codebooks()[mode - 1]
    : null
}

/**
 * Compute the exact f32 scale used before residual symbol-index rounding.
 *
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit residual scale-factor index.
 * @returns {number} Float32 quantizer scale.
 */
export function residualQuantGroupScale(mode, scaleFactor) {
  const scaledFactor = Math.imul(scaleFactor >>> 0, 43) >>> 0
  const exponentMask = (scaledFactor << 16) & 0x7f800000
  const index =
    (Math.imul(3, ((scaledFactor >>> 7) + (mode >>> 0)) >>> 0) -
      (scaleFactor >>> 0)) |
    0
  const scaleBits =
    index <= 0
      ? CODEBOOK_ZERO_SCALE_BITS
      : index <= 21
        ? QUANTIZATION_SCALE_THRESHOLDS[index - 1]
        : QUANTIZATION_SCALE_THRESHOLDS[20]
  return float32FromBits((scaleBits - (exponentMask >>> 0)) >>> 0)
}

/**
 * Quantize through the codec's f64 multiply plus f32 rounding-bit boundary.
 *
 * @param {number} coefficient Source spectral coefficient.
 * @param {number} quantizerScale Float32 quantizer scale.
 * @param {number} symbolMask Codebook-specific unsigned symbol mask.
 * @returns {number} Unsigned codebook symbol.
 */
export function quantizeResidualCoefficient(
  coefficient,
  quantizerScale,
  symbolMask
) {
  const rounded = Math.fround(
    Math.fround(coefficient) * Math.fround(quantizerScale) + FLOAT_ROUNDING_BIAS
  )
  return float32ToBits(rounded) & symbolMask
}

/**
 * Validate and return one residual band's coefficient range.
 *
 * @param {Float32Array} source
 * @param {number} band
 * @returns {object}
 */
export function residualBandRange(source, band) {
  if (!Number.isInteger(band) || band < 0 || band >= 32) {
    throw new RangeError('Invalid ATRAC3 residual band geometry')
  }
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  if (!source || source.length < end) {
    throw new RangeError('Invalid ATRAC3 residual band geometry')
  }
  return {
    start,
    end,
  }
}

/**
 * Validate one residual mode/scale-factor pair before coding.
 *
 * @param {number} mode
 * @param {number} scaleFactor
 */
export function validateResidualSyntax(mode, scaleFactor) {
  if (!Number.isInteger(mode) || mode < 1 || mode > 7) {
    throw new RangeError('Invalid ATRAC3 residual quantization mode')
  }
  if (!Number.isInteger(scaleFactor) || scaleFactor < 0 || scaleFactor > 63) {
    throw new RangeError('Invalid ATRAC3 residual scale factor')
  }
}

/**
 * Quantize and measure reconstruction cost over a coefficient range.
 *
 * @param {Float32Array} source
 * @param {object} range
 * @param {number} mode
 * @param {number} scaleFactor
 * @returns {object}
 */

/**
 * Materialize one residual band's selected symbols.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {Int32Array} output Complete retained symbol destination.
 * @returns {Int32Array} `output` after quantization.
 */
export function quantizeResidualSymbols(
  source,
  band,
  mode,
  scaleFactor,
  output
) {
  const range = residualBandRange(source, band)
  validateResidualSyntax(mode, scaleFactor)
  if (!(output instanceof Int32Array) || output.length < range.end) {
    throw new RangeError('Invalid ATRAC3 residual symbol storage')
  }
  const codebook = residualCodebook(mode)
  const quantizerScale = residualQuantGroupScale(mode, scaleFactor)
  if (codebook.paired) {
    for (let line = range.start; line + 1 < range.end; line += 2) {
      output[line] = quantizeResidualCoefficient(
        source[line],
        quantizerScale,
        3
      )
      output[line + 1] = quantizeResidualCoefficient(
        source[line + 1],
        quantizerScale,
        3
      )
    }
  } else {
    const symbolMask = RESIDUAL_SYMBOL_MASKS[mode - 2]
    for (let line = range.start; line < range.end; line++) {
      output[line] = quantizeResidualCoefficient(
        source[line],
        quantizerScale,
        symbolMask
      )
    }
  }
  return output
}

/**
 * Write one residual band's retained symbols.
 *
 * @param {Int32Array} symbols Complete retained symbol source.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {{bitPosition: number, write: Function}} sink Bit writer.
 * @returns {number} Codeword bits written.
 */
