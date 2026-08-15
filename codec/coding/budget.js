/**
 * Carta3 Audio Codec - Shared-budget selection for 66 kbps joint stereo.
 *
 * Detached candidates are allocated and destination-free priced over a bounded
 * split frontier. Frame offsets and byte publication remain pipeline concerns.
 */

import { AllocationWorkView } from './work.js'
import { measureResidualBand } from './residual.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import { allocateLayeredResidual } from './layered.js'
import { buildMaskFromBandMeasures } from '../analysis/perceptual.js'
import { measureResidualBandMeasures } from './finalization.js'
import { measureResidualSource } from '../analysis/residual.js'
import { MIN_SHIFT, SPLIT_EXPLORE_SPAN } from '../core/constants.js'
import { BUDGET_SHIFT_DELTAS } from '../core/tables.js'

/** Return the largest absolute coefficient in one residual band. */
function bandMaximum(spectrum, band) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  let maximum = 0
  for (let coefficient = start; coefficient < end; coefficient++) {
    const magnitude = Math.abs(spectrum[coefficient])
    if (Number.isNaN(maximum) || maximum < magnitude) maximum = magnitude
  }
  return maximum
}

/**
 * Compute the energy-dependent primary joint-layer seed budget.
 * @param {object[]} layers Two transformed layered-channel states.
 * @param {number} bytesPerLayer Nominal half-frame byte span.
 * @param {object} jointStereo Selected joint-stereo hints and history.
 * @param {number} candidateBandLimit Shared active-band ceiling.
 * @returns {number} Seed bit budget for the primary layer.
 */
export function jointPrimaryBitBudget(
  layers,
  bytesPerLayer,
  jointStereo,
  candidateBandLimit
) {
  let primaryBand =
    Math.min(layers[0].scaleFactorBandLimit, candidateBandLimit) - 1
  primaryBand = Math.min(primaryBand, 0x12)
  let primaryEnergy = 0
  for (let band = primaryBand; band >= 0; band--) {
    const width =
      QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
    primaryEnergy += bandMaximum(layers[0].spectrum, band) * width
  }

  let secondaryEnergy = 0
  const secondaryBandLimit = Math.min(
    layers[1].scaleFactorBandLimit,
    candidateBandLimit
  )
  for (let band = 0; band < secondaryBandLimit; band++) {
    const width =
      QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
    secondaryEnergy += bandMaximum(layers[1].spectrum, band) * width
  }

  const outputDefault = layers[1].stereoFlag | 0
  const targetBudget = (bytesPerLayer << 4) - 0x3b
  const mode = jointStereo.absoluteModeHints[0]
  let scaledSecondaryEnergy = secondaryEnergy + secondaryEnergy
  if (mode !== 3) scaledSecondaryEnergy += scaledSecondaryEnergy
  if (
    Number.isNaN(scaledSecondaryEnergy) ||
    scaledSecondaryEnergy < 1 ||
    (mode !== 3 && scaledSecondaryEnergy < 4)
  ) {
    return targetBudget
  }
  if (scaledSecondaryEnergy > 0) {
    const interpolation = Math.max(
      0,
      Math.min(1, (primaryEnergy / scaledSecondaryEnergy - 3) / 9)
    )
    const shift = Math.trunc((targetBudget - outputDefault) * interpolation)
    return outputDefault + (shift & ~7)
  }
  return targetBudget
}

/** Build one masking curve from the energy evidence of both source layers. */
function mergedSourceMask(layers) {
  const sourceBands = layers.map((layer) =>
    measureResidualBandMeasures(layer.spectrum)
  )
  const merged = Array.from({ length: 32 }, (_, band) => ({
    energy: sourceBands[0][band].energy + sourceBands[1][band].energy,
    peak: Math.max(sourceBands[0][band].peak, sourceBands[1][band].peak),
    width: Math.max(sourceBands[0][band].width, sourceBands[1][band].width),
  }))
  return buildMaskFromBandMeasures(merged)
}

/** Measure per-band error for one detached allocation image. */
function reconstructionNoise(layer, words) {
  const allocation = new AllocationWorkView(words)
  const activeBands = allocation.activeBandCount
  return Float64Array.from({ length: 32 }, (_, band) => {
    const mode = band < activeBands ? allocation.mode(band) : 0
    const scaleFactor = band < activeBands ? allocation.scaleFactor(band) : 0
    return measureResidualBand(layer.spectrum, band, mode, scaleFactor).error
  })
}

