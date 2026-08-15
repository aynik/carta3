/**
 * Carta3 Audio Codec - Staged residual allocation for 66/105 kbps layers.
 *
 * Allocation progresses from an energy-derived seed through budget correction,
 * exact residual pricing, bounded refinement, and a detached work image. No
 * frame bytes are emitted from this module.
 */

import { measureResidualBand } from './residual.js'
import { AllocationWorkMut } from './work.js'
import {
  BITS_PER_SPECTRUM_BY_MODE,
  QUANTIZATION_UNIT_OFFSETS,
  RESIDUAL_CLASS_BIT_SCALES,
  RESIDUAL_MODE_STEPS,
  SKIP_BITS_BY_MODE,
} from '../core/tables.js'
import { initialResidualBandLimit } from '../analysis/residual.js'
import {
  ALLOCATION_BAND_COUNT,
  PAIR_BLOCK_GAIN_COUNT_WORD,
  RESIDUAL_MODE_MAX,
  RESIDUAL_SEARCH_DONE as DONE,
  SCALE_FACTOR_INDEX_MAX,
  SPECTRUM_ALLOCATION_BITS_PER_BAND,
  SUBBAND_SAMPLES,
} from '../core/constants.js'

const SCALE_FACTOR_SENTINEL = SCALE_FACTOR_INDEX_MAX + 1
const HIGH_BAND_CORRECTION_START = 0x12
const CORRECTION_FIXED_POINT_SCALE = 0x400

/** Clamp an integer-like value to an inclusive range. */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Trim inactive tail bands while preserving a required minimum prefix. */
function activeBandPrefixLength(limit, minimum, isActive) {
  const floor = Math.min(minimum, limit)
  let count = limit
  while (count > floor && !isActive(count - 1)) count--
  return count
}

/** Return the coefficient width of one residual band. */
function bandWidth(band) {
  return QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
}

/** Return the scale-factor step associated with a residual mode. */
function stepByMode(mode) {
  if (mode <= 0) return 0
  return RESIDUAL_MODE_STEPS[Math.min(mode, RESIDUAL_MODE_MAX) - 1]
}

/** Return the fixed lower bound for one coded residual band. */
function minimumResidualBandBits(mode, width) {
  return 6 + (width >> 1) * RESIDUAL_CLASS_BIT_SCALES[mode - 1]
}

/** Exactly price one residual-band candidate. */
function countResidualBandBits(layer, band, mode, scaleFactor) {
  return measureResidualBand(layer.spectrum, band, mode, scaleFactor).bits
}

/** Count pair-block gain syntax reserved ahead of residual allocation. */
function countLayerGainBits(layer, blockCount) {
  let bits = 0
  for (let block = 0; block < blockCount; block++) {
    bits +=
      SPECTRUM_ALLOCATION_BITS_PER_BAND +
      layer.pairBlocks[block][PAIR_BLOCK_GAIN_COUNT_WORD] * 9
  }
  return bits
}

/** Estimate one residual band's cost before exact symbol pricing. */
function residualEstimatedBandBits(
  mode,
  scaleSelector,
  groupScaleFactors,
  band
) {
  const startGroup = QUANTIZATION_UNIT_OFFSETS[band] >> 2
  const endGroup = QUANTIZATION_UNIT_OFFSETS[band + 1] >> 2
  let bits = bandWidth(band) * BITS_PER_SPECTRUM_BY_MODE[mode] + 0x3c
  const threshold = scaleSelector - stepByMode(mode)
  const skip = SKIP_BITS_BY_MODE[mode]
  for (let group = startGroup; group < endGroup; group++) {
    if (groupScaleFactors[group] < threshold) bits -= skip
  }
  return bits
}

/** Create the semantic allocation state refined before word-image commit. */
function createAllocation(scaleFactors, bandLimit, blockCount) {
  return {
    modes: new Int32Array(ALLOCATION_BAND_COUNT),
    scaleFactors: Int32Array.from(scaleFactors),
    activeBands: bandLimit,
    blockCount,
  }
}

