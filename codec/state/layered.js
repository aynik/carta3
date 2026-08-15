/** Carta3 Audio Codec - Persistent layered coding state. */

import {
  ALLOCATION_WORK_WORDS,
  FRAME_SAMPLES,
  JOINT_STEREO_ALL_SLOTS,
  JOINT_STEREO_SLOT_ROUNDING,
  LAYER_BIT_BUDGET_WORD,
  LAYER_GAIN_HISTORY_OFFSET,
  LAYER_GAIN_SCRATCH_WORDS,
  LAYER_MATRIX_WORDS,
  LAYER_QMF_HISTORY_OFFSET,
  LAYER_PRIMARY_HEADER_BITS,
  LAYER_SCALE_FACTOR_BAND_LIMIT_WORD,
  LAYER_SECONDARY_HEADER_BITS,
  LAYER_STEREO_FLAG_WORD,
  LAYER_TRANSFORM_HISTORY_OFFSET,
  LAYER_WINDOW_MATRIX_OFFSET,
  LAYER_WORDS,
  LAYERED_QMF_HISTORY_FLOATS,
  MAX_CHANNELS,
  PAIR_BLOCK_BASE_WORD,
  PAIR_BLOCK_WORDS,
  SAMPLE_RATE,
  SPECTRUM_GROUPS,
  SUBBAND_COUNT,
  TONE_HISTORY_WORD,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import {
  LAYER_BAND_OFFSETS,
  LAYER_PROFILE_CONFIGURATION,
} from '../core/tables.js'
import { JointStereoState } from './joint-stereo.js'
import { float32FromBits, float32ToBits } from '../utils.js'

/** Persistent state for one 66/105 kbps transform layer. */
export class LayerState {
  /** Allocate a zeroed layer with stable typed-array identities. */
  constructor() {
    this.spectrum = new Float32Array(FRAME_SAMPLES)
    this.windowMatrix = new Uint32Array(LAYER_MATRIX_WORDS)
    this.gainHistory = new Uint32Array(LAYER_MATRIX_WORDS)
    this.transformHistory = new Uint32Array(LAYER_MATRIX_WORDS)
    this.qmfHistory = new Float32Array(LAYERED_QMF_HISTORY_FLOATS)
    this.pairBlocks = Array.from(
      { length: SUBBAND_COUNT },
      () => new Uint32Array(PAIR_BLOCK_WORDS)
    )
    this.previousPairToneEntryCount = 0
    this.scaleFactorBandLimit = 0
    this.bitBudget = 0
    this.stereoFlag = 0
  }

  /**
   * Copy this layer without replacing destination-owned storage.
   * @param {LayerState} destination Existing destination state.
   * @returns {LayerState} `destination` after the copy.
   */
  copyTo(destination) {
    destination.spectrum.set(this.spectrum)
    destination.windowMatrix.set(this.windowMatrix)
    destination.gainHistory.set(this.gainHistory)
    destination.transformHistory.set(this.transformHistory)
    destination.qmfHistory.set(this.qmfHistory)
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      destination.pairBlocks[band].set(this.pairBlocks[band])
    }
    destination.previousPairToneEntryCount = this.previousPairToneEntryCount
    destination.scaleFactorBandLimit = this.scaleFactorBandLimit
    destination.bitBudget = this.bitBudget
    destination.stereoFlag = this.stereoFlag
    return destination
  }

  /**
   * Serialize this state into the port-compatible transaction image.
   * @param {Uint32Array} words Caller-owned transaction image.
   * @returns {Uint32Array} `words` after serialization.
   */
  storeTo(words) {
    if (words.length < LAYER_WORDS) {
      throw new RangeError('ATRAC3 layered word image has invalid geometry')
    }
    for (let index = 0; index < FRAME_SAMPLES; index++) {
      words[index] = float32ToBits(this.spectrum[index])
    }
    words.set(this.windowMatrix, LAYER_WINDOW_MATRIX_OFFSET)
    words.set(this.gainHistory, LAYER_GAIN_HISTORY_OFFSET)
    words.set(this.transformHistory, LAYER_TRANSFORM_HISTORY_OFFSET)
    for (let index = 0; index < LAYERED_QMF_HISTORY_FLOATS; index++) {
      words[LAYER_QMF_HISTORY_OFFSET + index] = float32ToBits(
        this.qmfHistory[index]
      )
    }
    for (let block = 0; block < SUBBAND_COUNT; block++) {
      words.set(
        this.pairBlocks[block],
        PAIR_BLOCK_BASE_WORD + block * PAIR_BLOCK_WORDS
      )
    }
    words[TONE_HISTORY_WORD] = this.previousPairToneEntryCount >>> 0
    words[LAYER_SCALE_FACTOR_BAND_LIMIT_WORD] = this.scaleFactorBandLimit >>> 0
    words[LAYER_BIT_BUDGET_WORD] = this.bitBudget >>> 0
    words[LAYER_STEREO_FLAG_WORD] = this.stereoFlag >>> 0
    return words
  }

  /**
   * Commit a transaction image into this persistent layer storage.
   * @param {Uint32Array} words Completed transaction image.
   * @returns {LayerState} This layer after commit.
   */
  loadFrom(words) {
    if (words.length < LAYER_WORDS) {
      throw new RangeError('ATRAC3 layered word image has invalid geometry')
    }
    for (let index = 0; index < FRAME_SAMPLES; index++) {
      this.spectrum[index] = float32FromBits(words[index])
    }
    this.windowMatrix.set(
      words.subarray(
        LAYER_WINDOW_MATRIX_OFFSET,
        LAYER_WINDOW_MATRIX_OFFSET + LAYER_MATRIX_WORDS
      )
    )
    this.gainHistory.set(
      words.subarray(
        LAYER_GAIN_HISTORY_OFFSET,
        LAYER_GAIN_HISTORY_OFFSET + LAYER_MATRIX_WORDS
      )
    )
    this.transformHistory.set(
      words.subarray(
        LAYER_TRANSFORM_HISTORY_OFFSET,
        LAYER_TRANSFORM_HISTORY_OFFSET + LAYER_MATRIX_WORDS
      )
    )
    for (let index = 0; index < LAYERED_QMF_HISTORY_FLOATS; index++) {
      this.qmfHistory[index] = float32FromBits(
        words[LAYER_QMF_HISTORY_OFFSET + index]
      )
    }
    for (let block = 0; block < SUBBAND_COUNT; block++) {
      const base = PAIR_BLOCK_BASE_WORD + block * PAIR_BLOCK_WORDS
      this.pairBlocks[block].set(words.subarray(base, base + PAIR_BLOCK_WORDS))
    }
    this.previousPairToneEntryCount = words[TONE_HISTORY_WORD]
    this.scaleFactorBandLimit = words[LAYER_SCALE_FACTOR_BAND_LIMIT_WORD]
    this.bitBudget = words[LAYER_BIT_BUDGET_WORD] | 0
    this.stereoFlag = words[LAYER_STEREO_FLAG_WORD]
    return this
  }
}