/** Sum both layer errors after normalization by the shared masking curve. */
function maskedDistortion(mask, primaryNoise, secondaryNoise) {
  let distortion = 0
  for (let band = 0; band < 32; band++) {
    distortion += (primaryNoise[band] + secondaryNoise[band]) / mask[band]
  }
  return distortion
}

/** Expand configured split deltas into a de-duplicated bounded frontier. */
function uniqueShiftFrontier(seed) {
  const frontier = []
  for (const delta of BUDGET_SHIFT_DELTAS) {
    const candidate = Math.max(MIN_SHIFT, seed + delta)
    if (!frontier.includes(candidate)) frontier.push(candidate)
  }
  return frontier
}

/**
 * Probe the bounded shared-budget frontier and retain only the best detached
 * allocation pair. Candidate emission is exact pricing, not frame publication.
 *
 * @param {object} input Detached layer state and reusable allocation storage.
 * @param {object[]} input.layers Two transformed layer states.
 * @param {Int32Array[]} input.selectedWorks Selected allocation destinations.
 * @param {Int32Array[]} input.candidateWorks Reusable candidate images.
 * @param {object[]} input.residualSourceProfiles Reusable analysis profiles.
 * @param {object} input.jointStereo Selected joint-stereo history and hints.
 * @param {number} input.bytesPerFrame Complete shared frame size.
 * @param {function(object, Int32Array, object): number} input.measureLayerBits
 * Exact syntax counter supplied by the pipeline's I/O boundary.
 * @returns {object} Selected primary/secondary budgets, split, and distortion.
 */
export function selectJointLayerBudget({
  layers,
  selectedWorks,
  candidateWorks,
  residualSourceProfiles,
  jointStereo,
  bytesPerFrame,
  measureLayerBits,
}) {
  const bytesPerLayer = bytesPerFrame / 2
  const frameBytes = bytesPerLayer * 2
  const frameBits = frameBytes * 8
  const bandLimit = Math.max(
    layers[0].scaleFactorBandLimit,
    layers[1].scaleFactorBandLimit
  )
  const seed = jointPrimaryBitBudget(
    layers,
    bytesPerLayer,
    jointStereo,
    bandLimit
  )
  const profiles = layers.map((layer, index) =>
    measureResidualSource(layer, residualSourceProfiles[index])
  )
  const mask = mergedSourceMask(layers)
  const stereoMode = jointStereo.previousOutputSelector
  let selected = null

  for (const primaryBudget of uniqueShiftFrontier(seed)) {
    if (selected && primaryBudget < seed - SPLIT_EXPLORE_SPAN) break
    candidateWorks[0].fill(0)
    allocateLayeredResidual(
      layers[0],
      profiles[0],
      Math.min(layers[0].scaleFactorBandLimit, bandLimit),
      primaryBudget,
      stereoMode,
      candidateWorks[0]
    )
    const primaryBits = measureLayerBits(layers[0], candidateWorks[0], {
      previousOutput: stereoMode,
      gainSelectors: jointStereo.absoluteModeHints,
    })
    const split = Math.ceil(primaryBits / 8)
    if (split >= frameBytes) continue

    const secondaryBudget = Math.max(MIN_SHIFT, (frameBytes - split) * 8 - 0x1b)
    candidateWorks[1].fill(0)
    allocateLayeredResidual(
      layers[1],
      profiles[1],
      Math.min(layers[1].scaleFactorBandLimit, bandLimit),
      secondaryBudget,
      stereoMode,
      candidateWorks[1]
    )
    const secondaryBits = measureLayerBits(layers[1], candidateWorks[1], {
      previousOutput: stereoMode,
      gainSelectors: jointStereo.absoluteModeHints,
    })
    const secondaryEnd = split * 8 + secondaryBits
    if (secondaryEnd > frameBits) continue

    const distortion = maskedDistortion(
      mask,
      reconstructionNoise(layers[0], candidateWorks[0]),
      reconstructionNoise(layers[1], candidateWorks[1])
    )
    if (!selected || distortion < selected.distortion) {
      selectedWorks[0].set(candidateWorks[0])
      selectedWorks[1].set(candidateWorks[1])
      selected = { primaryBudget, secondaryBudget, split, distortion }
    }
  }

  if (!selected) {
    throw new RangeError('No feasible ATRAC3 joint-stereo layer split')
  }
  layers[0].bitBudget = seed
  return selected
}