/** Create the first mode/scale proposal after fixed syntax reservations. */
function initializeResidualModes(layer, profile, bitBudget, bandLimit) {
  let modeShift = 10
  if (bitBudget * 2 < profile.bandMetrics[bandLimit] * 0x0c) modeShift = 0x0b
  const coefficientCount = QUANTIZATION_UNIT_OFFSETS[bandLimit]
  const blockCount = Math.trunc(
    (coefficientCount + SUBBAND_SAMPLES - 1) / SUBBAND_SAMPLES
  )
  const allocation = createAllocation(
    profile.scaleFactors,
    bandLimit,
    blockCount
  )
  const availableBits =
    bitBudget -
    countLayerGainBits(layer, blockCount) -
    bandLimit * SPECTRUM_ALLOCATION_BITS_PER_BAND
  const metrics = Int32Array.from(profile.bandMetrics)
  const sumTotal = profile.sumRunning | 0
  for (let band = 0; band < bandLimit; band++) {
    let mode = 0
    let metric = allocation.scaleFactors[band]
    if (metric > 2) {
      metric = (Math.imul(metric, 0x100) - sumTotal) | 0
      mode = clamp(metric >> modeShift, 1, RESIDUAL_MODE_MAX)
    }
    metrics[band + 1] = metric
    allocation.modes[band] = mode
  }
  return { modeShift, availableBits, allocation, metrics }
}

/** Prune incoherent seed bands and estimate the remaining payload. */
function planSeedPruning(allocation, metrics, groups, bandLimit) {
  const lastBand = bandLimit - 1
  let estimatedBits = 0
  let specsTotal = 0
  let specsMode7 = 0
  for (let band = 0; band < bandLimit; band++) {
    const mode = allocation.modes[band]
    if (mode === 0) continue
    const coherentWithPrevious =
      band < 2 || metrics[band] - 0x0f00 <= metrics[band + 1]
    const coherentWithNext =
      band >= lastBand || metrics[band + 2] - 0x1400 <= metrics[band + 1]
    if (!coherentWithPrevious || !coherentWithNext) {
      allocation.modes[band] = 0
      continue
    }
    const width = bandWidth(band)
    specsTotal += width
    if (mode === 7) specsMode7 += width
    estimatedBits += residualEstimatedBandBits(
      mode,
      allocation.scaleFactors[band],
      groups,
      band
    )
  }
  return {
    activeBands: activeBandPrefixLength(
      bandLimit,
      1,
      (band) => allocation.modes[band] !== 0
    ),
    estimatedBits,
    adjustableSpecs: specsTotal - specsMode7,
  }
}

/** Raise scale factors for bands affected by a negative budget correction. */
function applyNegativeCorrectionScaleFactors(
  allocation,
  metrics,
  correction,
  activeBands
) {
  for (let band = 0; band < HIGH_BAND_CORRECTION_START; band++) {
    if (
      correction + metrics[band + 1] < 0 &&
      allocation.scaleFactors[band] <= 0x3e
    ) {
      allocation.scaleFactors[band]++
    }
  }
  for (let band = HIGH_BAND_CORRECTION_START; band < activeBands; band++) {
    const correctedMetric = correction + metrics[band + 1]
    if (correctedMetric < CORRECTION_FIXED_POINT_SCALE) {
      const scaleFactor =
        allocation.scaleFactors[band] -
        ((correctedMetric - CORRECTION_FIXED_POINT_SCALE) >> 10)
      allocation.scaleFactors[band] = Math.min(
        scaleFactor,
        SCALE_FACTOR_INDEX_MAX
      )
    }
  }
}

