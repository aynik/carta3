/** Carta3 Audio Codec - Layered joint-stereo mode and ratio analysis. */

import {
  FALLBACK_RATIO_BITS,
  LOWER_RATIO_BOUND_BITS,
  MAX_RATIO_STEP_BITS,
  RATIO_MAPPING_SCALE_BITS,
  UNITY_BITS,
  UPPER_RATIO_BOUND_BITS,
} from '../core/constants.js'
import {
  float32Add,
  float32FromBits,
  float32Subtract,
  float32ToBits,
  float64FromBits,
} from '../utils.js'

const unity = float32FromBits(UNITY_BITS)
const fallbackRatio = float32FromBits(FALLBACK_RATIO_BITS)
const maxRatioStep = float64FromBits(MAX_RATIO_STEP_BITS)
const lowerRatioBound = float64FromBits(LOWER_RATIO_BOUND_BITS)
const upperRatioBound = float32FromBits(UPPER_RATIO_BOUND_BITS)
const ratioMappingScale = float32FromBits(RATIO_MAPPING_SCALE_BITS)

/** Create four detached zeroed left/right energy records. */
function zeroEnergies() {
  return Array.from({ length: 4 }, () => ({ left: 0, right: 0 }))
}

/** Deep-copy four left/right energy records. */
function copyEnergies(source) {
  return source.map(({ left, right }) => ({ left, right }))
}

/**
 * Select four interleaved conversion modes and advance energy carry.
 * @param {object} state Transaction-staged joint-stereo state.
 * Detached joint-stereo transaction.
 * @param {object[]} layers Two analyzed layer spectra.
 * @returns {object} The updated detached state.
 */
export function selectJointStereoModes(state, layers) {
  if (
    layers.length < 2 ||
    layers[0].spectrum.length < 1024 ||
    layers[1].spectrum.length < 1024
  ) {
    throw new RangeError('ATRAC3 joint stereo requires two 1024-line layers')
  }
  const neutralScale = Math.fround(19.697716)
  const primaryScale = Math.fround(2304)
  const secondaryScale = Math.fround(96)
  const silenceThreshold = Math.fround(4791991795712)
  const frameBias = Math.fround(0.1)
  const slotBias = Math.fround(0)
  const decay = Math.fround(16)
  const selectorRatioScale = Math.fround(1)
  const selectorScale = Math.fround(14)
  const selectorOffset = Math.fround(12582912)
  const energies = zeroEnergies()
  const slotModes = Int32Array.from(state.slotModes)
  const hints = Int32Array.from(state.absoluteModeHints)
  let rightFrameEnergy = frameBias
  let leftFrameEnergy = frameBias

  for (let slot = 0; slot < 4; slot++) {
    let leftEnergy = slotBias
    let rightEnergy = slotBias
    for (let index = slot; index < 1024; index += 4) {
      leftEnergy += Math.abs(layers[0].spectrum[index])
      rightEnergy += Math.abs(layers[1].spectrum[index])
    }
    energies[slot].left = Math.fround(leftEnergy)
    energies[slot].right = Math.fround(rightEnergy)
    let mode = 3
    let priorHint = state.slotModes[slot]
    let leftScale = neutralScale
    let rightScale = neutralScale
    if (slot < state.ratioScaledSlotCount) {
      if (priorHint === 0) {
        leftScale = secondaryScale
        rightScale = primaryScale
      } else if (priorHint === 1) {
        leftScale = primaryScale
        rightScale = secondaryScale
      } else {
        leftScale = primaryScale
        rightScale = primaryScale
      }
    }
    if (leftScale * leftEnergy >= rightEnergy) {
      if (rightScale * rightEnergy >= leftEnergy) {
        if (
          Number.isNaN(leftEnergy + rightEnergy) ||
          leftEnergy + rightEnergy < silenceThreshold
        ) {
          mode = -3
        }
      } else mode = 1
    } else mode = 0
    hints[slot] = Math.abs(priorHint)
    slotModes[slot] = mode
    if (slot >= state.ratioScaledSlotCount && (mode === 3 || mode === -3)) {
      rightFrameEnergy = rightFrameEnergy * decay + energies[slot].right
      leftFrameEnergy = leftFrameEnergy * decay + energies[slot].left
    }
  }

  const previousOutput = state.outputSelector
  const leftDominant = leftFrameEnergy > rightFrameEnergy
  const lowerEnergy = leftDominant ? rightFrameEnergy : leftFrameEnergy
  const sum = rightFrameEnergy + leftFrameEnergy
  let selector = lowerEnergy * (selectorRatioScale / sum)
  selector = selector * selectorScale + selectorOffset
  let outputSelector =
    (float32ToBits(Math.fround(selector)) & 7) + (leftDominant ? 8 : 0)
  if (outputSelector === 0 || outputSelector === 8) outputSelector++

  state.secondPreviousEnergies = copyEnergies(state.previousEnergies)
  state.previousEnergies = copyEnergies(state.energies)
  state.energies = energies
  state.slotModes.set(slotModes)
  state.absoluteModeHints.set(hints)
  state.previousOutputSelector = previousOutput
  state.outputSelector = outputSelector
  return state
}

/**
 * Select and rate-limit ratios for modes chosen by the current frame.
 * @param {object} state Transaction-staged joint-stereo state.
 * Mode-selected detached transaction.
 * @returns {object} The fully selected transform plan.
 */
export function selectJointStereoRatios(state) {
  for (let stream = 0; stream < 4; stream++) {
    if (stream >= state.ratioScaledSlotCount) continue
    const mode = Math.abs(state.slotModes[stream])
    let selectedRatio = unity
    if (mode === 3) {
      const leftEnergy = state.energies[stream].left
      const rightEnergy = state.energies[stream].right
      let ratioOkay = false
      let ratio = 0
      if (!(
        leftEnergy * lowerRatioBound >= rightEnergy ||
        rightEnergy >= upperRatioBound * leftEnergy
      )) {
        ratio =
          ((rightEnergy - leftEnergy) * ratioMappingScale) /
          (rightEnergy + leftEnergy)
        ratioOkay = true
      } else if (!(
        lowerRatioBound * rightEnergy >= leftEnergy ||
        leftEnergy >= upperRatioBound * rightEnergy
      )) {
        ratio =
          ((leftEnergy - rightEnergy) * ratioMappingScale) /
          (leftEnergy + rightEnergy)
        ratioOkay = true
      }
      if (ratioOkay) selectedRatio = Math.fround(ratio)
      else if (
        rightEnergy === 0 ||
        leftEnergy === 0 ||
        Number.isNaN(rightEnergy) ||
        Number.isNaN(leftEnergy)
      )
        selectedRatio = unity
      else if (
        Number.isNaN(rightEnergy * upperRatioBound) ||
        rightEnergy * upperRatioBound <= leftEnergy
      )
        selectedRatio = fallbackRatio
      else if (leftEnergy * upperRatioBound > rightEnergy) selectedRatio = unity
      else selectedRatio = fallbackRatio
    }

    const previousRatio = state.previousRatios[stream]
    state.transitionStartRatios[stream] = previousRatio
    if (selectedRatio - previousRatio >= maxRatioStep) {
      selectedRatio = float32Add(previousRatio, maxRatioStep)
    }
    if (previousRatio - selectedRatio >= maxRatioStep) {
      selectedRatio = float32Subtract(previousRatio, maxRatioStep)
    }
    state.selectedRatios[stream] = selectedRatio
    state.previousRatios[stream] = selectedRatio
  }
  return state
}
