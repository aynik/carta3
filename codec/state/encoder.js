/** Carta3 Audio Codec - Encoder state, frame transactions, and scratch. */

import { GainRecord } from './gain.js'
import {
  ALLOCATION_BAND_COUNT,
  ALLOCATION_WORK_WORDS,
  ANALYSIS_WORK_FLOATS,
  ATTACK_CANDIDATE_COUNT,
  BAND_PART_FLOATS,
  BAND_STRIDE_FLOATS,
  FORWARD_TRANSFORM_CARRY_OFFSET,
  FRAME_SAMPLES,
  GAIN_CANDIDATE_COUNT,
  GAIN_SCALE_SAMPLES,
  GAIN_STEP_COUNT,
  JOINT_STEREO_SLOT_ROUNDING,
  LAYER_PRIMARY_HEADER_BITS,
  LAYER_SECONDARY_HEADER_BITS,
  LAYER_WORDS,
  MAX_CHANNELS,
  MAX_CODED_FRAME_BYTES,
  MAX_QUANTIZATION_BAND_COEFFICIENTS,
  MAX_SELECTED_GAIN_CANDIDATES,
  QMF_DELAY,
  ROOT_HISTORY_OFFSET,
  SAMPLE_RATE,
  SOUND_UNIT_FILL_MOVES_PER_BAND,
  SPECTRUM_WORK_FLOATS,
  SPECTRUM_GROUPS,
  SUBBAND_COUNT,
  TRANSFORM_CARRY_OFFSET_FLOATS,
  BITSTREAM_PADDING_BYTES,
} from '../core/constants.js'
import { selectEncoderMode } from '../core/profiles.js'
import {
  LAYER_BAND_OFFSETS,
  LAYER_PROFILE_CONFIGURATION,
} from '../core/tables.js'
import { JointStereoHistory, JointStereoWork } from './stereo.js'
import { LayerHistory, LayerWork } from './layered.js'

/**
 * Deep-copy a dynamic list without replacing destination-owned storage.
 *
 * @param {object[]} source
 * @param {object[]} destination
 */
function copyCloneList(source, destination) {
  destination.length = source.length
  for (let index = 0; index < source.length; index++) {
    destination[index] = structuredClone(source[index])
  }
}

/**
 * Count the residual-band prefix covering one coefficient limit.
 *
 * @param {number} limit Coefficient limit.
 * @returns {number} Covering residual-band count.
 */
function countBands(limit) {
  let count = 1
  while (count < SPECTRUM_GROUPS && LAYER_BAND_OFFSETS[count] < limit) count++
  return count
}

/**
 * Restore independent histories when initializing one encoder stream.
 *
 * @param {object} _profile Resolved stream profile.
 * @param {object} encoder Encoder pool ownership root.
 */
function resetIndependent(_profile, encoder) {
  for (const history of encoder.state.independentChannels) history.reset()
}

/**
 * Configure layered frame geometry and restore persistent histories.
 *
 * @param {object} profile Resolved stream profile.
 * @param {object} encoder Encoder pool ownership root.
 */
function configureLayered(profile, encoder) {
  const configuration = LAYER_PROFILE_CONFIGURATION[profile.bitrateKbps]
  const work = encoder.frame.layeredWork
  const jointWork = encoder.frame.jointStereoWork
  jointWork.ratioScaledSlotCount = -1
  for (let layer = 0; layer < work.length; layer++) {
    const jointSecondary = configuration.jointStereo && layer === 1
    const coefficientLimit = Math.trunc(
      (configuration.workSizes[layer] * (FRAME_SAMPLES * 2)) / SAMPLE_RATE
    )
    work[layer].bitBudget =
      (configuration.budgetBases[layer] << 3) -
      (jointSecondary ? LAYER_SECONDARY_HEADER_BITS : LAYER_PRIMARY_HEADER_BITS)
    work[layer].scaleFactorBandLimit = countBands(coefficientLimit)
    work[layer].jointSecondary = jointSecondary
    encoder.state.layeredHistories[layer].reset()
    if (jointSecondary) {
      jointWork.ratioScaledSlotCount = Math.max(
        1,
        Math.trunc(
          (coefficientLimit + JOINT_STEREO_SLOT_ROUNDING) / (FRAME_SAMPLES / 4)
        )
      )
    }
  }
  encoder.state.jointStereoHistory.reset(configuration.jointStereo)
}