/** Derive the global mode correction from target and estimated costs. */
function deriveBudgetCorrection(
  allocation,
  metrics,
  modeShift,
  totalAvailable,
  estimate
) {
  const target10 = totalAvailable * 10
  if (target10 > estimate.estimatedBits && estimate.adjustableSpecs === 0) {
    return 0
  }
  const target = totalAvailable > 599 ? totalAvailable * 9 : target10
  let correction =
    estimate.adjustableSpecs !== 0
      ? Math.trunc(
          ((target - estimate.estimatedBits) * CORRECTION_FIXED_POINT_SCALE) /
            (estimate.adjustableSpecs * 10)
        )
      : 0
  if (modeShift === 10 && target - estimate.estimatedBits < 0) {
    correction += correction >> 3
    metrics[1] -= correction
    metrics[2] -= Math.imul(correction, 0xbc) >> 8
    for (let band = 2; band < 8; band++) {
      metrics[band + 1] -= Math.imul(correction, 0x61) >> 8
    }
    for (let band = 8; band < HIGH_BAND_CORRECTION_START; band++) {
      metrics[band + 1] -= Math.imul(correction, 0x4a) >> 8
    }
    applyNegativeCorrectionScaleFactors(
      allocation,
      metrics,
      correction,
      estimate.activeBands
    )
  }
  return correction
}

/** Refund gain headers for inactive trailing transform blocks. */
function trimBlockTail(layer, allocation, stereoMode, isMono) {
  if (!isMono && (stereoMode & 7) !== 7) return 0
  const initial = allocation.blockCount
  let last = initial - 1
  if (last >= 1) {
    for (;;) {
      if (layer.pairBlocks[last][PAIR_BLOCK_GAIN_COUNT_WORD] !== 0) break
      last--
      if (last < 1) break
    }
  }
  allocation.blockCount = last + 1
  return (initial - allocation.blockCount) * SPECTRUM_ALLOCATION_BITS_PER_BAND
}

/** Correct estimated mode costs into a budget-converged allocation seed. */
function convergeResidualBudget(
  layer,
  profile,
  prepared,
  bandLimit,
  stereoMode,
  isMono
) {
  const { allocation, metrics, modeShift } = prepared
  let availableBits = prepared.availableBits
  const estimate = planSeedPruning(
    allocation,
    metrics,
    profile.groupScaleFactors,
    bandLimit
  )
  availableBits +=
    (bandLimit - estimate.activeBands) * SPECTRUM_ALLOCATION_BITS_PER_BAND
  allocation.activeBands = estimate.activeBands
  const totalAvailable =
    availableBits + trimBlockTail(layer, allocation, stereoMode, isMono)
  const correction = deriveBudgetCorrection(
    allocation,
    metrics,
    modeShift,
    totalAvailable,
    estimate
  )
  let remaining10 = totalAvailable * 10
  for (let band = allocation.activeBands - 1; band >= 0; band--) {
    if (allocation.modes[band] !== 0) {
      const mode = clamp(
        (correction + metrics[band + 1]) >> modeShift,
        1,
        RESIDUAL_MODE_MAX
      )
      allocation.modes[band] = mode
      remaining10 -= residualEstimatedBandBits(
        mode,
        allocation.scaleFactors[band],
        profile.groupScaleFactors,
        band
      )
      metrics[band + 1] = remaining10
    }
  }
  return { allocation, metrics, totalAvailable }
}

