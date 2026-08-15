/** Carta3 Audio Codec - Forward and inverse joint-stereo transforms. */

import {
  FRAME_SAMPLES,
  HALF_BITS,
  INTERPOLATION_STEP_BITS,
  UNITY_BITS,
} from '../core/constants.js'
import {
  JOINT_STEREO_GAIN_SCALES,
  JOINT_STEREO_PAIR_SCALES,
  JOINT_TRANSITION_SCALES,
} from '../core/tables.js'
import {
  float32Add,
  float32FromBits,
  float32Multiply,
  float32Subtract,
} from '../utils.js'

const interpolationStep = float32FromBits(INTERPOLATION_STEP_BITS)
const unity = float32FromBits(UNITY_BITS)
const half = float32FromBits(HALF_BITS)

/** Convert one left/right coefficient pair to scaled mid/side form. */
function applyCoefficient(layers, index, ratio, inverseScale) {
  const left = layers[0].spectrum[index]
  const right = layers[1].spectrum[index]
  const mid = (left + right) * half
  const side = (left - ratio * mid) * inverseScale
  layers[1].spectrum[index] = Math.fround(side)
  layers[0].spectrum[index] = Math.fround(mid)
}

/**
 * Apply a fully selected decorrelation plan to two layer spectra.
 * @param {object} state Analysis-complete joint-stereo transform plan.
 * @param {object[]} layers Two staged layer spectra, mutated in place.
 * @returns {object[]} The converted layers.
 */
export function applyJointStereoConversion(state, layers) {
  if (
    layers.length < 2 ||
    layers[0].spectrum.length < 1024 ||
    layers[1].spectrum.length < 1024
  ) {
    throw new RangeError('ATRAC3 joint stereo requires two 1024-line layers')
  }
  const modeWeights = [0, 2, 2, 1, 1]
  for (let stream = 0; stream < 4; stream++) {
    const mode = Math.abs(state.slotModes[stream])
    if (stream < state.ratioScaledSlotCount) {
      const hint = state.absoluteModeHints[stream]
      const currentWeight = modeWeights[mode]
      const nextWeight = modeWeights[mode + 1]
      const hintedWeight = modeWeights[hint]
      const hintedNextWeight = modeWeights[hint + 1]
      const selectedRatio = state.selectedRatios[stream]
      const previousRatio = state.transitionStartRatios[stream]
      const scaledRatio = float32Multiply(nextWeight, selectedRatio)
      const ratioStep =
        (previousRatio * hintedNextWeight - scaledRatio) * interpolationStep
      const weightStep = (hintedWeight - currentWeight) * interpolationStep
      for (let ramp = 0; ramp < 8; ramp++) {
        const relative = ramp - 8
        const scale = scaledRatio - relative * ratioStep
        const ratio = currentWeight - relative * weightStep
        applyCoefficient(layers, stream + ramp * 4, ratio, unity / scale)
      }
      for (let position = 8; position < 0x100; position++) {
        applyCoefficient(
          layers,
          stream + position * 4,
          currentWeight,
          unity / scaledRatio
        )
      }
      continue
    }

    let previousScaleIndex = state.previousOutputSelector
    let currentScaleIndex = state.outputSelector
    if (mode === 3) {
      previousScaleIndex &= 7
      currentScaleIndex &= 7
    } else if (mode === 1) {
      previousScaleIndex += 8
      currentScaleIndex += 8
    } else if (mode === 0) {
      previousScaleIndex = (previousScaleIndex ^ 8) + 8
      currentScaleIndex = (currentScaleIndex ^ 8) + 8
    }
    const previousScale = JOINT_TRANSITION_SCALES[previousScaleIndex]
    const currentScale = JOINT_TRANSITION_SCALES[currentScaleIndex]
    const scaleStep = (previousScale - currentScale) * interpolationStep
    for (let ramp = 0; ramp < 8; ramp++) {
      const index = stream + ramp * 4
      const sum = layers[0].spectrum[index] + layers[1].spectrum[index]
      const scale = currentScale - (ramp - 8) * scaleStep
      layers[0].spectrum[index] = float32Multiply(unity / scale, sum)
    }
    const inverseScale = unity / currentScale
    for (let position = 8; position < 0x100; position++) {
      const index = stream + position * 4
      const sum = layers[0].spectrum[index] + layers[1].spectrum[index]
      layers[0].spectrum[index] = float32Multiply(sum, inverseScale)
    }
  }
  return layers
}

