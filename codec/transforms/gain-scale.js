/** Carta3 Audio Codec - Gain-window reconstruction and application. */

import { GainRecord } from '../coding/gain.js'
import { GainScaleScratch } from '../state/encoder.js'
import { float32FromBits, float32Multiply, float32ToBits } from '../utils.js'
import {
  BAND_PART_FLOATS,
  FRAME_SAMPLES,
  GAIN_SAMPLES_PER_STEP,
  GAIN_SCALE_SAMPLES,
  GAIN_SLOT_COUNT,
  GAIN_STEP_COUNT,
  INVERSE_GAIN_FRACTIONAL_SCALE_OFFSET,
  LAYER_GAIN_NEUTRAL_LEVEL,
  LAYER_GAIN_ROW_WORDS,
  LAYER_WORDS,
  PAIR_BLOCK_BASE_WORD,
  PAIR_BLOCK_GAIN_COUNT_WORD,
  PAIR_BLOCK_GAIN_LEVEL_OFFSET,
  PAIR_BLOCK_WORDS,
  RESIDUAL_DELAY_SAMPLES,
  SUBBAND_COUNT,
  TRANSFORM_MATRIX_BASE_WORD,
} from '../core/constants.js'
import {
  ANALYSIS_POWER_OF_TWO_SCALE_BITS,
  ANALYSIS_POWER_OF_TWO_SCALES,
  INVERSE_TRANSFORM_SCALES,
} from '../core/tables.js'

const LAYER_GAIN_ROW_OFFSETS = Object.freeze([0, 4, 8, 12, 16, 20, 24, 28])

/** Apply one selected layered gain envelope to interleaved transform rows. */
function applyLayeredGainRegions(words, unit, pairBase, selector) {
  if (selector === 0) return
  const locationsBase = pairBase
  const levelsBase = pairBase + PAIR_BLOCK_GAIN_LEVEL_OFFSET
  words[levelsBase + selector] = LAYER_GAIN_NEUTRAL_LEVEL
  let region = 0
  let currentGain = words[levelsBase] | 0
  let matrixOffset = TRANSFORM_MATRIX_BASE_WORD + unit
  outer: for (;;) {
    let interpolationOffset
    if (currentGain !== LAYER_GAIN_NEUTRAL_LEVEL) {
      const gainScale = ANALYSIS_POWER_OF_TWO_SCALES[currentGain]
      const regionEnd = words[locationsBase + region] | 0
      const stop =
        TRANSFORM_MATRIX_BASE_WORD + unit + regionEnd * LAYER_GAIN_ROW_WORDS
      while (matrixOffset < stop) {
        for (const rowOffset of LAYER_GAIN_ROW_OFFSETS) {
          words[matrixOffset + rowOffset] = float32ToBits(
            float32Multiply(
              float32FromBits(words[matrixOffset + rowOffset]),
              gainScale
            )
          )
        }
        matrixOffset += LAYER_GAIN_ROW_WORDS
      }
      interpolationOffset = matrixOffset + SUBBAND_COUNT
      words[matrixOffset] = float32ToBits(
        float32Multiply(gainScale, float32FromBits(words[matrixOffset]))
      )
    } else {
      if (region === selector) break
      const regionEnd = words[locationsBase + region] | 0
      interpolationOffset =
        TRANSFORM_MATRIX_BASE_WORD +
        unit +
        regionEnd * LAYER_GAIN_ROW_WORDS +
        SUBBAND_COUNT
    }
    for (;;) {
      const nextRegion = region + 1
      const nextGain = words[levelsBase + nextRegion] | 0
      const gainDelta = nextGain - currentGain
      const scaleBase = Math.imul(currentGain >>> 0, 8) >>> 0
      const scaleStep = gainDelta >>> 0
      let position = scaleBase
      for (let index = 0; index < GAIN_SLOT_COUNT; index++) {
        position = (position + scaleStep) >>> 0
        const bits =
          (Math.imul(position, 0x100000) +
            ANALYSIS_POWER_OF_TWO_SCALE_BITS[16 + (position & 7)]) >>>
          0
        words[interpolationOffset + index * SUBBAND_COUNT] = float32ToBits(
          float32Multiply(
            float32FromBits(words[interpolationOffset + index * SUBBAND_COUNT]),
            float32FromBits(bits)
          )
        )
      }
      matrixOffset = interpolationOffset + (GAIN_SLOT_COUNT - 1) * SUBBAND_COUNT
      region = nextRegion
      currentGain = nextGain
      if (nextGain !== LAYER_GAIN_NEUTRAL_LEVEL) break
      if (region === selector) break outer
      const regionEnd = words[locationsBase + region] | 0
      interpolationOffset =
        TRANSFORM_MATRIX_BASE_WORD +
        unit +
        regionEnd * LAYER_GAIN_ROW_WORDS +
        SUBBAND_COUNT
    }
  }
}

