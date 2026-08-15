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
import { measureHuffmanBits } from './entropy.js'

/**
 * Resolve a coded spectral scale-factor index.
 * @param {number} index Six-bit scale-factor index.
 * @returns {number} Scale factor, or positive infinity outside the syntax range.
 */
export function spectralScaleForIndex(index) {
  if (index >= 0 && index <= 63) return SPECTRAL_SCALE_FACTORS[index]
  return Number.POSITIVE_INFINITY
}

/**
 * Select the first scale-factor index strictly above an absolute magnitude.
 * @param {number} value Non-negative spectral magnitude.
 * @returns {number} Six-bit scale-factor index.
 */
export function scaleFactorIndexForAbs(value) {
  let index = 0
  while (index < 63 && SPECTRAL_SCALE_FACTORS[index] <= value) index++
  return index
}

/**
 * Compute the profile-defined dead-zone threshold for one allocation mode.
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

/** Truncate a finite f64 to the codec's saturated signed integer domain. */
function truncateF64ToI32(value) {
  if (Number.isNaN(value)) return -0x80000000
  if (value >= 0x7fffffff) return 0x7fffffff
  if (value <= -0x80000000) return -0x80000000
  return Math.trunc(value)
}

/** Clamp one quantized symbol to the selected mode's signed range. */
function clampSymbol(symbol, stepCount) {
  if (symbol > stepCount) return stepCount
  if (symbol < -stepCount) return -stepCount
  return symbol
}

/**
 * Quantize one spectrum coefficient with codec-compatible saturation.
 * @param {number} spectrum Source coefficient.
 * @param {number} scale Selected spectral scale factor.
 * @param {number} stepCount Maximum signed quantizer rank.
 * @returns {number} Saturated signed symbol.
 */
export function quantizeSpectralValue(spectrum, scale, stepCount) {
  const limit = float32Add(stepCount, QUANTIZATION_LIMIT_BIAS)
  const biased = (spectrum / scale) * limit + QUANTIZATION_BIAS_SCALE
  return clampSymbol((truncateF64ToI32(biased) - 0x1f) | 0, stepCount)
}

/**
 * Quantize a normalized non-tone coefficient run.
 * @param {number} wordLength Coded word length, or zero for an omitted band.
 * @param {number} zeroThreshold Absolute dead-zone threshold.
 * @param {ArrayLike<number>} spectrum Normalized source coefficients.
 * @param {Int32Array} output Destination symbols.
 * @returns {number} Number of symbols written.
 */
export function quantizeNontoneSymbols(
  wordLength,
  zeroThreshold,
  spectrum,
  output
) {
  if (wordLength === 0) return 0
  if (wordLength < 0 || wordLength > 7 || output.length < spectrum.length) {
    throw new RangeError('ATRAC3 non-tone quantization geometry is invalid')
  }
  const stepCount = WORD_LENGTH_QUANTIZER_LEVELS[wordLength]
  const limit = float32Add(stepCount, QUANTIZATION_LIMIT_BIAS)
  for (let index = 0; index < spectrum.length; index++) {
    const sample = spectrum[index]
    if (Math.abs(sample) <= zeroThreshold) {
      output[index] = 0
    } else {
      output[index] = clampSymbol(
        (truncateF64ToI32(sample * limit + QUANTIZATION_BIAS_SCALE) - 0x1f) | 0,
        stepCount
      )
    }
  }
  return spectrum.length
}

/**
 * Measure selector and Huffman bits for a quantized non-tone run.
 * @param {number} tableGroup Huffman family selector.
 * @param {number} wordLength Coded word length.
 * @param {ArrayLike<number>} symbols Quantized symbols.
 * @param {object[][]} families Runtime Huffman families.
 * @returns {number} Exact syntax cost in bits.
 */
export function measureNontoneBits(tableGroup, wordLength, symbols, families) {
  if (wordLength === 0) return 0
  const table = families?.[tableGroup]?.[wordLength]
  if (!table) throw new RangeError('ATRAC3 non-tone codebook is unavailable')
  return 6 + measureHuffmanBits(table, symbols)
}