/** Detached 132 kbps sound-unit syntax and reusable allocation state. */
export class EncoderChannelBlock {
  /** Allocate an empty fixed-capacity channel block. */
  constructor() {
    this.spectrumGroupCount = 0
    this.componentGroupCount = 0
    this.componentMode = 0
    this.spectrumTableIndex = 0
    this.toneEntryIndex = 0
    this.toneEntries = []
    this.tonePool = []
    this.toneCount = 0
    this.wordLengths = new Int32Array(SPECTRUM_GROUPS)
    this.scaleFactorIndices = new Int32Array(SPECTRUM_GROUPS)
    this.quantizedSpectrum = new Int32Array(FRAME_SAMPLES)
    this.gainRecords = Array.from(
      { length: SUBBAND_COUNT },
      () => new GainRecord()
    )
  }

  /**
   * Copy this block without replacing destination-owned storage.
   *
   * @param {EncoderChannelBlock} destination Existing destination block.
   * @returns {EncoderChannelBlock} `destination` after the copy.
   */
  copyTo(destination) {
    destination.spectrumGroupCount = this.spectrumGroupCount
    destination.componentGroupCount = this.componentGroupCount
    destination.componentMode = this.componentMode
    destination.spectrumTableIndex = this.spectrumTableIndex
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      const target = destination.gainRecords[band]
      const record = this.gainRecords[band]
      target.entries = record.entries
      target.locations.set(record.locations)
      target.levels.set(record.levels)
      target.peakHistory = record.peakHistory
    }
    destination.toneEntryIndex = this.toneEntryIndex
    copyCloneList(this.toneEntries, destination.toneEntries)
    copyCloneList(this.tonePool, destination.tonePool)
    destination.toneCount = this.toneCount
    destination.wordLengths.set(this.wordLengths)
    destination.scaleFactorIndices.set(this.scaleFactorIndices)
    destination.quantizedSpectrum.set(this.quantizedSpectrum)
    return destination
  }

  /**
   * Reset this frame-owned syntax block for independent analysis.
   *
   * @returns {EncoderChannelBlock} This cleared block.
   */
  reset() {
    this.spectrumGroupCount = SPECTRUM_GROUPS - 3
    this.componentGroupCount = 3
    this.componentMode = 0
    this.spectrumTableIndex = 0
    this.wordLengths.fill(0)
    this.scaleFactorIndices.fill(0)
    this.quantizedSpectrum.fill(0)
    for (const record of this.gainRecords) {
      record.entries = 0
      record.locations.fill(0)
      record.levels.fill(0)
      record.peakHistory = 0
    }
    this.toneEntryIndex = 0
    this.toneEntries.length = 0
    this.tonePool.length = 0
    this.toneCount = 0
    return this
  }
}

/** Persistent analysis and gain history for one independent channel. */
export class IndependentChannelHistory {
  /** Allocate compact history with stable typed-array identities. */
  constructor() {
    this.bandTails = Array.from(
      { length: SUBBAND_COUNT },
      () => new Float32Array(2 * BAND_PART_FLOATS)
    )
    this.transformCarry = new Float32Array(FRAME_SAMPLES)
    this.referenceCarry = new Float32Array(FRAME_SAMPLES)
    this.qmfDelays = new Float32Array(3 * QMF_DELAY)
    this.gainRecords = Array.from(
      { length: SUBBAND_COUNT },
      () => new GainRecord()
    )
  }