/**
 * Apply an analyzed low-rate gain plan to its detached transform matrix.
 * @param {object} transformState State produced by layered gain analysis.
 * @returns {object} The gain-prepared `transformState`.
 */
export function prepareLayeredGain(transformState) {
  if (transformState?.words?.length < LAYER_WORDS) {
    throw new RangeError('ATRAC3 layered gain preparation has invalid geometry')
  }
  const words = transformState.words
  for (let unit = SUBBAND_COUNT - 1; unit >= 0; unit--) {
    const pairBase = PAIR_BLOCK_BASE_WORD + unit * PAIR_BLOCK_WORDS
    const selector = words[pairBase + PAIR_BLOCK_GAIN_COUNT_WORD]
    applyLayeredGainRegions(words, unit, pairBase, selector)
  }
  return transformState
}

/** Expand one coded gain record into the 64-step intermediate envelope. */
function applyRecordSteps(destination, record, endBias, add) {
  let cursor = 0
  const count = Math.min(record.entries, 7)
  for (let entry = 0; entry < count; entry++) {
    const level = record.levels[entry]
    if (level > 15) return false
    const gain = -4 + level
    const end = record.locations[entry] + endBias
    while (cursor <= end && cursor < GAIN_STEP_COUNT) {
      destination[cursor] = add ? destination[cursor] + gain : gain
      cursor++
    }
  }
  return true
}

/**
 * Expand adjacent coded gain records into a 512-sample envelope.
 * @param {GainRecord} previous Prior-frame record for the same subband.
 * @param {GainRecord} current Current-frame record.
 * @param {Float32Array} output Destination gain envelope.
 * @param {Int32Array} [steps] Reusable 64-step intermediate storage.
 * @returns {number|null} First changed sample, or null for invalid syntax.
 */
export function reconstructGainScale(
  previous,
  current,
  output,
  steps = new Int32Array(GAIN_STEP_COUNT)
) {
  if (output.length < GAIN_SCALE_SAMPLES) {
    throw new RangeError('ATRAC3 gain scale requires 512 output samples')
  }
  steps.fill(0)
  if (
    !applyRecordSteps(steps, current, 32, false) ||
    !applyRecordSteps(steps, previous, 0, true)
  ) {
    return null
  }

  let previousGain = 0
  let outputPosition = GAIN_SCALE_SAMPLES - 1
  let firstChange = GAIN_SCALE_SAMPLES
  for (let step = GAIN_STEP_COUNT - 1; step >= 0; step--) {
    const gain = -steps[step]
    if (gain !== previousGain && firstChange === GAIN_SCALE_SAMPLES) {
      firstChange = outputPosition
    }
    if (gain === previousGain) {
      const value = Math.fround(2 ** gain)
      output.fill(
        value,
        outputPosition + 1 - GAIN_SAMPLES_PER_STEP,
        outputPosition + 1
      )
    } else {
      let accumulator = previousGain * (GAIN_SAMPLES_PER_STEP - 1)
      for (let sample = 1; sample <= GAIN_SAMPLES_PER_STEP; sample++) {
        const interpolated = gain * sample + accumulator
        output[outputPosition + 1 - sample] = Math.pow(
          2,
          interpolated / GAIN_SAMPLES_PER_STEP
        )
        accumulator -= previousGain
      }
    }
    previousGain = gain
    if (step !== 0) outputPosition -= GAIN_SAMPLES_PER_STEP
  }
  return firstChange
}

