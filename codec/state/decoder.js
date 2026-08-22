/** Carta3 Audio Codec - Decoder state and frame transactions. */

import {
  DECODER_MAX_UNITS,
  DECODER_PAIR_ENTRIES,
  DECODER_SPECTRUM_FLOATS_PER_UNIT,
  DECODER_UNIT_MODE_DEFAULT,
  DECODER_WORK_FLOATS,
  FRAME_SAMPLES,
  MAX_CHANNELS,
  RESIDUAL_DELAY_SAMPLES,
  SUBBAND_COUNT,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'

/** Fixed-capacity sentinel-terminated decoded gain-pair table. */
export class GainPairTable {
  /** Allocate an inactive table with an explicit terminal sentinel. */
  constructor() {
    this.starts = new Uint32Array(DECODER_PAIR_ENTRIES)
    this.gains = new Uint32Array(DECODER_PAIR_ENTRIES)
    this.starts[0] = 0xff
    this.gains[0] = 4
  }

  /**
   * Copy this table without replacing destination-owned arrays.
   *
   * @param {GainPairTable} destination Existing destination table.
   * @returns {GainPairTable} `destination` after the copy.
   */
  copyTo(destination) {
    destination.starts.set(this.starts)
    destination.gains.set(this.gains)
    return destination
  }

  /**
   * Restore an inactive sentinel-terminated table.
   *
   * @returns {GainPairTable}
   */
  reset() {
    this.starts.fill(0)
    this.gains.fill(0)
    this.starts[0] = 0xff
    this.gains[0] = 4
    return this
  }
}

/** Persistent inverse-transform and synthesis history for one channel. */
export class DecoderChannelHistory {
  /** Allocate compact transform, synthesis, and gain-table history. */
  constructor() {
    this.previousBlockCount = 0
    this.synthesisTail = new Float32Array(RESIDUAL_DELAY_SAMPLES)
    this.overlap = Array.from(
      { length: DECODER_MAX_UNITS },
      () => new Float32Array(DECODER_SPECTRUM_FLOATS_PER_UNIT)
    )
    this.pairTables = Array.from(
      { length: DECODER_MAX_UNITS },
      () => new GainPairTable()
    )
  }

  /**
   * Stage compact history into frame-local native synthesis work.
   *
   * @param {DecoderChannelWork} destination Existing frame work.
   * @returns {DecoderChannelWork} `destination` after staging.
   */
  stageTo(destination) {
    destination.previousBlockCount = this.previousBlockCount
    destination.synthesisBuffer.set(this.synthesisTail, FRAME_SAMPLES)
    for (let unit = 0; unit < DECODER_MAX_UNITS; unit++) {
      destination.overlap[unit].set(this.overlap[unit])
      this.pairTables[unit].copyTo(destination.pairTables[unit])
    }
    return destination
  }

  /**
   * Commit genuine channel histories from completed synthesis work.
   *
   * @param {DecoderChannelWork} source Completed frame work.
   * @returns {DecoderChannelHistory} This committed history.
   */
  commitFrom(source) {
    this.previousBlockCount = source.previousBlockCount
    this.synthesisTail.set(
      source.synthesisBuffer.subarray(
        FRAME_SAMPLES,
        FRAME_SAMPLES + RESIDUAL_DELAY_SAMPLES
      )
    )
    for (let unit = 0; unit < DECODER_MAX_UNITS; unit++) {
      this.overlap[unit].set(source.overlap[unit])
      source.pairTables[unit].copyTo(this.pairTables[unit])
    }
    return this
  }
}

/** Frame-owned native inverse-transform and synthesis work for one channel. */
export class DecoderChannelWork {
  /** Allocate one reusable complete synthesis image and staged histories. */
  constructor() {
    this.previousBlockCount = 0
    this.synthesisBuffer = new Float32Array(DECODER_WORK_FLOATS)
    this.overlap = Array.from(
      { length: DECODER_MAX_UNITS },
      () => new Float32Array(DECODER_SPECTRUM_FLOATS_PER_UNIT)
    )
    this.pairTables = Array.from(
      { length: DECODER_MAX_UNITS },
      () => new GainPairTable()
    )
  }
}

/** Validated current-frame joint header pending chronological publication. */
export class PendingJointHeader {
  /** Allocate fixed storage for one parsed shared-layout header. */
  constructor() {
    this.pairScaleIndex = -1
    this.gainScaleSelectors = new Uint8Array(SUBBAND_COUNT)
    this.unitMode = DECODER_UNIT_MODE_DEFAULT
  }
}

/** Complete current-frame joint-stereo signal decision. */
export class JointStereoMix {
  /** Allocate fixed previous/current gain and pair scale vectors. */
  constructor() {
    const scaleCount = SUBBAND_COUNT * 2
    this.previousGains = new Float32Array(scaleCount)
    this.gains = new Float32Array(scaleCount)
    this.previousPairs = new Float32Array(scaleCount)
    this.pairs = new Float32Array(scaleCount)
    this.transitions = new Uint8Array(SUBBAND_COUNT)
  }
}

/** Shared current/prior decoder header history. */
class DecoderHeaderState {
  /**
   * Derive initial header history from one resolved profile.
   *
   * @param {object} profile Immutable decoder profile.
   */
  constructor(profile) {
    this.jointStereoLayout = profile.bitrateKbps === 66
    this.gainScaleSelectors = new Uint8Array([3, 3, 3, 3])
    this.pairScaleIndex = -1
    this.unitMode = DECODER_UNIT_MODE_DEFAULT
    this.previousGainScaleSelectors = new Uint8Array([3, 3, 3, 3])
    this.previousPairScaleIndex = -1
    this.previousUnitMode = DECODER_UNIT_MODE_DEFAULT
    this.stepBytes = this.jointStereoLayout
      ? profile.bytesPerFrame
      : profile.bytesPerFrame / MAX_CHANNELS
  }

  /**
   * Copy this header history into existing destination storage.
   *
   * @param {DecoderHeaderState} destination
   * @returns {DecoderHeaderState}
   */
  copyTo(destination) {
    destination.jointStereoLayout = this.jointStereoLayout
    destination.gainScaleSelectors.set(this.gainScaleSelectors)
    destination.pairScaleIndex = this.pairScaleIndex
    destination.unitMode = this.unitMode
    destination.previousGainScaleSelectors.set(this.previousGainScaleSelectors)
    destination.previousPairScaleIndex = this.previousPairScaleIndex
    destination.previousUnitMode = this.previousUnitMode
    destination.stepBytes = this.stepBytes
    return destination
  }

  /**
   * Advance shared-layout chronology from one successfully decoded header.
   *
   * @param {PendingJointHeader} pending Validated current-frame header.
   * @returns {DecoderHeaderState} This advanced header history.
   */
  advanceFrom(pending) {
    this.previousGainScaleSelectors.set(this.gainScaleSelectors)
    this.previousPairScaleIndex = this.pairScaleIndex
    this.previousUnitMode = this.unitMode
    this.gainScaleSelectors.set(pending.gainScaleSelectors)
    this.pairScaleIndex = pending.pairScaleIndex
    this.unitMode = pending.unitMode
    return this
  }
}

/** Complete profile-bound persistent decoder state. */
export class DecoderState {
  /**
   * Create complete state for one resolved profile.
   *
   * @param {object} [options] Profile selection.
   */
  constructor(options = {}) {
    this.profile = resolveProfile(options)
    if (!this.profile)
      throw new RangeError('Unsupported ATRAC3 decoder profile')
    this.header = new DecoderHeaderState(this.profile)
    this.channels = Array.from(
      { length: MAX_CHANNELS },
      () => new DecoderChannelHistory()
    )
  }

  /**
   * Stage the complete committed history into frame-owned work.
   *
   * @param {DecoderFrameState} destination Prepared frame transaction.
   * @returns {DecoderFrameState} `destination` after staging.
   */
  stageTo(destination) {
    this.header.copyTo(destination.header)
    for (let channel = 0; channel < MAX_CHANNELS; channel++) {
      this.channels[channel].stageTo(destination.channels[channel])
    }
    return destination
  }

  /**
   * Commit the header and channel histories from completed frame work.
   *
   * @param {DecoderFrameState} source Completed frame transaction.
   * @returns {DecoderState} This committed state.
   */
  commitFrom(source) {
    source.header.copyTo(this.header)
    for (let channel = 0; channel < MAX_CHANNELS; channel++) {
      this.channels[channel].commitFrom(source.channels[channel])
    }
    return this
  }
}

/** Parsed channel syntax and reconstructed coefficients for one frame. */
export class DecodedChannelFrame {
  /** Allocate empty syntax tables, coefficient storage, and run metadata. */
  constructor() {
    this.samples = new Float32Array(FRAME_SAMPLES)
    this.pairTables = Array.from(
      { length: SUBBAND_COUNT },
      () => new GainPairTable()
    )
    this.coefficientBlocks = 0
    this.runs = []
  }

  /**
   * Clear variable syntax before parsing another channel frame.
   *
   * @returns {DecodedChannelFrame}
   */
  reset() {
    this.samples.fill(0)
    this.coefficientBlocks = 0
    this.runs.length = 0
    return this
  }
}

/** Detached decoder transaction and values carried between pipeline stages. */
export class DecoderFrameState {
  /** Allocate profile-neutral frame storage populated when decoding starts. */
  constructor() {
    this.header = null
    this.pendingJointHeader = new PendingJointHeader()
    this.jointStereoMix = new JointStereoMix()
    this.channels = Array.from(
      { length: MAX_CHANNELS },
      () => new DecoderChannelWork()
    )
    this.activeBlockCounts = new Uint8Array(MAX_CHANNELS)
    this.decodedChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new DecodedChannelFrame()
    )
  }

  /**
   * Prepare profile-bound header work when constructing a decoder.
   *
   * @param {object} profile Resolved decoder profile.
   * @returns {DecoderFrameState} This prepared frame owner.
   */
  prepare(profile) {
    this.header = new DecoderHeaderState(profile)
    return this
  }
}

/**
 * Allocate committed history and prepare detached work for one decoder stream.
 *
 * @param {object} profile Resolved stream profile.
 * @param {object} decoder Decoder pool ownership root.
 * @returns {object} Initialized decoder storage.
 */
export function initializeDecoderStream(profile, decoder) {
  decoder.state = new DecoderState(profile)
  decoder.frame.prepare(profile)
  return decoder
}
