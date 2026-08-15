/** Carta3 Audio Codec - Immutable bitstream syntax records. */

import { CHANNEL_SYNC, SPECTRUM_GROUPS } from '../core/constants.js'

/** Independent-channel sound-unit header syntax. */
export class IndependentChannelHeader {
  /**
   * Create an independent header from its two-bit unit mode.
   * @param {number} unitMode Zero-based highest active transform unit.
   */
  constructor(unitMode) {
    this.unitMode = unitMode & 3
  }

  /**
   * Create a header from a one-based transform-unit count.
   * @param {number} unitCount Active transform-unit count.
   * @returns {IndependentChannelHeader} Normalized header.
   */
  static fromUnitCount(unitCount) {
    return new IndependentChannelHeader((unitCount - 1) & 0xffffffff)
  }

  /**
   * Decode the semantic unit mode from one raw header byte.
   * @param {number} raw Raw independent-channel header byte.
   * @returns {IndependentChannelHeader} Decoded header.
   */
  static unpack(raw) {
    return new IndependentChannelHeader(raw & 3)
  }

  /**
   * Validate the six-bit ATRAC3 channel sync prefix.
   * @param {number} raw Raw independent-channel header byte.
   * @returns {boolean} Whether the sync prefix is valid.
   */
  static isValid(raw) {
    return (raw & 0xfc) === CHANNEL_SYNC << 2
  }

  /** @returns {number} Complete raw independent-channel header byte. */
  get raw() {
    return ((CHANNEL_SYNC << 2) + this.unitMode) & 0xff
  }

  /**
   * Write the header to a bit sink.
   * @param {{write: Function}} sink Bit writer or exact counter.
   * @returns {void}
   */
  pack(sink) {
    sink.write(CHANNEL_SYNC, 6)
    sink.write(this.unitMode, 2)
  }
}

/** Shared-layout joint-stereo header syntax. */
export class JointStereoHeader {
  /**
   * Preserve the two raw shared-layout header bytes.
   * @param {number} first First header byte.
   * @param {number} second Second header byte.
   */
  constructor(first, second) {
    this.first = first & 0xff
    this.second = second & 0xff
  }

  /**
   * Build shared-layout bytes from prior output and gain selectors.
   * @param {number} previousOutput Prior joint-stereo output selector.
   * @param {ArrayLike<number>} gainSelectors Four interleaved gain selectors.
   * @param {number} unitMode Zero-based highest active transform unit.
   * @returns {JointStereoHeader} Encoded shared-layout header.
   */
  static create(previousOutput, gainSelectors, unitMode) {
    const [h0, h1, h2, h3] = gainSelectors
    return new JointStereoHeader(
      h1 + (h0 + previousOutput * 4) * 4,
      (h3 + h2 * 4) * 16 + 0x0c + unitMode
    )
  }

  /**
   * Wrap two raw shared-layout bytes.
   * @param {number} first First header byte.
   * @param {number} second Second header byte.
   * @returns {JointStereoHeader} Decoded header wrapper.
   */
  static unpack(first, second) {
    return new JointStereoHeader(first, second)
  }

  /** @returns {boolean} Whether reserved shared-layout marker bits are valid. */
  get isValid() {
    return (this.second & 0x0c) === 0x0c
  }

  /** @returns {Uint8Array} Detached two-byte representation. */
  get bytes() {
    return new Uint8Array([this.first, this.second])
  }

  /** @returns {number} Zero-based highest active transform unit. */
  get unitMode() {
    return this.second & 3
  }

  /** @returns {Uint32Array} Four interleaved gain selectors. */
  get gainSelectors() {
    return new Uint32Array([
      (this.first >> 2) & 3,
      this.first & 3,
      (this.second >> 6) & 3,
      (this.second >> 4) & 3,
    ])
  }
}

/** Spectrum allocation syntax for one sound unit. */
export class SpectrumAllocation {
  /**
   * Normalize one spectrum allocation into fixed-capacity syntax arrays.
   * @param {number} groupCount Active quantization-band prefix length.
   * @param {number} tableSelector Huffman family selector.
   * @param {ArrayLike<number>} wordLengths Per-band coded word lengths.
   * @param {ArrayLike<number>} scaleFactors Per-band scale-factor indices.
   */
  constructor(groupCount, tableSelector, wordLengths, scaleFactors) {
    if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > 32) {
      throw new RangeError('ATRAC3 spectrum group count must be in 1..32')
    }
    this.groupCount = groupCount
    this.tableSelector = tableSelector & 1
    this.wordLengths = new Uint8Array(SPECTRUM_GROUPS)
    this.scaleFactors = new Uint8Array(SPECTRUM_GROUPS)
    this.scaleFactorMask = 0

