/** Carta3 Audio Codec - Layered allocation and packing work image. */

import {
  ALLOCATION_ACTIVE_BANDS_WORD,
  ALLOCATION_BLOCK_COUNT_WORD,
  ALLOCATION_MODES_OFFSET,
  ALLOCATION_RESIDUAL_SPECTRUM_COUNT,
  ALLOCATION_RESIDUAL_SPECTRUM_OFFSET,
  ALLOCATION_SCALE_FACTOR_OFFSET,
  ALLOCATION_TONE_MODE_WORD,
  ALLOCATION_TONE_REGION_COUNT_WORD,
  ALLOCATION_TONE_REGIONS_OFFSET,
  ALLOCATION_TONE_REGION_WORDS,
  ALLOCATION_WORK_WORDS,
} from '../core/constants.js'
import { float32ToBits } from '../utils.js'

export { ALLOCATION_WORK_WORDS }

/**
 * Create a zeroed low-rate allocation word image.
 * @returns {Int32Array} Fixed-capacity allocation and packing storage.
 */
export function createAllocationWork() {
  return new Int32Array(ALLOCATION_WORK_WORDS)
}

/** Read-only typed views over a shared allocation word image. */
export class AllocationWorkView {
  /**
   * Wrap an existing allocation image without copying it.
   * @param {Int32Array} words Shared allocation word image.
   */
  constructor(words) {
    if (!(words instanceof Int32Array)) {
      throw new TypeError('ATRAC3 allocation work must be an Int32Array')
    }
    this.words = words
  }

  /**
   * Read one word, returning zero outside the available image.
   * @param {number} index Word index.
   * @returns {number} Signed stored word, or zero when out of range.
   */
  word(index) {
    return index >= 0 && index < this.words.length ? this.words[index] : 0
  }

  /** @returns {number} Untrusted stored active-band count. */
  get activeBandCountRaw() {
    return this.word(ALLOCATION_ACTIVE_BANDS_WORD)
  }

  /** @returns {number} Active-band count clamped to valid syntax geometry. */
  get activeBandCount() {
    return Math.max(0, Math.min(32, this.activeBandCountRaw))
  }

  /** @returns {number} Stored transform-block count. */
  get blockCount() {
    return this.word(ALLOCATION_BLOCK_COUNT_WORD)
  }

  /** @returns {number} Unsigned transform-unit count used by wire syntax. */
  get unitCount() {
    return this.blockCount >>> 0
  }

  /** @returns {number} Stored tone coding mode. */
  get toneMode() {
    return this.word(ALLOCATION_TONE_MODE_WORD) >>> 0
  }

  /** @returns {number} Stored number of tone regions. */
  get toneRegionCount() {
    return this.word(ALLOCATION_TONE_REGION_COUNT_WORD) >>> 0
  }

  /**
   * Read the residual mode for one quantization band.
   * @param {number} band Quantization-band index.
   * @returns {number} Stored residual mode.
   */
  mode(band) {
    return this.word(ALLOCATION_MODES_OFFSET + band)
  }

  /**
   * Read the residual scale factor for one quantization band.
   * @param {number} band Quantization-band index.
   * @returns {number} Stored scale-factor index.
   */
  scaleFactor(band) {
    return this.word(ALLOCATION_SCALE_FACTOR_OFFSET + band)
  }

  /**
   * Read one word from a fixed-width tone-region record.
   * @param {number} region Tone-region index.
   * @param {number} word Word offset within that region.
   * @returns {number} Stored tone-region word.
   */
  toneRegionWord(region, word) {
    return this.word(
      ALLOCATION_TONE_REGIONS_OFFSET +
        region * ALLOCATION_TONE_REGION_WORDS +
        word
    )
  }

  /**
   * Decode the bounded header of a variable tone subrecord.
   * @param {number} offset Subrecord word offset.
   * @returns {{symbolCount: number, tableIndex: number}|null} Header or null.
   */
  toneSubrecordHeader(offset) {
    if (offset < 0 || offset + 6 > this.words.length) return null
    return {
      symbolCount: this.words[offset + 5] >>> 0,
      tableIndex: (this.words[offset + 4] >>> 0) & 0x3f,
    }
  }

  /**
   * Read one symbol from a variable tone subrecord.
   * @param {number} offset First symbol word offset.
   * @param {number} symbol Symbol index within the subrecord.
   * @returns {number} Stored symbol word.
   */
  toneSubrecordSymbol(offset, symbol) {
    const index = offset + symbol
    return this.word(Number.isSafeInteger(index) ? index : this.words.length)
  }

  /**
   * Return the residual spectrum bit image.
   * @returns {Int32Array|null} Zero-copy spectrum words, or null when truncated.
   */
  residualSpectrum() {
    const end =
      ALLOCATION_RESIDUAL_SPECTRUM_OFFSET + ALLOCATION_RESIDUAL_SPECTRUM_COUNT
    return end <= this.words.length
      ? this.words.subarray(ALLOCATION_RESIDUAL_SPECTRUM_OFFSET, end)
      : null
  }
}

/** Mutable typed views over a shared allocation word image. */
export class AllocationWorkMut extends AllocationWorkView {
  /**
   * Publish the active residual band count.
   * @param {number} count Active band prefix length.
   * @returns {void}
   */
  setActiveBandCount(count) {
    this.words[ALLOCATION_ACTIVE_BANDS_WORD] = count
  }

  /**
   * Publish the number of transform blocks.
   * @param {number} count Active transform-block count.
   * @returns {void}
   */
  setBlockCount(count) {
    this.words[ALLOCATION_BLOCK_COUNT_WORD] = count
  }

  /**
   * Publish the tone coding mode.
   * @param {number} mode Tone syntax mode.
   * @returns {void}
   */
  setToneMode(mode) {
    this.words[ALLOCATION_TONE_MODE_WORD] = mode
  }

  /**
   * Publish the number of tone regions.
   * @param {number} count Tone-region count.
   * @returns {void}
   */
  setToneRegionCount(count) {
    this.words[ALLOCATION_TONE_REGION_COUNT_WORD] = count
  }

  /**
   * Reset all currently implemented tone syntax fields.
   * @returns {void}
   */
  clearToneSyntax() {
    this.setToneRegionCount(0)
    this.setToneMode(0)
  }

  /**
   * Set the residual mode for one band.
   * @param {number} band Quantization-band index.
   * @param {number} mode Residual coding mode.
   * @returns {void}
   */
  setMode(band, mode) {
    this.words[ALLOCATION_MODES_OFFSET + band] = mode
  }

  /**
   * Set the residual scale factor for one band.
   * @param {number} band Quantization-band index.
   * @param {number} scaleFactor Six-bit scale-factor index.
   * @returns {void}
   */
  setScaleFactor(band, scaleFactor) {
    this.words[ALLOCATION_SCALE_FACTOR_OFFSET + band] = scaleFactor
  }

  /**
   * Copy Float32 spectrum bits into the shared integer work image.
   * @param {Float32Array} spectrum Complete residual spectrum.
   * @returns {void}
   */
  copyResidualSpectrumBits(spectrum) {
    if (spectrum.length < ALLOCATION_RESIDUAL_SPECTRUM_COUNT) {
      throw new RangeError(
        'ATRAC3 residual spectrum requires 1024 coefficients'
      )
    }
    for (let index = 0; index < ALLOCATION_RESIDUAL_SPECTRUM_COUNT; index++) {
      this.words[ALLOCATION_RESIDUAL_SPECTRUM_OFFSET + index] =
        float32ToBits(spectrum[index]) | 0
    }
  }
}