/** Reprice the converged seed exactly and initialize bounded refinement state. */
function seedResidualRefinement(layer, converged) {
  const { allocation, metrics } = converged
  let totalAvailable = converged.totalAvailable
  let activeBands = allocation.activeBands
  const selectKeys = new Int32Array(ALLOCATION_BAND_COUNT)
  const bandBits = new Int32Array(ALLOCATION_BAND_COUNT)
  let bitsUsed = 0
  for (let band = 0; band < activeBands; band++) {
    const mode = allocation.modes[band]
    if (mode === 0) {
      selectKeys[band] = DONE
      continue
    }
    const width = bandWidth(band)
    if ((totalAvailable - bitsUsed) * 2 - 0x10 < width) {
      allocation.modes[band] = 0
      selectKeys[band] = DONE
      continue
    }
    const score = metrics[band + 1] - bitsUsed * 10
    if (score >= 0x0fa1 && allocation.modes[band] < RESIDUAL_MODE_MAX) {
      allocation.modes[band]++
    } else if (score < 300 && band !== 0) {
      if (allocation.modes[band] > 1) allocation.modes[band]--
      else if (allocation.scaleFactors[band] < SCALE_FACTOR_INDEX_MAX) {
        allocation.scaleFactors[band]++
      }
    }
    const bits = countResidualBandBits(
      layer,
      band,
      allocation.modes[band],
      allocation.scaleFactors[band]
    )
    bandBits[band] = bits
    if (bits === minimumResidualBandBits(allocation.modes[band], width)) {
      allocation.modes[band] = 0
      selectKeys[band] = DONE
    } else {
      selectKeys[band] = allocation.scaleFactors[band]
      bitsUsed += bits
    }
  }
  const previousActiveBands = activeBands
  activeBands = activeBandPrefixLength(
    activeBands,
    1,
    (band) => allocation.modes[band] !== 0
  )
  totalAvailable +=
    (previousActiveBands - activeBands) * SPECTRUM_ALLOCATION_BITS_PER_BAND
  allocation.activeBands = activeBands
  return {
    allocation,
    selectKeys,
    bandBits,
    budgetUsed: 0,
    budgetLimit: totalAvailable,
    slack: totalAvailable - bitsUsed,
  }
}

/** Determine tail bands that can be removed to fit an overflowing proposal. */
function selectOverflowTailTrim(execution, band) {
  const previousActiveBands = execution.allocation.activeBands
  const activeBands = activeBandPrefixLength(
    previousActiveBands,
    band + 1,
    (tail) =>
      execution.allocation.modes[tail] !== 0 &&
      execution.selectKeys[tail] === DONE
  )
  return { previousActiveBands, activeBands }
}

/** Fit one exactly priced band into the evolving refinement budget. */
function fitRefinementBand(layer, band, execution) {
  const allocation = execution.allocation
  const fromMode = allocation.modes[band]
  let candidateMode = fromMode
  let candidateScaleFactor = allocation.scaleFactors[band]
  let candidateBits = execution.bandBits[band]
  let proposalLimit = execution.budgetLimit
  let tailTrim = null
  let slackDelta = 0

  if (execution.budgetUsed + candidateBits > proposalLimit) {
    tailTrim = selectOverflowTailTrim(execution, band)
    proposalLimit +=
      (tailTrim.previousActiveBands - tailTrim.activeBands) *
      SPECTRUM_ALLOCATION_BITS_PER_BAND
    if (execution.budgetUsed + candidateBits > proposalLimit) {
      const minimumBits = minimumResidualBandBits(
        candidateMode,
        bandWidth(band)
      )
      for (
        let scaleFactor = candidateScaleFactor + 1;
        scaleFactor <= SCALE_FACTOR_SENTINEL;
        scaleFactor++
      ) {
        candidateScaleFactor = scaleFactor
        if (
          scaleFactor === SCALE_FACTOR_SENTINEL ||
          candidateBits <= minimumBits
        ) {
          break
        }
        candidateBits = countResidualBandBits(
          layer,
          band,
          candidateMode,
          scaleFactor
        )
        if (execution.budgetUsed + candidateBits <= proposalLimit) break
      }
    }
  } else {
    const width = bandWidth(band)
    const budgetRemaining = execution.budgetLimit - execution.budgetUsed
    if (
      candidateMode < RESIDUAL_MODE_MAX &&
      minimumResidualBandBits(candidateMode + 1, width) - 6 <
        budgetRemaining - 7
    ) {
      let targetMode = candidateMode + 1
      if (targetMode < RESIDUAL_MODE_MAX && execution.slack > width * 4) {
        targetMode = candidateMode + 2
      }
      const maxAffordable = candidateBits + Math.max(execution.slack, 0)
      if (minimumResidualBandBits(targetMode, width) <= maxAffordable) {
        const targetBits = countResidualBandBits(
          layer,
          band,
          targetMode,
          candidateScaleFactor
        )
        if (targetBits <= maxAffordable) {
          slackDelta -= targetBits - candidateBits
          candidateMode = targetMode
          candidateBits = targetBits
        }
      }
    }
  }

  execution.selectKeys[band] = DONE
  if (tailTrim) {
    for (
      let tail = tailTrim.activeBands;
      tail < tailTrim.previousActiveBands;
      tail++
    ) {
      allocation.modes[tail] = 0
      execution.selectKeys[tail] = DONE
    }
    execution.budgetLimit +=
      (tailTrim.previousActiveBands - tailTrim.activeBands) *
      SPECTRUM_ALLOCATION_BITS_PER_BAND
    allocation.activeBands = tailTrim.activeBands
  }
  execution.slack += slackDelta
  if (execution.budgetUsed + candidateBits <= execution.budgetLimit) {
    allocation.modes[band] = candidateMode
    allocation.scaleFactors[band] = candidateScaleFactor
    execution.budgetUsed += candidateBits
  } else {
    execution.slack += candidateBits
    allocation.modes[band] = 0
    allocation.scaleFactors[band] = candidateScaleFactor
  }
}

