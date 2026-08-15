/** Carta3 Audio Codec - Decoder state and frame transactions. */

import {
  DECODER_MAX_UNITS,
  DECODER_PAIR_ENTRIES,
  DECODER_SPECTRUM_FLOATS_PER_UNIT,
  DECODER_UNIT_MODE_DEFAULT,
  DECODER_WORK_FLOATS,
  FRAME_SAMPLES,
  MAX_CHANNELS,
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
export class DecoderChannelState {
  /** Allocate zeroed transform, overlap, and gain-table history. */
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

  /**
   * Copy this channel history into an existing decoder transaction.
   *
   * @param {DecoderChannelState} destination Existing destination channel.
   * @returns {DecoderChannelState} `destination` after the copy.
   */
  copyTo(destination) {
    destination.previousBlockCount = this.previousBlockCount
    destination.synthesisBuffer.set(this.synthesisBuffer)
    for (let unit = 0; unit < DECODER_MAX_UNITS; unit++) {
      destination.overlap[unit].set(this.overlap[unit])
      this.pairTables[unit].copyTo(destination.pairTables[unit])
    }
    return destination
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
      () => new DecoderChannelState()
    )
  }

  /**
   * Copy this complete decoder state into an existing transaction.
   *
   * @param {DecoderState} destination Existing destination state.
   * @returns {DecoderState} `destination` after the copy.
   */
  copyTo(destination) {
    destination.profile = this.profile
    this.header.copyTo(destination.header)
    for (let channel = 0; channel < MAX_CHANNELS; channel++) {
      this.channels[channel].copyTo(destination.channels[channel])
    }
    return destination
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
    this.decoderState = null
    this.activeBlockCounts = new Uint8Array(MAX_CHANNELS)
    this.decodedChannels = Array.from(
      { length: MAX_CHANNELS },
      () => new DecodedChannelFrame()
    )
  }
}
