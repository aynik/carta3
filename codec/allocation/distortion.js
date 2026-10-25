/** Carta3 Audio Codec - Perceptual reconstruction masking. */

import {
  QUANTIZATION_UNIT_OFFSETS,
  SPREAD_DOWN,
  SPREAD_UP,
  WORD_LENGTH_QUANTIZER_LEVELS,
} from '../core/tables.js'
import { spectralScaleForIndex } from '../quantization/spectrum.js'
import { F64_MIN_POSITIVE } from '../core/constants.js'

/**
 * Estimate tonality from spectral energy concentration within one band.
 *
 * @param {object} band
 * @returns {number}
 */
function tonality(band) {
  if (band.energy <= 0 || band.width <= 1) return 0
  const concentration = Math.max(1, (band.peak * band.width) / band.energy)
  return Math.max(
    0,
    Math.min(1, Math.log(concentration) / Math.log(band.width))
  )
}

/**
 * Build the source-derived mask from codec-owned band measures.
 *
 * @param {object[]} bands Per-band energy, peak, and width records.
 * @returns {Float64Array} Positive masking threshold for each band.
 * @nativeUnchecked Spread limits stay within the allocated thresholds and tables.
 */
export function buildMaskFromBandMeasures(bands) {
  const thresholds = new Float64Array(bands.length)
  for (let from = 0; from < bands.length; from++) {
    const band = bands[from]
    const tonal = 14.5 + from * 0.5
    const shape = tonality(band)
    const offset = shape * tonal + (1 - shape) * 5.5
    const level = band.energy * 10 ** (-offset / 10)
    if (level <= 0) continue
    const firstDown = Math.max(0, from - (SPREAD_DOWN.length - 1))
    for (let to = firstDown; to < from; to++) {
      thresholds[to] += level * SPREAD_DOWN[from - to]
    }
    const upperEnd = Math.min(bands.length, from + SPREAD_UP.length)
    for (let to = from; to < upperEnd; to++) {
      thresholds[to] += level * SPREAD_UP[to - from]
    }
  }
  if (bands.length === 0) return thresholds
  let meanEnergy = 0
  for (const band of bands) meanEnergy += band.energy
  meanEnergy /= bands.length
  const floor = meanEnergy * 1e-6 + F64_MIN_POSITIVE
  for (let band = 0; band < thresholds.length; band++) {
    thresholds[band] += floor
  }
  return thresholds
}

/**
 * Build the threshold vector from a normalized spectrum.
 *
 * @param {Float32Array} normalizedSpectrum Normalized source coefficients.
 * @param {Int32Array} scaleFactorIndices Per-band scale selectors.
 * @param {number} bandCount Active quantization-band count.
 * @returns {Float64Array} Masking thresholds for all codec bands.
 * @nativeUnchecked The caller bounds active bands to the complete source spectrum.
 */
export function buildReconstructionMask(
  normalizedSpectrum,
  scaleFactorIndices,
  bandCount
) {
  const bands = Array.from({ length: 32 }, () => ({
    energy: 0,
    peak: 0,
    width: 0,
  }))
  for (let band = 0; band < bandCount; band++) {
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    const scale = spectralScaleForIndex(scaleFactorIndices[band])
    const measure = bands[band]
    let energy = 0
    let peak = 0
    for (let coefficient = start; coefficient < end; coefficient++) {
      const sample = Number(normalizedSpectrum[coefficient]) * scale
      const square = sample * sample
      energy += square
      if (square > peak) peak = square
    }
    measure.width = end - start
    measure.energy = energy
    measure.peak = peak
  }

  return buildMaskFromBandMeasures(bands)
}

/**
 * Measure one band's normalized reconstruction error.
 *
 * @param {object} state Quantization state containing reconstructed symbols.
 * @param {Float32Array} normalizedSpectrum Normalized source coefficients.
 * @param {number} band Quantization-band index.
 * @returns {number} Sum of squared coefficient error.
 */
export function measureBandReconstructionNoise(
  state,
  normalizedSpectrum,
  band
) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  return measureBandOptionReconstructionNoise(
    state.wordLengths[band],
    state.scaleFactorIndices[band],
    state.quantizedSpectrum,
    normalizedSpectrum,
    band,
    start
  )
}

/**
 * Measure one detached band option without constructing a complete allocation.
 *
 * @param {number} wordLength Candidate coded word length.
 * @param {number} scaleFactorIndex Candidate spectral scale selector.
 * @param {Int32Array} symbols Candidate symbols.
 * @param {Float32Array} normalizedSpectrum Normalized source coefficients.
 * @param {number} band Quantization-band index.
 * @param {i32} [symbolOffset=0] First candidate symbol.
 * @returns {number} Sum of squared coefficient error.
 */
export function measureBandOptionReconstructionNoise(
  wordLength,
  scaleFactorIndex,
  symbols,
  normalizedSpectrum,
  band,
  symbolOffset = 0
) {
  const inverseStep =
    wordLength > 0 ? 1 / (WORD_LENGTH_QUANTIZER_LEVELS[wordLength] + 0.5) : 0
  const sourceScale = spectralScaleForIndex(scaleFactorIndex)
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  let noise = 0
  for (let coefficient = start; coefficient < end; coefficient++) {
    const reconstructed =
      wordLength > 0
        ? symbols[symbolOffset + coefficient - start] * inverseStep
        : 0
    const error =
      (Number(normalizedSpectrum[coefficient]) - reconstructed) * sourceScale
    noise += error * error
  }
  return noise
}