/** Fit every active band while preserving the layer's exact bit limit. */
function refineResidualAllocation(layer, bitBudget, isMono, converged) {
  const execution = seedResidualRefinement(layer, converged)
  const activeBands = execution.allocation.activeBands
  if (
    isMono &&
    layer.previousPairToneEntryCount +
      layer.pairBlocks[0][PAIR_BLOCK_GAIN_COUNT_WORD] !==
      0
  ) {
    for (let band = 0; band < Math.min(activeBands, 5); band++) {
      if (execution.selectKeys[band] !== DONE) {
        execution.selectKeys[band] = Math.max(
          execution.selectKeys[band],
          SCALE_FACTOR_SENTINEL
        )
      }
    }
  }
  const rankedBands = Array.from({ length: activeBands }, (_, band) => band)
    .filter((band) => execution.selectKeys[band] !== DONE)
    .sort(
      (left, right) => execution.selectKeys[right] - execution.selectKeys[left]
    )
  for (const band of rankedBands) {
    if (execution.selectKeys[band] !== DONE) {
      fitRefinementBand(layer, band, execution)
    }
  }
  return {
    allocation: execution.allocation,
    codedBits: bitBudget - (execution.budgetLimit - execution.budgetUsed),
  }
}

/** Publish a completed candidate into the detached allocation word image. */
function commitResidualAllocation(layer, allocation, work) {
  const target = new AllocationWorkMut(work)
  target.setActiveBandCount(allocation.activeBands)
  target.setBlockCount(allocation.blockCount)
  target.clearToneSyntax()
  for (let band = 0; band < allocation.activeBands; band++) {
    target.setMode(band, allocation.modes[band])
    target.setScaleFactor(band, allocation.scaleFactors[band])
  }
  target.copyResidualSpectrumBits(layer.spectrum)
}

/**
 * Lower one transformed layer into the exact allocation work image.
 * @param {object} layer Transaction-local transformed layer state.
 * @param {object} sourceProfile Measured residual source evidence.
 * @param {number} scaleFactorBandLimit Profile-derived active-band ceiling.
 * @param {number} bitBudget Exact residual syntax budget.
 * @param {number} stereoMode Prior shared stereo selector.
 * @param {Int32Array} work Caller-owned structured allocation word image.
 * @returns {number} Exact number of coded residual bits.
 */
export function allocateLayeredResidual(
  layer,
  sourceProfile,
  scaleFactorBandLimit,
  bitBudget,
  stereoMode,
  work
) {
  const isMono = layer.stereoFlag === 0
  const bandLimit = initialResidualBandLimit(
    sourceProfile,
    scaleFactorBandLimit,
    bitBudget,
    isMono
  )
  const prepared = initializeResidualModes(
    layer,
    sourceProfile,
    bitBudget,
    bandLimit
  )
  const converged = convergeResidualBudget(
    layer,
    sourceProfile,
    prepared,
    bandLimit,
    stereoMode,
    isMono
  )
  const refined = refineResidualAllocation(layer, bitBudget, isMono, converged)
  commitResidualAllocation(layer, refined.allocation, work)
  return refined.codedBits
}
