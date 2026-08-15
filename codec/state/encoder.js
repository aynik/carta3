/** Carta3 Audio Codec - Encoder state, frame transactions, and scratch. */

import { GainRecord } from '../coding/gain.js'
import {
  ALLOCATION_BAND_COUNT,
  ALLOCATION_WORK_WORDS,
  ANALYSIS_WORK_FLOATS,
  ATTACK_CANDIDATE_COUNT,
  FRAME_SAMPLES,
  GAIN_CANDIDATE_COUNT,
  GAIN_SCALE_SAMPLES,
  GAIN_STEP_COUNT,
  MAX_CHANNELS,
  MAX_CODED_FRAME_BYTES,
  MAX_QUANTIZATION_BAND_COEFFICIENTS,
  MAX_SELECTED_GAIN_CANDIDATES,
  QMF_DELAY,
  SOUND_UNIT_FILL_MOVES_PER_BAND,
  SPECTRUM_WORK_FLOATS,
  SPECTRUM_GROUPS,
  SUBBAND_COUNT,
  BITSTREAM_PADDING_BYTES,
} from '../core/constants.js'
import { JointStereoState } from './joint-stereo.js'
import { LayerState, LayeredTransformState } from './layered.js'

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
    this.scratchFlag = 0
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
    destination.scratchFlag = this.scratchFlag
    return destination
  }

  /**
   * Seed a destination transaction with reusable choices and clear new syntax.
   *
   * @param {EncoderChannelBlock} destination Transaction-local destination.
   * @returns {EncoderChannelBlock} `destination` ready for analysis.
   */
  stageTo(destination) {
    destination.componentMode = this.componentMode
    destination.spectrumTableIndex = this.spectrumTableIndex
    destination.wordLengths.set(this.wordLengths)
    destination.scaleFactorIndices.set(this.scaleFactorIndices)
    destination.quantizedSpectrum.set(this.quantizedSpectrum)
    for (const record of destination.gainRecords) {
      record.entries = 0
      record.locations.fill(0)
      record.levels.fill(0)
      record.peakHistory = 0
    }
    destination.toneEntryIndex = 0
    destination.toneEntries.length = 0
    destination.tonePool.length = 0
    destination.toneCount = 0
    destination.scratchFlag = 0
    destination.spectrumGroupCount = SPECTRUM_GROUPS - 3
    destination.componentGroupCount = 3
    return destination
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
    this.jointStereo = new JointStereoState()
    this.layeredChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new LayerState()
    )
    this.independentChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(ANALYSIS_WORK_FLOATS)
    )
    this.channelBlockRing = Array.from({ length: MAX_CHANNELS }, () =>
      Array.from({ length: 3 }, () => new EncoderChannelBlock())
    )
    this.activeChannelBlockIndices = new Uint8Array(MAX_CHANNELS)
  }
}

/** Detached frame transaction and named values carried between stages. */
export class EncoderFrameState {
  /** Allocate stable transaction storage shared by explicit frame stages. */
  constructor() {
    this.jointStereo = new JointStereoState()
    this.layeredChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new LayerState()
    )
    this.independentChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new Float32Array(ANALYSIS_WORK_FLOATS)
    )
    this.channelBlocks = Array.from(
      { length: MAX_CHANNELS },
      () => new EncoderChannelBlock()
    )
    this.channelBlockIndices = new Uint8Array(MAX_CHANNELS)
    this.layeredAllocations = Array.from(
      { length: MAX_CHANNELS },
      () => new Int32Array(ALLOCATION_WORK_WORDS)
    )
    this.layeredTransformStates = Array.from(
      { length: MAX_CHANNELS },
      () => new LayeredTransformState()
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
    this.previousChannelBlocks = new Array(MAX_CHANNELS)
    this.selectedSoundUnitBits = new Int32Array(MAX_CHANNELS)
    this.referenceTransformNeeded = new Uint8Array(MAX_CHANNELS)
    this.packedBytes = new Uint8Array(
      MAX_CODED_FRAME_BYTES + BITSTREAM_PADDING_BYTES
    )
  }
}
