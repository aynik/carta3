/** Carta3 Audio Codec - Pareto-safe layered residual refinement. */

import { AllocationWorkMut, AllocationWorkView } from '../state/allocation.js'
import {
  measureResidualBand,
  measureResidualModeNeighbors,
  measureResidualScaleNeighbors,
} from './residual.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import { buildMaskFromBandMeasures } from './distortion.js'

/**
 * @typedef {object} ResidualCost
 * @property {number} bits Exact coded cost.
 * @property {number} error Reconstruction error.
 * @property {number} [energy] Source energy, when measured.
 */

/**
 * @typedef {object} ResidualCandidate
 * @property {number} bits Exact coded cost.
 * @property {number} error Reconstruction error.
 * @property {i32} mode Proposed residual mode.
 * @property {i32} scaleFactor Proposed scale factor.
 */

/**
 * @typedef {object} ResidualMove
 * @property {i32} band Quantization-band index.
 * @property {i32} mode Proposed residual mode.
 * @property {i32} scaleFactor Proposed scale factor.
 * @property {ResidualCost} cost Measured reconstruction cost.
 * @property {number} bitDelta Change in coded bits from the incumbent.
 * @property {number} errorDelta Change in reconstruction error.
 * @property {number} maskedDelta Change in masked reconstruction error.
 */

/**
 * @typedef {object} ResidualQualityProfile
 * @property {Float64Array} sourceEnergy Per-band source energies.
 * @property {Float64Array} maskThresholds Per-band masking thresholds.
 */

/**
 * @typedef {object} ResidualProposal
 * @property {ResidualMove|null} donor Optional bit-donating move.
 * @property {ResidualMove} receiver Bit-receiving move.
 * @property {number} candidateBits Total residual bits after the exchange.
 * @property {number} rawErrorDelta Change in reconstruction error.
 * @property {number} normalizedErrorDelta Change in normalized error.
 * @property {number} maskedNmrDelta Change in masked error.
 * @property {boolean} strictlyImprovesAll Whether all three error measures improve.
 */

/**
 * Select a no-more-bits candidate that strictly lowers error.
 *
 * @param {ResidualCost} selected
 * @param {Array<ResidualCandidate|null>} candidates
 * @returns {ResidualCandidate|null}
 */
