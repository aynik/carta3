/** Carta3 residual allocation measurement. */

/** Carta3 Audio Codec - Residual codebooks, quantization, and pricing. */

import {
  RESIDUAL_SYMBOL_MASKS,
  SPECTRAL_SCALE_FACTORS,
} from '../core/tables.js'
import {
  quantizeResidualCoefficient,
  residualBandRange,
  residualCodebook,
  residualQuantGroupScale,
  validateResidualSyntax,
} from '../quantization/symbols/residual.js'
/**
 * Expand one compact residual mode into encoder and decoder tables.
 *
 * @param {number} mode
 * @returns {object}
 */

/**
 * Quantize and measure reconstruction cost over a coefficient range.
 *
 * @param {Float32Array} source
 * @param {object} range
 * @param {number} mode
 * @param {number} scaleFactor
 * @returns {object}
 */
function measureBand(source, range, mode, scaleFactor) {
  validateResidualSyntax(mode, scaleFactor)
  const codebook = residualCodebook(mode)
  const quantizerScale = residualQuantGroupScale(mode, scaleFactor)
  const decodeScale = SPECTRAL_SCALE_FACTORS[scaleFactor]
  let bits = 6
  let error = 0
  if (codebook.paired) {
    for (let line = range.start; line + 1 < range.end; line += 2) {
      const firstSample = Math.fround(source[line])
      const secondSample = Math.fround(source[line + 1])
      const first = quantizeResidualCoefficient(firstSample, quantizerScale, 3)
      const second = quantizeResidualCoefficient(
        secondSample,
        quantizerScale,
        3
      )
      const symbol = second + first * 4
      bits += codebook.bitLengths[symbol]
      const firstReconstructed = Math.fround(
        codebook.firstValues[symbol] * decodeScale
      )
      const secondReconstructed = Math.fround(
        codebook.secondValues[symbol] * decodeScale
      )
      const firstError = firstSample - firstReconstructed
      const secondError = secondSample - secondReconstructed
      error += firstError * firstError
      error += secondError * secondError
    }
  } else {
    const symbolMask = RESIDUAL_SYMBOL_MASKS[mode - 2]
    for (let line = range.start; line < range.end; line++) {
      const sample = Math.fround(source[line])
      const symbol = quantizeResidualCoefficient(
        sample,
        quantizerScale,
        symbolMask
      )
      bits += codebook.bitLengths[symbol]
      const reconstructed = Math.fround(
        codebook.firstValues[symbol] * decodeScale
      )
      const difference = sample - reconstructed
      error += difference * difference
    }
  }
  return {
    bits,
    error,
  }
}

/**
 * Measure exact syntax bits, reconstruction error, and energy for one band.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual mode, or zero for an omitted band.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @returns {{bits: number, error: number, energy: number}} Rate/distortion cost.
 */
export function measureResidualBand(source, band, mode, scaleFactor) {
  const range = residualBandRange(source, band)
  let energy = 0
  for (let line = range.start; line < range.end; line++) {
    const sample = Math.fround(source[line])
    energy += sample * sample
  }
  if (mode === 0)
    return {
      bits: 0,
      error: energy,
      energy,
    }
  const cost = measureBand(source, range, mode, scaleFactor)
  return {
    ...cost,
    energy,
  }
}

/**
 * Measure the immediately adjacent residual modes for allocation search.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Current residual mode.
 * @param {number} scaleFactor Current scale-factor index.
 * @returns {Array<object|null>} Costs for mode-1 and mode+1.
 */
export function measureResidualModeNeighbors(source, band, mode, scaleFactor) {
  const range = residualBandRange(source, band)
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) {
    throw new RangeError('Invalid ATRAC3 residual quantization mode')
  }
  if (!Number.isInteger(scaleFactor) || scaleFactor < 0 || scaleFactor > 63) {
    throw new RangeError('Invalid ATRAC3 residual scale factor')
  }
  return [mode - 1, mode + 1].map((candidate) => {
    if (candidate < 1 || candidate > 7) return null
    return measureBand(source, range, candidate, scaleFactor)
  })
}

/**
 * Measure the immediately adjacent scale factors for allocation search.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Current residual mode.
 * @param {number} scaleFactor Current scale-factor index.
 * @returns {Array<object|null>} Costs for scale-1 and scale+1.
 */
export function measureResidualScaleNeighbors(source, band, mode, scaleFactor) {
  const range = residualBandRange(source, band)
  if (mode === 0) return [null, null]
  validateResidualSyntax(mode, scaleFactor)
  return [scaleFactor - 1, scaleFactor + 1].map((candidate) => {
    if (candidate < 0 || candidate > 63) return null
    const { bits, error } = measureBand(source, range, mode, candidate)
    return {
      scaleFactor: candidate,
      bits,
      error,
    }
  })
}

/**
 * Quantize and write residual symbols over a validated coefficient range.
 *
 * @param {Float32Array} source
 * @param {object} range
 * @param {number} mode
 * @param {number} scaleFactor
 * @param {object} sink
 * @returns {number}
 */