/** Cross-stage transform transaction for one low-rate layer. */
export class LayeredTransformState {
  /** Allocate detached words plus gain-analysis and MDCT storage. */
  constructor() {
    this.words = new Uint32Array(LAYER_WORDS)
    this.maximumMagnitudes = new Uint32Array(FRAME_SAMPLES / 8)
    this.gainScratchBits = new Uint32Array(LAYER_GAIN_SCRATCH_WORDS)
    this.gainSelectionScratch = new Int32Array(2)
    this.transformValues = new Float32Array(FRAME_SAMPLES)
    this.initialGainScales = new Float32Array(SUBBAND_COUNT)
  }
}

/** Frame-local residual measurements carried from analysis into allocation. */
export class ResidualSourceProfile {
  /** Allocate fixed-capacity residual measurements for one source layer. */
  constructor() {
    this.groupScaleFactors = new Uint32Array(FRAME_SAMPLES / SUBBAND_COUNT)
    this.bandMetrics = new Int32Array(SPECTRUM_GROUPS + 2)
    this.scaleFactors = new Int32Array(SPECTRUM_GROUPS)
    this.sumRunning = 0
    this.monoExpansionBudgetThresholds = new Int32Array(SPECTRUM_GROUPS).fill(
      -1
    )
  }

  /** Clear measurements that are rebuilt for every source spectrum. */
  reset() {
    this.groupScaleFactors.fill(0)
    this.bandMetrics.fill(0)
    this.scaleFactors.fill(0)
    this.sumRunning = 0
    this.monoExpansionBudgetThresholds.fill(-1)
    return this
  }
}

