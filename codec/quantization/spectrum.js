/** Carta3 Audio Codec - Sound-unit spectral quantization. */

import {
  SPECTRAL_SCALE_FACTORS,
  WORD_LENGTH_QUANTIZER_LEVELS,
  ZERO_THRESHOLD_DIVISORS,
  ZERO_THRESHOLD_NUMERATORS,
} from '../core/tables.js'
import { float32Add } from '../utils.js'
import {
  QUANTIZATION_BIAS_SCALE,
  QUANTIZATION_LIMIT_BIAS,
} from '../core/constants.js'

/**
 * Truncate an f64 to the saturated signed integer domain; NaN maps to its minimum.
 *
 * @param {number} value
 * @returns {i32}
 */
function truncateF64ToI32(value) {
  if (value >= -0x80000000 && value < 0x80000000) return value | 0
  return value > 0 ? 0x7fffffff : -0x80000000
}

/**
 * Clamp one quantized symbol to the selected mode's signed range.
 *
 * @param {i32} symbol
 * @param {i32} stepCount
 * @returns {i32}
 */
function clampSymbol(symbol, stepCount) {
  if (symbol > stepCount) return stepCount
  if (symbol < -stepCount) return -stepCount
  return symbol
}

/**
 * Resolve a coded spectral scale-factor index.
 *
 * @param {number} index Six-bit scale-factor index.
 * @returns {number} Scale factor, or positive infinity outside the syntax range.
 */
export function spectralScaleForIndex(index) {
  if (index >= 0 && index <= 63) return SPECTRAL_SCALE_FACTORS[index]
  return Number.POSITIVE_INFINITY
}

/**
 * Select the first scale-factor index strictly above an absolute magnitude.
 *
 * @param {number} value Non-negative spectral magnitude.
 * @returns {i32} Six-bit scale-factor index.
 * @nativeUnchecked The search stays within the fixed 64-entry scale table.
 */
export function scaleFactorIndexForAbs(value) {
  let lower = 0
  let upper = 63
  while (lower < upper) {
    const middle = (lower + upper) >> 1
    if (SPECTRAL_SCALE_FACTORS[middle] <= value) lower = middle + 1
    else upper = middle
  }
  return lower
}

/**
 * Compute the profile-defined dead-zone threshold for one allocation mode.
 *
 * @param {number} timeFactor Perceptual time-domain factor.
 * @param {number} wordLength Coded spectral word length.
 * @returns {number} Float32-rounded zero threshold.
 */
export function quantZeroThreshold(timeFactor, wordLength) {
  if (timeFactor === 0) return 0
  const clamped = Math.max(1, Math.min(12, timeFactor))
  return Math.fround(
    ZERO_THRESHOLD_NUMERATORS[clamped] / ZERO_THRESHOLD_DIVISORS[wordLength]
  )
}

/**
 * Quantize one spectrum coefficient with codec-compatible saturation.
 *
 * @param {number} spectrum Source coefficient.
 * @param {number} scale Selected spectral scale factor.
 * @param {i32} stepCount Maximum signed quantizer rank.
 * @returns {number} Saturated signed symbol.
 */
export function quantizeSpectralValue(spectrum, scale, stepCount) {
  const limit = float32Add(stepCount, QUANTIZATION_LIMIT_BIAS)
  const biased = (spectrum / scale) * limit + QUANTIZATION_BIAS_SCALE
  return clampSymbol((truncateF64ToI32(biased) - 0x1f) | 0, stepCount)
}

/**
 * Quantize a normalized non-tone coefficient run.
 *
 * @param {number} wordLength Coded word length, or zero for an omitted band.
 * @param {number} zeroThreshold Absolute dead-zone threshold.
 * @param {Float32Array} spectrum Normalized source coefficients.
 * @param {Int32Array} output Destination symbols.
 * @param {i32} [start=0] First source coefficient.
 * @param {number} [count] Number of source coefficients.
 * @param {i32} [outputOffset=0] First destination symbol.
 * @returns {number} Number of symbols written.
 * @nativeUnchecked Source and destination ranges are validated before the loop.
 */
export function quantizeNontoneSymbols(
  wordLength,
  zeroThreshold,
  spectrum,
  output,
  start = 0,
  count = spectrum.length - start,
  outputOffset = 0
) {
  if (wordLength === 0) return 0
  /** @type {number} */
  const sampleCount = count
  if (
    wordLength < 0 ||
    wordLength > 7 ||
    start < 0 ||
    sampleCount < 0 ||
    start + sampleCount > spectrum.length ||
    outputOffset < 0 ||
    outputOffset + sampleCount > output.length
  ) {
    throw new RangeError('ATRAC3 non-tone quantization geometry is invalid')
  }
  const stepCount = WORD_LENGTH_QUANTIZER_LEVELS[wordLength]
  const limit = float32Add(stepCount, QUANTIZATION_LIMIT_BIAS)
  for (let index = 0; index < sampleCount; index++) {
    const sample = spectrum[start + index]
    if (Math.abs(sample) <= zeroThreshold) {
      output[outputOffset + index] = 0
    } else {
      output[outputOffset + index] = clampSymbol(
        (truncateF64ToI32(sample * limit + QUANTIZATION_BIAS_SCALE) - 0x1f) | 0,
        stepCount
      )
    }
  }
  return sampleCount
}