/**
 * Multiply or divide samples by a reconstructed gain envelope in place.
 * @param {Float32Array} samples Samples to update.
 * @param {Float32Array} scale Reconstructed envelope.
 * @param {'divide'|'multiply'} [operation] Direction of gain application.
 * @returns {number} Number of samples updated.
 */
export function applyGainScale(samples, scale, operation = 'divide') {
  const count = Math.min(samples.length, scale.length, GAIN_SCALE_SAMPLES)
  for (let index = 0; index < count; index++) {
    samples[index] =
      operation === 'multiply'
        ? samples[index] * scale[index]
        : samples[index] / scale[index]
  }
  return count
}

/**
 * Test whether either half of an adjacent gain-record pair is active.
 * @param {GainRecord} previous Prior-frame record.
 * @param {GainRecord} current Current-frame record.
 * @returns {boolean} Whether reconstruction requires gain scaling.
 */
export function gainPairIsActive(previous, current) {
  return previous.entries !== 0 || current.entries !== 0
}

/**
 * Materialize current+overlap samples and divide by their coded gain window.
 * @param {Float32Array} input Current 256-sample half-window.
 * @param {Float32Array} overlap Prior 256-sample overlap half.
 * @param {GainRecord} [previous] Prior-frame gain record.
 * @param {GainRecord} [current] Current-frame gain record.
 * @param {Float32Array} [output] Destination 512-sample window.
 * @param {object} [scratch] Reusable gain-scale buffers.
 * @returns {Float32Array|null} Reconstructed signal, or null for invalid syntax.
 */
export function reconstructGainPairSignal(
  input,
  overlap,
  previous = new GainRecord(),
  current = new GainRecord(),
  output = new Float32Array(GAIN_SCALE_SAMPLES),
  scratch = new GainScaleScratch()
) {
  if (input.length < 256 || overlap.length < 256 || output.length < 512) {
    throw new RangeError(
      'ATRAC3 gain-pair signal requires two 256-sample halves'
    )
  }
  output.set(input.subarray(0, 256), 0)
  output.set(overlap.subarray(0, 256), 256)
  if (gainPairIsActive(previous, current)) {
    if (
      reconstructGainScale(previous, current, scratch.scale, scratch.steps) ===
      null
    ) {
      return null
    }
    applyGainScale(output, scratch.scale, 'divide')
  }
  return output
}

/**
 * Materialize the four gain-adjusted windows consumed by a channel MDCT.
 *
 * This is the stateful boundary between gain analysis and the transform: it
 * applies the already-selected records and advances the caller-owned overlap
 * carry, but performs no frequency transform.
 *
 * @param {Float32Array[]} currentByBand Current 256-sample QMF band halves.
 * @param {object[]} previousRecords Gain records committed by the prior frame.
 * @param {object[]} currentRecords Gain records selected for this frame.
 * @param {Float32Array} carry Previous 256-sample halves, updated in place.
 * @param {Float32Array} windows Destination containing four 512-sample windows.
 * @param {object} scratch Reusable gain-scale reconstruction buffers.
 * @returns {Float32Array} `windows` after all four bands are prepared.
 */