/** Stage-private alternatives and source evidence for layered allocation. */
export class LayeredAllocationScratch {
  /** Allocate per-channel candidate images and residual source profiles. */
  constructor() {
    this.candidateWorks = Array.from(
      { length: MAX_CHANNELS },
      () => new Int32Array(ALLOCATION_WORK_WORDS)
    )
    this.sourceProfiles = Array.from(
      { length: MAX_CHANNELS },
      () => new ResidualSourceProfile()
    )
  }
}

/** Convert a coefficient limit to the smallest covering residual-band prefix. */
function bandCountForCoefficientLimit(limit) {
  let count = 1
  while (count < SPECTRUM_GROUPS && LAYER_BAND_OFFSETS[count] < limit) count++
  return count
}

/** Profile-configured cross-frame state for both low-rate channel layers. */
export class LayeredEncoderState {
  /**
   * Configure state for a maintained 66 or 105 kbps profile.
   * @param {object} [options] Profile selector accepted by {@link resolveProfile}.
   */
  constructor(options = {}) {
    this.profile = resolveProfile(options)
    const configuration =
      this.profile && LAYER_PROFILE_CONFIGURATION[this.profile.bitrateKbps]
    if (!this.profile || !configuration) {
      throw new RangeError('ATRAC3 layered encoding requires 66 or 105 kbps')
    }
    this.jointStereo = new JointStereoState()
    this.jointStereo.ratioScaledSlotCount = -1
    this.layers = [new LayerState(), new LayerState()]
    let previousBitBudget = 0
    for (let layer = 0; layer < this.layers.length; layer++) {
      const secondary = configuration.secondary && layer === 1
      const bitBudget =
        (configuration.budgetBases[layer] << 3) -
        (secondary ? LAYER_SECONDARY_HEADER_BITS : LAYER_PRIMARY_HEADER_BITS)
      const coefficientLimit = Math.trunc(
        (configuration.workSizes[layer] * (FRAME_SAMPLES * 2)) / SAMPLE_RATE
      )
      this.layers[layer].bitBudget = bitBudget
      this.layers[layer].scaleFactorBandLimit =
        bandCountForCoefficientLimit(coefficientLimit)
      this.layers[layer].stereoFlag = secondary ? previousBitBudget : 0
      previousBitBudget = bitBudget
      if (secondary) {
        this.jointStereo.ratioScaledSlotCount = Math.max(
          1,
          Math.trunc(
            (coefficientLimit + JOINT_STEREO_SLOT_ROUNDING) /
              (FRAME_SAMPLES / 4)
          )
        )
      }
    }
    if (configuration.secondary) {
      this.jointStereo.outputSelector = JOINT_STEREO_ALL_SLOTS
      this.jointStereo.slotModes.fill(-3)
      this.jointStereo.selectedRatios.fill(1)
      this.jointStereo.previousRatios.fill(1)
    }
  }

  /**
   * Copy this configured state into existing destination storage.
   * @param {LayeredEncoderState} destination Existing destination state.
   * @returns {LayeredEncoderState} `destination` after the copy.
   */
  copyTo(destination) {
    destination.profile = this.profile
    this.jointStereo.copyTo(destination.jointStereo)
    for (let layer = 0; layer < this.layers.length; layer++) {
      this.layers[layer].copyTo(destination.layers[layer])
    }
    return destination
  }
}
