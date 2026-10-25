/** Carta3 residual symbol quantization operators. */

import {
  QUANTIZATION_SCALE_THRESHOLDS,
  RESIDUAL_SYMBOL_MASKS,
} from '../core/tables.js'
import {
  CODEBOOK_ZERO_SCALE_BITS,
  FLOAT_ROUNDING_BIAS,
} from '../core/constants.js'
import { residualBandRange } from '../core/geometry.js'
import { float32FromBits, float32ToBits } from '../utils.js'

/**
 * Validate one residual quantizer configuration.
 *
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 */
function validateResidualQuantizer(mode, scaleFactor) {
  if (!Number.isInteger(mode) || mode < 1 || mode > 7) {
    throw new RangeError('Invalid ATRAC3 residual quantization mode')
  }
  if (!Number.isInteger(scaleFactor) || scaleFactor < 0 || scaleFactor > 63) {
    throw new RangeError('Invalid ATRAC3 residual scale factor')
  }
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
 * @returns {i32} Unsigned codebook symbol.
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
 * Materialize one residual band's selected symbols.
 *
 * @param {Float32Array} source Complete residual spectrum.
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
  validateResidualQuantizer(mode, scaleFactor)
  if (!(output instanceof Int32Array) || output.length < range.end) {
    throw new RangeError('Invalid ATRAC3 residual symbol storage')
  }
  const quantizerScale = residualQuantGroupScale(mode, scaleFactor)
  /** @type {i32} */
  const start = range.start
  /** @type {i32} */
  const end = range.end
  if (mode === 1) {
    for (let line = start; line + 1 < end; line += 2) {
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
    for (let line = start; line < end; line++) {
      output[line] = quantizeResidualCoefficient(
        source[line],
        quantizerScale,
        symbolMask
      )
    }
  }
  return output
}
