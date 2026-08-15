/** Carta3 Audio Codec - Pareto-safe layered residual refinement. */

import { AllocationWorkMut, AllocationWorkView } from './work.js'
import {
  measureResidualBand,
  measureResidualModeNeighbors,
  measureResidualScaleNeighbors,
} from './residual.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../core/tables.js'
import { buildMaskFromBandMeasures } from '../analysis/perceptual.js'

/**
 * Select a no-more-bits candidate that strictly lowers error.
 *
 * @param {object|null} selected
 * @param {object[]} candidates
 * @returns {object|null}
 */
function chooseParetoImprovement(selected, candidates) {
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
 * @returns {object} Source energies and masking thresholds.
 */
export function createResidualQualityProfile(layer) {
  const bands = measureResidualBandMeasures(layer.spectrum)
  return {
    sourceEnergy: Float64Array.from(bands, (band) => band.energy),
    maskThresholds: buildMaskFromBandMeasures(bands),
  }
}

/**
 * Enumerate feasible adjacent residual-mode moves.
 *
 * @param {object} allocation
 * @param {object[][]} modeCosts
 * @param {number} activeBands
 * @param {number} step
 * @param {number} slot
 * @returns {object[]}
 */
function modeMoves(allocation, modeCosts, activeBands, step, slot) {
  const moves = []
  for (let band = 0; band < activeBands; band++) {
    const mode = allocation.mode(band) + step
    const cost = modeCosts[band][slot]
    if (mode >= 1 && mode <= 7 && cost) {
      moves.push({
        band,
        mode,
        scaleFactor: allocation.scaleFactor(band),
        cost,
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
 * Combine donor and receiver moves into one exact stereo transaction.
 *
 * @param {object|null} donor
 * @param {object} receiver
 * @param {object[]} incumbentCosts
 * @param {object} qualityProfile
 * @param {number} residualBits
 * @returns {object|null}
 */
function buildModeTransaction(
  donor,
  receiver,
  incumbentCosts,
  qualityProfile,
  residualBits
) {
  const receiverCost = incumbentCosts[receiver.band]
  const receiverBitDelta = receiver.cost.bits - receiverCost.bits
  const receiverErrorDelta = receiver.cost.error - receiverCost.error
  const donorCost = donor ? incumbentCosts[donor.band] : null
  const donorBitDelta = donor ? donor.cost.bits - donorCost.bits : 0
  const donorErrorDelta = donor ? donor.cost.error - donorCost.error : 0
  const rawErrorDelta = receiverErrorDelta + donorErrorDelta
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
  const maskedNmrDelta =
    receiverErrorDelta / qualityProfile.maskThresholds[receiver.band] +
    (donor ? donorErrorDelta / qualityProfile.maskThresholds[donor.band] : 0)
  return {
    donor,
    receiver,
    candidateBits: residualBits + receiverBitDelta + donorBitDelta,
    rawErrorDelta,
    normalizedErrorDelta,
    maskedNmrDelta,
    strictlyImprovesAll:
      rawErrorDelta < 0 && normalizedErrorDelta < 0 && maskedNmrDelta < 0,
  }
}

/**
 * Select the best masked-noise transaction within the fixed bit limit.
 *
 * @param {object} allocation
 * @param {number} activeBands
 * @param {object[]} incumbentCosts
 * @param {object[][]} modeCosts
 * @param {number} residualBits
 * @param {number} bitLimit
 * @param {object} qualityProfile
 * @returns {object|null}
 */
function selectModeTransaction(
  allocation,
  activeBands,
  incumbentCosts,
  modeCosts,
  residualBits,
  bitLimit,
  qualityProfile
) {
  const donors = modeMoves(allocation, modeCosts, activeBands, -1, 0)
  const receivers = modeMoves(allocation, modeCosts, activeBands, 1, 1)
  let selected = null
  for (const receiver of receivers) {
    const candidates = [
      null,
      ...donors.filter((move) => move.band !== receiver.band),
    ]
    for (const donor of candidates) {
      const transaction = buildModeTransaction(
        donor,
        receiver,
        incumbentCosts,
        qualityProfile,
        residualBits
      )
      if (
        transaction.candidateBits <= bitLimit &&
        transaction.maskedNmrDelta < 0 &&
        (!selected || transaction.maskedNmrDelta < selected.maskedNmrDelta)
      ) {
        selected = transaction
      }
    }
  }
  return selected
}

/**
 * Apply one layer's selected syntax exchange as a single transaction.
 *
 * @param {object} transaction Selected donor/receiver mode exchange.
 * @param {Int32Array} words Structured allocation word image.
 * @returns {number} Raw reconstruction-error delta.
 */
export function applyResidualModeTransaction(transaction, words) {
  const allocation = new AllocationWorkMut(words)
  for (const move of [transaction.donor, transaction.receiver]) {
    if (!move) continue
    allocation.setMode(move.band, move.mode)
    allocation.setScaleFactor(move.band, move.scaleFactor)
  }
  return transaction.rawErrorDelta
}

/**
 * Reprice one layer's adjacent syntax candidates, then optionally propose a
 * quality-safe equal-rate mode exchange for the frame-level stereo stage.
 *
 * @param {object} layer Transaction-local transformed layer state.
 * @param {Int32Array} words Completed allocation word image.
 * @param {object|null} [qualityProfile] Optional source quality evidence.
 * @returns {object} Error delta and optional detached mode transaction.
 */
export function finalizeResidualPareto(layer, words, qualityProfile = null) {
  const allocation = new AllocationWorkView(words)
  const activeBands = allocation.activeBandCountRaw
  if (activeBands < 0 || activeBands > 32) {
    throw new RangeError('Invalid ATRAC3 residual active-band count')
  }

  const stagedModes = new Int32Array(activeBands)
  const stagedScaleFactors = new Int32Array(activeBands)
  const incumbentCosts = Array.from({ length: 32 }, () => ({
    bits: 0,
    error: 0,
  }))
  const transactionModeCosts = qualityProfile
    ? Array.from({ length: 32 }, () => [null, null])
    : null
  let residualBits = activeBands * 3
  let bitLimit = activeBands * 3
  let errorDelta = 0

  for (let band = 0; band < activeBands; band++) {
    const mode = allocation.mode(band)
    const scaleFactor = allocation.scaleFactor(band)
    stagedModes[band] = mode
    stagedScaleFactors[band] = scaleFactor
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
      if (transactionModeCosts) transactionModeCosts[band] = probedModeCosts
      continue
    }

    const candidates = []
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
      errorDelta += improvement.error - selected.error
      incumbentCosts[band] = improvement
    }
    if (transactionModeCosts) {
      transactionModeCosts[band] = improvement
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

  return {
    errorDelta,
    modeTransaction: qualityProfile
      ? selectModeTransaction(
          new AllocationWorkView(words),
          activeBands,
          incumbentCosts,
          transactionModeCosts,
          residualBits,
          bitLimit,
          qualityProfile
        )
      : null,
  }
}