export function prepareGainAdjustedWindows(
  currentByBand,
  previousRecords,
  currentRecords,
  carry,
  windows,
  scratch
) {
  if (
    currentByBand?.length < SUBBAND_COUNT ||
    previousRecords?.length < SUBBAND_COUNT ||
    currentRecords?.length < SUBBAND_COUNT ||
    carry?.length < SUBBAND_COUNT * BAND_PART_FLOATS ||
    windows?.length < SUBBAND_COUNT * GAIN_SCALE_SAMPLES
  ) {
    throw new RangeError('ATRAC3 gain preparation has invalid geometry')
  }

  for (let band = 0; band < SUBBAND_COUNT; band++) {
    const carryOffset = band * BAND_PART_FLOATS
    const previousHalf = carry.subarray(
      carryOffset,
      carryOffset + BAND_PART_FLOATS
    )
    const currentHalf = currentByBand[band]
    const window = windows.subarray(
      band * GAIN_SCALE_SAMPLES,
      (band + 1) * GAIN_SCALE_SAMPLES
    )
    if (currentHalf?.length < BAND_PART_FLOATS) {
      throw new RangeError('ATRAC3 gain preparation requires 256 samples')
    }
    if (
      !reconstructGainPairSignal(
        previousHalf,
        currentHalf,
        previousRecords[band],
        currentRecords[band],
        window,
        scratch
      )
    ) {
      return null
    }
    previousHalf.set(currentHalf.subarray(0, BAND_PART_FLOATS))
  }
  return windows
}

/**
 * Apply a decoded gain envelope to one already transformed subband.
 * @param {object} synthesis Transaction-staged decoder channel state.
 * @param {number} blockIndex Interleaved subband index.
 * @param {object} pairTable Decoded gain locations and selectors.
 * @returns {void}
 */
export function applyInverseGainEnvelope(synthesis, blockIndex, pairTable) {
  const synthesisBase = RESIDUAL_DELAY_SAMPLES + blockIndex
  const scaleCursor = synthesisBase + FRAME_SAMPLES
  let lastGain = pairTable.gains[0] | 0
  let cursor = 0
  let destinationBase = synthesisBase
  for (;;) {
    const limit =
      scaleCursor +
      pairTable.starts[cursor] * SUBBAND_COUNT -
      (FRAME_SAMPLES - SUBBAND_COUNT)
    if (lastGain === 4) {
      destinationBase = limit
      if (scaleCursor <= limit) break
    } else {
      const factor = INVERSE_TRANSFORM_SCALES[lastGain]
      synthesis.synthesisBuffer[destinationBase] = float32Multiply(
        synthesis.synthesisBuffer[destinationBase],
        factor
      )
      let destination = destinationBase + SUBBAND_COUNT
      while (destination < limit) {
        for (
          let offset = 0;
          offset < LAYER_GAIN_ROW_WORDS;
          offset += SUBBAND_COUNT
        ) {
          synthesis.synthesisBuffer[destination + offset] = float32Multiply(
            synthesis.synthesisBuffer[destination + offset],
            factor
          )
        }
        destination += LAYER_GAIN_ROW_WORDS
      }
      destinationBase = limit
    }

    const nextGain = pairTable.gains[cursor + 1] | 0
    const delta = nextGain - lastGain
    let position = (lastGain * 8) >>> 0
    for (let index = 0; index < GAIN_SLOT_COUNT; index++) {
      position = (position + delta) >>> 0
      const factor = float32Multiply(
        INVERSE_TRANSFORM_SCALES[
          (position & GAIN_SLOT_COUNT) + INVERSE_GAIN_FRACTIONAL_SCALE_OFFSET
        ],
        INVERSE_TRANSFORM_SCALES[position >>> 3]
      )
      const destination = destinationBase + index * SUBBAND_COUNT
      synthesis.synthesisBuffer[destination] = float32Multiply(
        synthesis.synthesisBuffer[destination],
        factor
      )
    }
    destinationBase += (GAIN_SLOT_COUNT - 1) * SUBBAND_COUNT
    lastGain = nextGain
    cursor++
    if (destinationBase >= scaleCursor) break
  }
}
