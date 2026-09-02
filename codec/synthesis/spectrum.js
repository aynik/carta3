/** ATRAC3 inverse-transform lapping and synthesis publication. */

import {
  DECODER_MAX_UNITS,
  DECODER_SPECTRAL_LINES_PER_UNIT,
  DECODER_SPECTRUM_FLOATS_PER_UNIT,
  HALF_FRAME_SAMPLES,
  RESIDUAL_DELAY_SAMPLES,
  SUBBAND_COUNT,
} from '../core/constants.js'
import {
  INVERSE_TRANSFORM_COEFFICIENTS,
  INVERSE_TRANSFORM_SCALES,
  TRANSFORM_REORDER_INDICES,
} from '../core/tables.js'
import { inverseMdct256 } from '../signal/mdct.js'
import { float32Subtract } from '../utils.js'

/**
 * Read one field from the interleaved inverse-transform coefficient table.
 *
 * @param {number} index Coefficient row.
 * @param {number} field Field within the row.
 * @returns {number} Requested coefficient.
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
 */
export function inverseMdctBlock(spectrum, blockIndex, gainIndex, synthesis) {
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

  inverseMdct256(spectrum)

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
