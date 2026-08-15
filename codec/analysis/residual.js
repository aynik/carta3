/** Carta3 Audio Codec - Layered residual source-spectrum analysis. */

import {
  QUANTIZATION_UNIT_OFFSETS,
  RESIDUAL_BAND_ENERGY_THRESHOLDS,
} from '../core/tables.js'
import { ResidualSourceProfile } from '../state/layered.js'
import { float32ToBits } from '../utils.js'

/** Approximate a layered scale-factor index from an ordered magnitude key. */
function scaleFactorEstimate(magnitudeKey) {
  const mantissa = magnitudeKey & 0x00ffffff
  let estimate = Math.imul(magnitudeKey >>> 24, 3) >>> 0
  estimate = (estimate - (mantissa <= 0x00965fe9 ? 0x16c : 0x16b)) >>> 0
  if (mantissa < 0x00428a30) estimate = (estimate - 1) >>> 0
  return estimate < 0x40 ? estimate : 0
}

/**
 * Measure stable activity, scale, and mono-expansion evidence for one layer.
 * @param {object} layer Transformed transaction-local layer state.
 * @param {object} [profile] Reusable destination measurement profile.
 * @returns {object} The populated `profile`.
 */
export function measureResidualSource(
  layer,
  profile = new ResidualSourceProfile()
) {
  if (
    !layer?.spectrum ||
    layer.spectrum.length < 1024 ||
    profile.groupScaleFactors?.length < 256 ||
    profile.bandMetrics?.length < 34 ||
    profile.scaleFactors?.length < 32 ||
    profile.monoExpansionBudgetThresholds?.length < 32
  ) {
    throw new RangeError('ATRAC3 residual source profile has invalid geometry')
  }

  profile.reset()
  const groups = profile.groupScaleFactors
  for (let group = 0; group < 256; group++) {
    const base = group * 4
    let maximumKey = 0
    for (let line = 0; line < 4; line++) {
      const key = (float32ToBits(layer.spectrum[base + line]) << 1) >>> 0
      if (key > maximumKey) maximumKey = key
    }
    groups[group] = scaleFactorEstimate(maximumKey)
  }

  let groupCursor = 0
  let over7Total = 0
  let sumRunning = 0
  let globalPeak = 0
  for (let band = 0; band < 32; band++) {
    let sum = 0
    let peak = 0
    const bandStart = QUANTIZATION_UNIT_OFFSETS[band]
    const groupEnd = QUANTIZATION_UNIT_OFFSETS[band + 1] >> 2
    while (groupCursor < groupEnd) {
      const groupValue = groups[groupCursor]
      sum = (sum + groupValue) >>> 0
      if (groupValue > peak) peak = groupValue
      if (groupValue > 7) over7Total++
      groupCursor++
    }
    if (peak > globalPeak) {
      globalPeak = peak
      const thresholdClass = (((bandStart >>> 7) ^ 1) & 1) | (band > 0x15)
      const threshold = thresholdClass === 0 ? 0x10 : 8
      profile.monoExpansionBudgetThresholds[band] = over7Total * threshold
    } else if (peak < 3 || sum < RESIDUAL_BAND_ENERGY_THRESHOLDS[band]) {
      peak = 0
      sum = 0
    }
    sumRunning = (sumRunning + sum) >>> 0
    profile.bandMetrics[band + 1] = over7Total
    profile.scaleFactors[band] = peak
  }
  profile.sumRunning = sumRunning
  return profile
}

/**
 * Select the initial active-band prefix that can fit the residual budget.
 * @param {object} profile Measured residual source profile.
 * @param {number} scaleFactorBandLimit Profile-derived upper band limit.
 * @param {number} bitBudget Available layer bits.
 * @param {boolean} isMono Whether the layer has no stereo dependency.
 * @returns {number} Initial active band count.
 */
export function initialResidualBandLimit(
  profile,
  scaleFactorBandLimit,
  bitBudget,
  isMono
) {
  let bandLimit = scaleFactorBandLimit | 0
  if (isMono) {
    for (let band = 0; band < 32; band++) {
      const threshold = profile.monoExpansionBudgetThresholds[band]
      if (threshold >= 0 && bitBudget > threshold) {
        const expansionLimit = band > 0x1a ? Math.min(band + 2, 0x20) : 0x1c
        bandLimit = Math.max(bandLimit, expansionLimit)
      }
    }
  }
  return bandLimit
}