  /**
   * Restore neutral history when starting an independent stream.
   *
   * @returns {IndependentChannelHistory} This cleared history.
   */
  reset() {
    for (const tail of this.bandTails) tail.fill(0)
    this.transformCarry.fill(0)
    this.referenceCarry.fill(0)
    this.qmfDelays.fill(0)
    for (const record of this.gainRecords) {
      record.entries = 0
      record.locations.fill(0)
      record.levels.fill(0)
      record.peakHistory = 0
    }
    return this
  }

  /**
   * Stage compact history into a frame-local native analysis image.
   *
   * @param {Float32Array} work Reusable complete analysis work image.
   * @returns {Float32Array} `work` after staging.
   */
  stageTo(work) {
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      const offset = band * BAND_STRIDE_FLOATS + BAND_PART_FLOATS
      work.set(this.bandTails[band], offset)
    }
    work.set(this.transformCarry, TRANSFORM_CARRY_OFFSET_FLOATS)
    work.set(this.referenceCarry, FORWARD_TRANSFORM_CARRY_OFFSET)
    work.set(this.qmfDelays, ROOT_HISTORY_OFFSET)
    return work
  }

  /**
   * Commit native analysis and gain history after successful packing.
   *
   * @param {Float32Array} work Completed frame-local analysis image.
   * @param {object[]} gainRecords Current frame gain records.
   * @returns {IndependentChannelHistory} This committed history.
   */
  commitFrom(work, gainRecords) {
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      const offset = band * BAND_STRIDE_FLOATS + BAND_PART_FLOATS
      this.bandTails[band].set(
        work.subarray(offset, offset + 2 * BAND_PART_FLOATS)
      )
      gainRecords[band].copyTo(this.gainRecords[band])
    }
    this.transformCarry.set(
      work.subarray(
        TRANSFORM_CARRY_OFFSET_FLOATS,
        TRANSFORM_CARRY_OFFSET_FLOATS + FRAME_SAMPLES
      )
    )
    this.referenceCarry.set(
      work.subarray(
        FORWARD_TRANSFORM_CARRY_OFFSET,
        FORWARD_TRANSFORM_CARRY_OFFSET + FRAME_SAMPLES
      )
    )
    this.qmfDelays.set(
      work.subarray(ROOT_HISTORY_OFFSET, ROOT_HISTORY_OFFSET + 3 * QMF_DELAY)
    )
    return this
  }
}

/** Mutable rate-distortion candidate used only within one allocation call. */
export class SoundUnitAllocationCandidate {
  /**
   * Allocate fixed-capacity vectors and optionally seed their syntax fields.
   *
   * @param {ArrayLike<number>} [wordLengths]
   * @param {ArrayLike<number>} [scaleFactors]
   */
  constructor(wordLengths = null, scaleFactors = null) {
    this.wordLengths = new Int32Array(ALLOCATION_BAND_COUNT)
    this.initialWordLengths = new Int32Array(ALLOCATION_BAND_COUNT)
    this.scaleFactorIndices = new Int32Array(ALLOCATION_BAND_COUNT)
    this.timeFactors = new Int32Array(ALLOCATION_BAND_COUNT)
    this.bitsByBand = new Int32Array(ALLOCATION_BAND_COUNT)
    this.quantizedSpectrum = new Int32Array(FRAME_SAMPLES)
    this.timeFactorLimit = 0
    this.sumBits = 0
    if (wordLengths && scaleFactors) this.reset(wordLengths, scaleFactors)
  }

  /**
   * Reset all derived fields from one pair of seed vectors.
   *
   * @param {ArrayLike<number>} wordLengths
   * @param {ArrayLike<number>} scaleFactors
   * @returns {SoundUnitAllocationCandidate}
   */
  reset(wordLengths, scaleFactors) {
    this.wordLengths.set(wordLengths)
    this.initialWordLengths.set(wordLengths)
    this.scaleFactorIndices.set(scaleFactors)
    this.timeFactors.fill(0)
    this.bitsByBand.fill(0)
    this.quantizedSpectrum.fill(0)
    this.timeFactorLimit = 0
    this.sumBits = 0
    return this
  }