    for (let band = 0; band < groupCount; band++) {
      const wordLength = wordLengths[band] ?? 0
      this.wordLengths[band] = wordLength
      if (wordLength !== 0) {
        this.scaleFactors[band] = scaleFactors[band] ?? 0
        this.scaleFactorMask = (this.scaleFactorMask | (2 ** band)) >>> 0
      }
    }
  }

  /**
   * Read a complete spectrum allocation from a bit reader.
   * @param {{read: Function}} reader Reader positioned at allocation metadata.
   * @returns {SpectrumAllocation} Decoded allocation.
   */
  static read(reader) {
    const groupCount = reader.read(5) + 1
    const tableSelector = reader.read(1)
    const wordLengths = new Uint8Array(groupCount)
    const scaleFactors = new Uint8Array(groupCount)
    for (let band = 0; band < groupCount; band++) {
      wordLengths[band] = reader.read(3)
    }
    for (let band = 0; band < groupCount; band++) {
      if (wordLengths[band] !== 0) scaleFactors[band] = reader.read(6)
    }
    return new SpectrumAllocation(
      groupCount,
      tableSelector,
      wordLengths,
      scaleFactors
    )
  }

  /**
   * Write allocation metadata to a bit sink.
   * @param {{write: Function}} sink Bit writer or exact counter.
   * @returns {void}
   */
  pack(sink) {
    sink.write(this.groupCount - 1, 5)
    sink.write(this.tableSelector, 1)
    for (let band = 0; band < this.groupCount; band++) {
      sink.write(this.wordLengths[band], 3)
    }
    for (let band = 0; band < this.groupCount; band++) {
      if ((this.scaleFactorMask & (2 ** band)) !== 0) {
        sink.write(this.scaleFactors[band], 6)
      }
    }
  }

  /** @returns {number} Exact allocation metadata length in bits. */
  get packedBits() {
    let active = 0
    for (let band = 0; band < this.groupCount; band++) {
      if ((this.scaleFactorMask & (2 ** band)) !== 0) active++
    }
    return 6 + this.groupCount * 3 + active * 6
  }
}

/** Tone-section header syntax. */
export class ToneSectionHeader {
  /**
   * Create a tone-section header, forcing mode zero when empty.
   * @param {number} regionCount Number of tone regions.
   * @param {number} mode Tone table-selection mode.
   */
  constructor(regionCount, mode) {
    this.regionCount = regionCount
    this.mode = regionCount === 0 ? 0 : mode
  }

  /**
   * Read a tone-section header.
   * @param {{read: Function}} reader Reader positioned at tone metadata.
   * @returns {ToneSectionHeader} Decoded header.
   */
  static read(reader) {
    const regionCount = reader.read(5)
    return new ToneSectionHeader(
      regionCount,
      regionCount === 0 ? 0 : reader.read(2)
    )
  }

  /**
   * Write a tone-section header.
   * @param {{write: Function}} sink Bit writer or exact counter.
   * @returns {void}
   */
  pack(sink) {
    sink.write(this.regionCount, 5)
    if (this.regionCount !== 0) sink.write(this.mode, 2)
  }
}

/** Tone-region header syntax. */
export class ToneRegionHeader {
  /**
   * Create one tone-region descriptor for the active channel count.
   * @param {number} channelMask Active-channel mask.
   * @param {number} descriptor Tone coefficient-length descriptor.
   * @param {number} codeIndex Tone Huffman code index.
   * @param {number} channelCount Active transform-unit count.
   */
  constructor(channelMask, descriptor, codeIndex, channelCount) {
    this.channelMask = channelMask
    this.descriptor = descriptor
    this.codeIndex = codeIndex
    this.channelCount = channelCount
  }

  /**
   * Read one tone-region descriptor.
   * @param {number} channelCount Active transform-unit count.
   * @param {{read: Function}} reader Reader positioned at the descriptor.
   * @returns {ToneRegionHeader} Decoded region header.
   */
  static read(channelCount, reader) {
    return new ToneRegionHeader(
      reader.read(channelCount),
      reader.read(3),
      reader.read(3),
      channelCount
    )
  }

  /**
   * Write one tone-region descriptor.
   * @param {{write: Function}} sink Bit writer or exact counter.
   * @returns {void}
   */
  pack(sink) {
    sink.write(this.channelMask, this.channelCount)
    sink.write(this.descriptor, 3)
    sink.write(this.codeIndex, 3)
  }

  /** @returns {number} Decoder initial coefficient-count field. */
  get decoderBaseLength() {
    return ((this.descriptor << 3) | this.codeIndex) >> (this.channelCount - 1)
  }

  /** @returns {number} Decoder channel-mask shift register. */
  get decoderShiftRegister() {
    return (this.channelMask << (7 - this.channelCount)) & 0xff
  }
}

/** Tone-list count syntax. */
export class ToneListCount {
  /**
   * Create a three-bit tone list count.
   * @param {number} count Number of tone items in the list.
   */
  constructor(count) {
    this.count = count
  }

  /**
   * Read a tone list count.
   * @param {{read: Function}} reader Reader positioned at the list count.
   * @returns {ToneListCount} Decoded list count.
   */
  static read(reader) {
    return new ToneListCount(reader.read(3))
  }

  /**
   * Write a tone list count.
   * @param {{write: Function}} sink Bit writer or exact counter.
   * @returns {void}
   */
  pack(sink) {
    sink.write(this.count, 3)
  }
}

/** Tone-item header syntax. */
export class ToneItemHeader {
  /**
   * Create one tone item's scale-factor and start-position header.
   * @param {number} scaleFactor Six-bit spectral scale-factor index.
   * @param {number} start Six-bit start position within the tone region.
   */
  constructor(scaleFactor, start) {
    this.scaleFactor = scaleFactor
    this.start = start
  }

  /**
   * Read one tone item header.
   * @param {{read: Function}} reader Reader positioned at the item header.
   * @returns {ToneItemHeader} Decoded item header.
   */
  static read(reader) {
    return new ToneItemHeader(reader.read(6), reader.read(6))
  }

  /**
   * Write one tone item header.
   * @param {{write: Function}} sink Bit writer or exact counter.
   * @returns {void}
   */
  pack(sink) {
    sink.write(this.scaleFactor, 6)
    sink.write(this.start, 6)
  }
}
