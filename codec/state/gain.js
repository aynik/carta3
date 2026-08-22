/** Carta3 gain-record state. */

import { GAIN_SLOT_COUNT } from '../core/constants.js'

/** Coded gain fields plus encoder-local detector history. */
export class GainRecord {
  /** Create an inactive record with fixed-capacity point storage. */
  constructor() {
    this.entries = 0
    this.locations = new Uint32Array(GAIN_SLOT_COUNT)
    this.levels = new Uint32Array(GAIN_SLOT_COUNT)
    this.peakHistory = 0
  }

  /**
   * Copy wire-visible fields while preserving destination-local detector state.
   *
   * @param {GainRecord} source
   * @returns {GainRecord}
   */
  copyCodedFieldsFrom(source) {
    this.entries = source.entries
    const count = Math.min(source.entries, GAIN_SLOT_COUNT)
    this.locations.set(source.locations.subarray(0, count), 0)
    this.levels.set(source.levels.subarray(0, count), 0)
    return this
  }

  /**
   * Copy coded fields and detector history into existing storage.
   *
   * @param {GainRecord} destination
   * @returns {GainRecord}
   */
  copyTo(destination) {
    destination.entries = this.entries
    destination.locations.set(this.locations)
    destination.levels.set(this.levels)
    destination.peakHistory = this.peakHistory
    return destination
  }

  /** @returns {GainRecord} Independent record copy. */
  clone() {
    return this.copyTo(new GainRecord())
  }

  /**
   * Compare only fields that affect encoded gain syntax.
   *
   * @param {GainRecord} other
   * @returns {boolean}
   */
  codedEquals(other) {
    if (this.entries !== other.entries) return false
    const count = Math.min(this.entries, GAIN_SLOT_COUNT)
    for (let index = 0; index < count; index++) {
      if (
        this.locations[index] !== other.locations[index] ||
        this.levels[index] !== other.levels[index]
      ) {
        return false
      }
    }
    return true
  }
}