function chooseParetoImprovement(selected, candidates) {
  /** @type {ResidualCandidate|null} */
  let best = null
  for (const candidate of candidates) {
    if (
      !candidate ||
      candidate.bits > selected.bits ||
      candidate.error >= selected.error
    ) {
      continue
    }
    if (
      !best ||
      candidate.error < best.error ||
      (candidate.error === best.error && candidate.bits < best.bits)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * Enumerate feasible adjacent residual-mode moves.
 *
 * @param {object} allocation
 * @param {Array<Array<ResidualCost|null>>} modeCosts
 * @param {number} activeBands
 * @param {number} step
 * @param {number} slot
 * @param {ResidualCost[]} incumbentCosts
 * @param {ResidualQualityProfile} qualityProfile
 * @returns {ResidualMove[]}
 */
function modeMoves(
  allocation,
  modeCosts,
  activeBands,
  step,
  slot,
  incumbentCosts,
  qualityProfile
) {
  const moves = []
  for (let band = 0; band < activeBands; band++) {
    const mode = allocation.mode(band) + step
    const cost = modeCosts[band][slot]
    if (mode >= 1 && mode <= 7 && cost) {
      const incumbent = incumbentCosts[band]
      const errorDelta = cost.error - incumbent.error
      moves.push({
        band,
        mode,
        scaleFactor: allocation.scaleFactor(band),
        cost,
        bitDelta: cost.bits - incumbent.bits,
        errorDelta,
        maskedDelta: errorDelta / qualityProfile.maskThresholds[band],
      })
    }
  }
  return moves
}

/**
 * Normalize reconstruction error by nonzero source energy.
 *
 * @param {number} error
 * @param {number} energy
 * @returns {number}
 */
function normalizedError(error, energy) {
  return energy > 0 ? error / energy : 0
}

/**
 * Combine donor and receiver moves into one exact stereo proposal.
 *
 * @param {ResidualMove|null} donor
 * @param {ResidualMove} receiver
 * @param {ResidualCost[]} incumbentCosts
 * @param {ResidualQualityProfile} qualityProfile
 * @param {number} residualBits
 * @param {number} bitLimit
 * @param {number} maximumMaskedDelta Best accepted masked-noise delta, or zero.
 * @returns {ResidualProposal|null} Improving proposal, or null when it cannot be selected.
 */
function buildModeProposal(
  donor,
  receiver,
  incumbentCosts,
  qualityProfile,
  residualBits,
  bitLimit,
  maximumMaskedDelta
) {
  const receiverCost = incumbentCosts[receiver.band]
  /** @type {ResidualCost|null} */
  const donorCost = donor ? incumbentCosts[donor.band] : null
  const candidateBits =
    residualBits + receiver.bitDelta + (donor ? donor.bitDelta : 0)
  const maskedNmrDelta = receiver.maskedDelta + (donor ? donor.maskedDelta : 0)
  if (!(candidateBits <= bitLimit && maskedNmrDelta < maximumMaskedDelta)) {
    return null
  }
  const rawErrorDelta = receiver.errorDelta + (donor ? donor.errorDelta : 0)
  const normalizedErrorDelta =
    normalizedError(
      receiver.cost.error,
      qualityProfile.sourceEnergy[receiver.band]
    ) -
    normalizedError(
      receiverCost.error,
      qualityProfile.sourceEnergy[receiver.band]
    ) +
    (donor
      ? normalizedError(
          donor.cost.error,
          qualityProfile.sourceEnergy[donor.band]
        ) -
        normalizedError(
          donorCost.error,
          qualityProfile.sourceEnergy[donor.band]
        )
      : 0)
  return {
    donor,
    receiver,
    candidateBits,
    rawErrorDelta,
    normalizedErrorDelta,
    maskedNmrDelta,
    strictlyImprovesAll:
      rawErrorDelta < 0 && normalizedErrorDelta < 0 && maskedNmrDelta < 0,
  }
}

/**
 * Select the best masked-noise proposal within the fixed bit limit.
 *
 * @param {object} allocation
 * @param {number} activeBands
 * @param {ResidualCost[]} incumbentCosts
 * @param {Array<Array<ResidualCost|null>>} modeCosts
 * @param {number} residualBits
 * @param {number} bitLimit
 * @param {ResidualQualityProfile} qualityProfile
 * @returns {ResidualProposal|null}
 */
function selectModeProposal(
  allocation,
  activeBands,
  incumbentCosts,
  modeCosts,
  residualBits,
  bitLimit,
  qualityProfile
) {
  const donors = modeMoves(
    allocation,
    modeCosts,
    activeBands,
    -1,
    0,
    incumbentCosts,
    qualityProfile
  )
  const receivers = modeMoves(
    allocation,
    modeCosts,
    activeBands,
    1,
    1,
    incumbentCosts,
    qualityProfile
  )
  /** @type {ResidualProposal|null} */
  let selected = null
  for (const receiver of receivers) {
    for (let index = -1; index < donors.length; index++) {
      /** @type {ResidualMove|null} */
      const donor = index < 0 ? null : donors[index]
      if (donor && donor.band === receiver.band) continue
      const proposal = buildModeProposal(
        donor,
        receiver,
        incumbentCosts,
        qualityProfile,
        residualBits,
        bitLimit,
        selected ? selected.maskedNmrDelta : 0
      )
      if (proposal) selected = proposal
    }
  }
  return selected
}

/**
 * Measure source energy, peak, and width for every residual band.
 *
 * @param {Float32Array} spectrum Transformed source spectrum.
 * @returns {object[]} Thirty-two source measurement records.
 */
export function measureResidualBandMeasures(spectrum) {
  return Array.from({ length: 32 }, (_, band) => {
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    let energy = 0
    let peak = 0
    for (let coefficient = start; coefficient < end; coefficient++) {
      const sample = Math.fround(spectrum[coefficient])
      const square = sample * sample
      energy += square
      if (square > peak) peak = square
    }
    return { energy, peak, width: end - start }
  })
}

/**
 * Capture source evidence used to judge equal-rate mode exchange.
 *
 * @param {object} layer Transaction-local transformed layer state.
 * @returns {ResidualQualityProfile} Source energies and masking thresholds.
 */
export function createResidualQualityProfile(layer) {
  const bands = measureResidualBandMeasures(layer.spectrum)
  return {
    sourceEnergy: Float64Array.from(bands, (band) => band.energy),
    maskThresholds: buildMaskFromBandMeasures(bands),
  }
}

/**
 * Apply one layer's accepted syntax proposal.
 *
 * @param {ResidualProposal} proposal Accepted donor/receiver mode exchange.
 * @param {Int32Array} words Structured allocation word image.
 * @returns {number} Raw reconstruction-error delta.
 */
export function applyResidualProposal(proposal, words) {
  const allocation = new AllocationWorkMut(words)
  for (const move of [proposal.donor, proposal.receiver]) {
    if (!move) continue
    allocation.setMode(move.band, move.mode)
    allocation.setScaleFactor(move.band, move.scaleFactor)
  }
  return proposal.rawErrorDelta
}

/**
 * Refine one layer in place and optionally propose an equal-rate mode exchange.
 *
 * @param {object} layer Transaction-local transformed layer state.
 * @param {Int32Array} words Completed allocation word image.
 * @param {ResidualQualityProfile|null} [qualityProfile] Optional source quality evidence.
 * @returns {ResidualProposal|null} Optional detached mode proposal.
 */
export function refineResidual(layer, words, qualityProfile = null) {
  const allocation = new AllocationWorkView(words)
  /** @type {i32} */
  const activeBands = allocation.activeBandCountRaw
  if (activeBands < 0 || activeBands > 32) {
    throw new RangeError('Invalid ATRAC3 residual active-band count')
  }

  const stagedModes = new Int32Array(activeBands)
  const stagedScaleFactors = new Int32Array(activeBands)
  /** @type {ResidualCost[]} */
  const incumbentCosts = Array.from({ length: 32 }, () => ({
    bits: 0,
    error: 0,
  }))
  /** @type {Array<Array<ResidualCost|null>>|null} */
  const proposalModeCosts = qualityProfile
    ? Array.from({ length: 32 }, () => [null, null])
    : null
  /** @type {number} */
  let residualBits = activeBands * 3
  /** @type {number} */
  let bitLimit = activeBands * 3

  for (let band = 0; band < activeBands; band++) {
    const mode = allocation.mode(band)
    const scaleFactor = allocation.scaleFactor(band)
    stagedModes[band] = mode
    stagedScaleFactors[band] = scaleFactor
    /** @type {ResidualCost} */
    const selected = measureResidualBand(
      layer.spectrum,
      band,
      mode,
      scaleFactor
    )
    incumbentCosts[band] = selected
    residualBits += selected.bits
    bitLimit += selected.bits

    const probedModeCosts = qualityProfile
      ? measureResidualModeNeighbors(layer.spectrum, band, mode, scaleFactor)
      : null
    if (mode === 0) {
      if (proposalModeCosts) proposalModeCosts[band] = probedModeCosts
      continue
    }

    /** @type {ResidualCandidate[]} */
    const candidates = []
    /** @type {Array<ResidualCost|null>} */
    const modeCosts =
      probedModeCosts ??
      measureResidualModeNeighbors(layer.spectrum, band, mode, scaleFactor)
    for (let slot = 0; slot < 2; slot++) {
      const candidateMode = slot === 0 ? mode - 1 : mode + 1
      const cost = modeCosts[slot]
      if (
        candidateMode >= 1 &&
        candidateMode <= 7 &&
        cost?.bits === selected.bits
      ) {
        candidates.push({
          mode: candidateMode,
          scaleFactor,
          bits: cost.bits,
          error: cost.error,
        })
      }
    }
    for (const cost of measureResidualScaleNeighbors(
      layer.spectrum,
      band,
      mode,
      scaleFactor
    )) {
      if (cost) {
        candidates.push({
          mode,
          scaleFactor: cost.scaleFactor,
          bits: cost.bits,
          error: cost.error,
        })
      }
    }

    const improvement = chooseParetoImprovement(selected, candidates)
    if (improvement) {
      stagedModes[band] = improvement.mode
      stagedScaleFactors[band] = improvement.scaleFactor
      residualBits += improvement.bits - selected.bits
      incumbentCosts[band] = improvement
    }
    if (proposalModeCosts) {
      proposalModeCosts[band] = improvement
        ? measureResidualModeNeighbors(
            layer.spectrum,
            band,
            improvement.mode,
            improvement.scaleFactor
          )
        : probedModeCosts
    }
  }

  const mutable = new AllocationWorkMut(words)
  for (let band = 0; band < activeBands; band++) {
    mutable.setMode(band, stagedModes[band])
    mutable.setScaleFactor(band, stagedScaleFactors[band])
  }

  return qualityProfile
    ? selectModeProposal(
        new AllocationWorkView(words),
        activeBands,
        incumbentCosts,
        proposalModeCosts,
        residualBits,
        bitLimit,
        qualityProfile
      )
    : null
}
