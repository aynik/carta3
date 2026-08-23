/** Shared ATRAC3 spectral geometry. */

import { QUANTIZATION_UNIT_OFFSETS } from './tables.js'

/**
 * Validate and return one residual band's coefficient range.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum or symbol row.
 * @param {number} band Quantization-unit index.
 * @returns {object} Half-open coefficient range.
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
  return { start, end }
}
