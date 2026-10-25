/** Carta3 residual allocation measurement. */

import {
  RESIDUAL_SYMBOL_MASKS,
  SPECTRAL_SCALE_FACTORS,
} from '../core/tables.js'
import { residualBandRange } from '../core/geometry.js'
import {
  quantizeResidualCoefficient,
  residualQuantGroupScale,
} from '../quantization/residual.js'
import { residualCodebook, validateResidualSyntax } from '../syntax/residual.js'

/**
 * Quantize and measure reconstruction cost over a coefficient range.
 *
 * @param {Float32Array} source
 * @param {object} range
 * @param {number} mode
 * @param {number} scaleFactor
 * @returns {object}
 * @nativeUnchecked The caller validates the source range; quantizer masks bound
 * all codebook indices.
 */
function measureBand(source, range, mode, scaleFactor) {
  validateResidualSyntax(mode, scaleFactor)
  const codebook = residualCodebook(mode)
  const quantizerScale = residualQuantGroupScale(mode, scaleFactor)
  const decodeScale = SPECTRAL_SCALE_FACTORS[scaleFactor]
  const { bitLengths, firstValues, secondValues } = codebook
  /** @type {i32} */
  const start = range.start
  /** @type {i32} */
  const end = range.end
  let bits = 6
  let error = 0
  if (codebook.paired) {
    for (let line = start; line + 1 < end; line += 2) {
      const firstSample = Math.fround(source[line])
      const secondSample = Math.fround(source[line + 1])
      const first = quantizeResidualCoefficient(firstSample, quantizerScale, 3)
      const second = quantizeResidualCoefficient(
        secondSample,
        quantizerScale,
        3
      )
      const symbol = second + first * 4
      bits += bitLengths[symbol]
      const firstReconstructed = Math.fround(firstValues[symbol] * decodeScale)
      const secondReconstructed = Math.fround(
        secondValues[symbol] * decodeScale
      )
      const firstError = firstSample - firstReconstructed
      const secondError = secondSample - secondReconstructed
      error += firstError * firstError
      error += secondError * secondError
    }
  } else {
    const symbolMask = RESIDUAL_SYMBOL_MASKS[mode - 2]
    for (let line = start; line < end; line++) {
      const sample = Math.fround(source[line])
      const symbol = quantizeResidualCoefficient(
        sample,
        quantizerScale,
        symbolMask
      )
      bits += bitLengths[symbol]
      const reconstructed = Math.fround(firstValues[symbol] * decodeScale)
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
 * @param {Float32Array} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual mode, or zero for an omitted band.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @returns {object} Rate/distortion cost.
 */
export function measureResidualBand(source, band, mode, scaleFactor) {
  const range = residualBandRange(source, band)
  /** @type {i32} */
  const start = range.start
  /** @type {i32} */
  const end = range.end
  let energy = 0
  for (let line = start; line < end; line++) {
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
  cost.energy = energy
  return cost
}

/**
 * Measure the immediately adjacent residual modes for allocation search.
 *
 * @param {Float32Array} source Complete residual spectrum.
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
  return [
    mode > 1 ? measureBand(source, range, mode - 1, scaleFactor) : null,
    mode < 7 ? measureBand(source, range, mode + 1, scaleFactor) : null,
  ]
}

/**
 * Measure the immediately adjacent scale factors for allocation search.
 *
 * @param {Float32Array} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Current residual mode.
 * @param {number} scaleFactor Current scale-factor index.
 * @returns {Array<object|null>} Costs for scale-1 and scale+1.
 */
export function measureResidualScaleNeighbors(source, band, mode, scaleFactor) {
  const range = residualBandRange(source, band)
  if (mode === 0) return [null, null]
  validateResidualSyntax(mode, scaleFactor)
  const neighbors = [null, null]
  for (let slot = 0; slot < neighbors.length; slot++) {
    const candidate = scaleFactor + (slot === 0 ? -1 : 1)
    if (candidate < 0 || candidate > 63) continue
    const { bits, error } = measureBand(source, range, mode, candidate)
    neighbors[slot] = { scaleFactor: candidate, bits, error }
  }
  return neighbors
}