  /**
   * Copy this candidate into existing destination storage.
   *
   * @param {SoundUnitAllocationCandidate} destination
   * @returns {SoundUnitAllocationCandidate}
   */
  copyTo(destination) {
    destination.wordLengths.set(this.wordLengths)
    destination.initialWordLengths.set(this.initialWordLengths)
    destination.scaleFactorIndices.set(this.scaleFactorIndices)
    destination.timeFactors.set(this.timeFactors)
    destination.bitsByBand.set(this.bitsByBand)
    destination.quantizedSpectrum.set(this.quantizedSpectrum)
    destination.timeFactorLimit = this.timeFactorLimit
    destination.sumBits = this.sumBits
    return destination
  }
}

/** Stage-private storage for exact sound-unit allocation searches. */
export class SoundUnitAllocationScratch {
  /** Allocate all fixed-capacity allocation candidates and measurements. */
  constructor() {
    const fillCandidateCount =
      ALLOCATION_BAND_COUNT * SOUND_UNIT_FILL_MOVES_PER_BAND
    this.normalizedSpectrum = new Float32Array(FRAME_SAMPLES)
    this.originalScaleProfile = new Int32Array(FRAME_SAMPLES / 4)
    this.transformedScaleProfile = new Int32Array(FRAME_SAMPLES / 4)
    this.originalScaleFactors = new Int32Array(ALLOCATION_BAND_COUNT)
    this.transformedScaleFactors = new Int32Array(ALLOCATION_BAND_COUNT)
    this.thresholds = new Float32Array(ALLOCATION_BAND_COUNT)
    this.translatedWordLengths = new Int32Array(ALLOCATION_BAND_COUNT)
    this.gateWordLengths = new Int32Array(ALLOCATION_BAND_COUNT)
    this.candidateSymbols = new Int32Array(MAX_QUANTIZATION_BAND_COEFFICIENTS)
    this.reconstructedSpectrum = new Float32Array(FRAME_SAMPLES)
    this.unityScaleIndices = new Int32Array(ALLOCATION_BAND_COUNT).fill(15)
    this.fillCandidates = {
      valid: new Uint8Array(fillCandidateCount),
      wordLengths: new Int32Array(fillCandidateCount),
      timeFactors: new Int32Array(fillCandidateCount),
      bitDeltas: new Int32Array(fillCandidateCount),
      benefitsPerBit: new Float64Array(fillCandidateCount),
      waterfillScores: new Float64Array(fillCandidateCount),
    }
    this.seedCandidate = new SoundUnitAllocationCandidate()
    this.tuningCandidate = new SoundUnitAllocationCandidate()
    this.bestTuningCandidate = new SoundUnitAllocationCandidate()
    this.candidateBlock = new EncoderChannelBlock()
  }
}

/** Stage-private buffers for adaptive gain-point detection. */
export class GainAnalysisScratch {
  /** Allocate detector evidence reused for each channel and band. */
  constructor() {
    this.maxima = new Float32Array(64)
    this.groupMaxima = new Float32Array(16)
    this.candidates = Array.from({ length: GAIN_CANDIDATE_COUNT }, () => ({
      requestedStep: null,
      detected: false,
      selected: false,
    }))
    this.rankedCandidateSlots = new Int32Array(MAX_SELECTED_GAIN_CANDIDATES)
    this.levels = new Int32Array(ATTACK_CANDIDATE_COUNT + 1)
  }

  /**
   * Clear semantic detector flags without replacing candidate identities.
   *
   * @returns {object[]}
   */
  resetCandidates() {
    for (const candidate of this.candidates) {
      candidate.requestedStep = null
      candidate.detected = false
      candidate.selected = false
    }
    return this.candidates
  }
}

/** Stage-private buffers for gain-envelope reconstruction and comparison. */
export class GainScaleScratch {
  /** Allocate reusable envelopes, steps, and detached gain records. */
  constructor() {
    this.steps = new Int32Array(GAIN_STEP_COUNT)
    this.scale = new Float32Array(GAIN_SCALE_SAMPLES)
    this.incumbent = new Float32Array(GAIN_SCALE_SAMPLES)
    this.candidate = new Float32Array(GAIN_SCALE_SAMPLES)
    this.candidateRecord = new GainRecord()
    this.neutralRecords = Array.from(
      { length: SUBBAND_COUNT },
      () => new GainRecord()
    )
  }
}

