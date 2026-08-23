/** Carta3 Audio Codec - Persistent layered coding state. */

import {
  ALLOCATION_WORK_WORDS,
  FRAME_SAMPLES,
  LAYER_BIT_BUDGET_WORD,
  LAYER_GAIN_HISTORY_OFFSET,
  LAYER_GAIN_SCRATCH_WORDS,
  LAYER_MATRIX_WORDS,
  LAYER_QMF_HISTORY_OFFSET,
  LAYER_SCALE_FACTOR_BAND_LIMIT_WORD,
  LAYER_JOINT_SECONDARY_WORD,
  LAYER_TRANSFORM_HISTORY_OFFSET,
  LAYER_WINDOW_MATRIX_OFFSET,
  LAYER_WORDS,
  LAYERED_QMF_HISTORY_FLOATS,
  MAX_CHANNELS,
  PAIR_BLOCK_BASE_WORD,
  PAIR_BLOCK_GAIN_COUNT_WORD,
  PAIR_BLOCK_LAST_GROUP_MAXIMUM_WORD,
  PAIR_BLOCK_MAGNITUDE_HISTORY_OFFSET,
  PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS,
  PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD,
  PAIR_BLOCK_WORDS,
  SPECTRUM_GROUPS,
  SUBBAND_COUNT,
  TONE_HISTORY_WORD,
} from '../core/constants.js'
import { float32FromBits, float32ToBits } from '../utils.js'

/** Persistent gain evidence for one layered pair block. */
class PairGainHistory {
  /** Allocate compact zeroed evidence. */
  constructor() {
    this.magnitudeBits = new Uint32Array(PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS)
    this.maximumBits = 0
    this.lastMaximumBits = 0
    this.gainCount = 0
  }
}

/** Persistent cross-frame history for one low-rate layer. */
export class LayerHistory {
  /** Allocate compact zeroed history with stable typed-array identities. */
  constructor() {
    this.windowMatrix = new Uint32Array(LAYER_MATRIX_WORDS)
    this.gainHistory = new Uint32Array(LAYER_MATRIX_WORDS)
    this.transformHistory = new Uint32Array(LAYER_MATRIX_WORDS)
    this.qmfHistory = new Float32Array(LAYERED_QMF_HISTORY_FLOATS)
    this.pairGains = Array.from(
      { length: SUBBAND_COUNT },
      () => new PairGainHistory()
    )
  }

  /**
   * Restore neutral history when configuring a layered stream.
   *
   * @returns {LayerHistory} This cleared history.
   */
  reset() {
    this.windowMatrix.fill(0)
    this.gainHistory.fill(0)
    this.transformHistory.fill(0)
    this.qmfHistory.fill(0)
    for (const pair of this.pairGains) {
      pair.magnitudeBits.fill(0)
      pair.maximumBits = 0
      pair.lastMaximumBits = 0
      pair.gainCount = 0
    }
    return this
  }

  /**
   * Stage genuine history into reusable frame work.
   *
   * @param {LayerWork} destination Existing destination work.
   * @returns {LayerWork} `destination` after staging.
   */
  stageTo(destination) {
    destination.windowMatrix.set(this.windowMatrix)
    destination.gainHistory.set(this.gainHistory)
    destination.transformHistory.set(this.transformHistory)
    destination.qmfHistory.set(this.qmfHistory)
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      const pair = this.pairGains[band]
      const block = destination.pairBlocks[band]
      block.set(pair.magnitudeBits, PAIR_BLOCK_MAGNITUDE_HISTORY_OFFSET)
      block[PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD] = pair.maximumBits
      block[PAIR_BLOCK_LAST_GROUP_MAXIMUM_WORD] = pair.lastMaximumBits
      block[PAIR_BLOCK_GAIN_COUNT_WORD] = pair.gainCount
    }
    return destination
  }

  /**
   * Commit genuine histories from completed frame work.
   *
   * @param {LayerWork} source Completed frame work.
   * @returns {LayerHistory} This committed history.
   */
  commitFrom(source) {
    this.windowMatrix.set(source.windowMatrix)
    this.gainHistory.set(source.gainHistory)
    this.transformHistory.set(source.transformHistory)
    this.qmfHistory.set(source.qmfHistory)
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      const pair = this.pairGains[band]
      const block = source.pairBlocks[band]
      pair.magnitudeBits.set(
        block.subarray(
          PAIR_BLOCK_MAGNITUDE_HISTORY_OFFSET,
          PAIR_BLOCK_MAGNITUDE_HISTORY_OFFSET +
            PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS
        )
      )
      pair.maximumBits = block[PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD]
      pair.lastMaximumBits = block[PAIR_BLOCK_LAST_GROUP_MAXIMUM_WORD]
      pair.gainCount = block[PAIR_BLOCK_GAIN_COUNT_WORD]
    }
    return this
  }
}

/** Complete reusable work and current product for one low-rate layer. */
export class LayerWork {
  /** Allocate frame work with stable product and history identities. */
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
    this.priorGainCount = 0
    this.scaleFactorBandLimit = 0
    this.bitBudget = 0
    this.jointSecondary = false
  }

  /**
   * Serialize this state into the port-compatible transaction image.
   *
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
    words[TONE_HISTORY_WORD] = this.priorGainCount >>> 0
    words[LAYER_SCALE_FACTOR_BAND_LIMIT_WORD] = this.scaleFactorBandLimit >>> 0
    words[LAYER_BIT_BUDGET_WORD] = this.bitBudget >>> 0
    words[LAYER_JOINT_SECONDARY_WORD] = this.jointSecondary ? 1 : 0
    return words
  }

  /**
   * Load a completed transform image into this detached layer.
   *
   * @param {Uint32Array} words Completed transaction image.
   * @returns {LayerWork} This layer after loading.
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
    this.priorGainCount = words[TONE_HISTORY_WORD]
    this.scaleFactorBandLimit = words[LAYER_SCALE_FACTOR_BAND_LIMIT_WORD]
    this.bitBudget = words[LAYER_BIT_BUDGET_WORD] | 0
    this.jointSecondary = words[LAYER_JOINT_SECONDARY_WORD] !== 0
    return this
  }
}

/** Stage-private storage for one layered gain analysis call. */
export class LayeredGainScratch {
  /** Allocate reusable gain measurements and selection cursors. */
  constructor() {
    this.maximumMagnitudes = new Uint32Array(FRAME_SAMPLES / 8)
    this.gainScratchBits = new Uint32Array(LAYER_GAIN_SCRATCH_WORDS)
    this.gainSelectionScratch = new Int32Array(2)
  }
}

/** Stage-private storage for one layered MDCT call. */
export class LayeredMdctScratch {
  /** Allocate reusable transform values and initial gain scales. */
  constructor() {
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
    this.primaryExpansionThresholds = new Int32Array(SPECTRUM_GROUPS).fill(-1)
  }

  /**
   * Clear measurements that are rebuilt for every source spectrum.
   *
   * @returns {object}
   */
  reset() {
    this.groupScaleFactors.fill(0)
    this.bandMetrics.fill(0)
    this.scaleFactors.fill(0)
    this.sumRunning = 0
    this.primaryExpansionThresholds.fill(-1)
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