/** Resolve one decoder gain selector to its two mixing scales. */
function gainScalePair(selector) {
  return [
    JOINT_STEREO_GAIN_SCALES[selector] ?? 0,
    JOINT_STEREO_GAIN_SCALES[selector + 1] ?? 0,
  ]
}

/**
 * Apply one preflighted inverse mix across both staged decoder channels.
 * @param {object} state Staged decoder state, mutated and advanced in place.
 * @param {object} plan Validated current-frame joint-stereo header plan.
 * @returns {object} `state` after mixing and header-history publication.
 */
export function applyDecoderJointStereoMix(state, plan) {
  const header = state.header
  const firstWork = state.channels[0].synthesisBuffer
  const secondWork = state.channels[1].synthesisBuffer
  for (let band = 0; band < 4; band++) {
    let previousPairFirst = 2
    let previousPairSecond = 2
    if (header.previousUnitMode < band) {
      previousPairFirst =
        JOINT_STEREO_PAIR_SCALES[header.previousPairScaleIndex]
      previousPairSecond =
        JOINT_STEREO_PAIR_SCALES[header.previousPairScaleIndex + 1]
    }
    let currentPairFirst = 2
    let currentPairSecond = 2
    if (header.unitMode < band) {
      currentPairFirst = JOINT_STEREO_PAIR_SCALES[header.pairScaleIndex]
      currentPairSecond = JOINT_STEREO_PAIR_SCALES[header.pairScaleIndex + 1]
    }

    const [currentGainFirst, currentGainSecond] = gainScalePair(
      header.gainScaleSelectors[band]
    )
    const [previousGainFirst, previousGainSecond] = gainScalePair(
      header.previousGainScaleSelectors[band]
    )
    let mixRow = -0x100
    if (
      header.gainScaleSelectors[band] !==
        header.previousGainScaleSelectors[band] ||
      previousPairFirst !== currentPairFirst
    ) {
      const secondGainDelta = float32Subtract(
        currentGainSecond,
        previousGainSecond
      )
      const firstGainDelta = float32Subtract(
        currentGainFirst,
        previousGainFirst
      )
      mixRow = -8
      while (mixRow < 0) {
        const mixIndex = FRAME_SAMPLES + 138 + band + mixRow * 4
        const interpolation = Math.fround(mixRow)
        const firstInput = firstWork[mixIndex]
        const firstWeight = float32Add(
          float32Multiply(
            float32Multiply(interpolation, firstGainDelta),
            0.125
          ),
          currentGainFirst
        )
        const secondWeight = float32Add(
          currentGainSecond,
          float32Multiply(
            float32Multiply(secondGainDelta, 0.125),
            interpolation
          )
        )
        const blended = float32Add(
          float32Multiply(firstWeight, firstInput),
          float32Multiply(secondWeight, secondWork[mixIndex])
        )
        const firstPair = float32Add(
          float32Multiply(
            float32Multiply(
              interpolation,
              float32Subtract(currentPairFirst, previousPairFirst)
            ),
            0.125
          ),
          currentPairFirst
        )
        const secondPair = float32Add(
          float32Multiply(
            float32Multiply(
              float32Subtract(currentPairSecond, previousPairSecond),
              0.125
            ),
            interpolation
          ),
          currentPairSecond
        )
        firstWork[mixIndex] = float32Multiply(firstPair, blended)
        secondWork[mixIndex] = float32Multiply(
          float32Subtract(firstInput, blended),
          secondPair
        )
        mixRow++
      }
      mixRow = -0xf8
    }

    let index = band + mixRow * 4
    while (mixRow < 0) {
      const mixIndex = FRAME_SAMPLES + 138 + index
      const firstInput = firstWork[mixIndex]
      const mixed = float32Add(
        float32Multiply(currentGainFirst, firstInput),
        float32Multiply(currentGainSecond, secondWork[mixIndex])
      )
      firstWork[mixIndex] = float32Multiply(mixed, currentPairFirst)
      secondWork[mixIndex] = float32Multiply(
        float32Subtract(firstInput, mixed),
        currentPairSecond
      )
      index += 4
      mixRow++
    }
  }

  header.previousGainScaleSelectors.set(header.gainScaleSelectors)
  header.previousUnitMode = header.unitMode
  header.previousPairScaleIndex = header.pairScaleIndex
  header.unitMode = plan.unitMode
  header.pairScaleIndex = (plan.firstHeaderByte >> 4) * 2
  header.gainScaleSelectors.set(plan.gainScaleSelectors)
  return state
}