/** Stage-private buffers for cascaded independent-channel QMF analysis. */
export class IndependentQmfScratch {
  /** Allocate the two first-stage branches and shared convolution storage. */
  constructor() {
    this.firstLow = new Float32Array(FRAME_SAMPLES / 2)
    this.firstHigh = new Float32Array(FRAME_SAMPLES / 2)
    this.convolutionWork = new Float64Array(QMF_DELAY + FRAME_SAMPLES)
  }
}

/** Stage-private work vectors for one 256-line forward MDCT. */
export class MdctScratch {
  /** Allocate pre-windowing and complex FFT work vectors. */
  constructor() {
    this.preWindowed = new Float32Array(256)
    this.real = new Float32Array(128)
    this.imaginary = new Float32Array(128)
  }
}

/** Committed cross-frame encoder histories for every maintained profile. */
export class EncoderState {
  /** Allocate neutral layered and independent encoder histories. */
  constructor() {
    this.jointStereoHistory = new JointStereoHistory()
    this.layeredHistories = Array.from(
      { length: MAX_CHANNELS },
      () => new LayerHistory()
    )
    this.independentChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new IndependentChannelHistory()
    )
  }
}

/** Detached frame transaction and named values carried between stages. */
export class EncoderFrameState {
  /** Allocate stable transaction storage shared by explicit frame stages. */
  constructor() {
    this.jointStereoWork = new JointStereoWork()
    this.layeredWork = Array.from(
      { length: MAX_CHANNELS },
      () => new LayerWork()
    )
    this.analysisWork = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(ANALYSIS_WORK_FLOATS)
    )
    this.channelBlocks = Array.from(
      { length: MAX_CHANNELS },
      () => new EncoderChannelBlock()
    )
    this.soundUnitCandidates = Array.from(
      { length: MAX_CHANNELS },
      () => new EncoderChannelBlock()
    )
    this.layeredAllocations = Array.from(
      { length: MAX_CHANNELS },
      () => new Int32Array(ALLOCATION_WORK_WORDS)
    )
    this.layerWords = Array.from(
      { length: MAX_CHANNELS },
      () => new Uint32Array(LAYER_WORDS)
    )
    this.layeredSymbols = Array.from(
      { length: MAX_CHANNELS },
      () => new Int32Array(FRAME_SAMPLES)
    )
    this.spectra = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(SPECTRUM_WORK_FLOATS)
    )
    this.analyzedSpectra = this.spectra.map((buffer) =>
      buffer.subarray(0, FRAME_SAMPLES)
    )
    this.referenceSpectra = this.spectra.map((buffer) =>
      buffer.subarray(FRAME_SAMPLES, FRAME_SAMPLES * 2)
    )
    this.preparedMdctWindows = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(SUBBAND_COUNT * GAIN_SCALE_SAMPLES)
    )
    this.preparedReferenceWindows = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(SUBBAND_COUNT * GAIN_SCALE_SAMPLES)
    )
    this.selectedSoundUnitBits = new Int32Array(MAX_CHANNELS)
    this.referenceTransformNeeded = new Uint8Array(MAX_CHANNELS)
    this.packedBytes = new Uint8Array(
      MAX_CODED_FRAME_BYTES + BITSTREAM_PADDING_BYTES
    )
  }
}

/**
 * Configure frame geometry and restore histories for one encoder stream.
 *
 * @param {object} profile Resolved stream profile.
 * @param {object} encoder Encoder pool ownership root.
 * @returns {object} Initialized encoder storage.
 */
export function initializeEncoderStream(profile, encoder) {
  const initialize = selectEncoderMode(
    profile,
    resetIndependent,
    configureLayered,
    configureLayered
  )
  initialize(profile, encoder)
  return encoder
}
