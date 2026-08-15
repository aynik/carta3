/** Carta3 Audio Codec - Gain-control syntax and validation. */

import {
  GAIN_LEVEL_MAX,
  GAIN_LOCATION_MAX,
  GAIN_SLOT_COUNT,
} from '../core/constants.js'

/**
 * Coded gain-control record plus the detector history carried with that record.
 *
 * `entries`, `locations`, and `levels` are syntax. `peakHistory` is explicitly
 * local encoder history and is never packed by this module.
 */
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
   * @param {GainRecord} source Record whose coded fields should be copied.
   * @returns {GainRecord} This destination record.
   */
  copyCodedFieldsFrom(source) {
    this.entries = source.entries
    const count = Math.min(source.entries, GAIN_SLOT_COUNT)
    this.locations.set(source.locations.subarray(0, count), 0)
    this.levels.set(source.levels.subarray(0, count), 0)
    return this
  }

  /**
   * Copy coded fields and detector history into existing destination storage.
   * @param {GainRecord} destination Existing destination record.
   * @returns {GainRecord} `destination` after the copy.
   */
  copyTo(destination) {
    destination.entries = this.entries
    destination.locations.set(this.locations)
    destination.levels.set(this.levels)
    destination.peakHistory = this.peakHistory
    return destination
  }

  /**
   * Create a detached copy including local detector history.
   * @returns {GainRecord} Independent record copy.
   */
  clone() {
    return this.copyTo(new GainRecord())
  }

  /**
   * Compare only fields that affect encoded gain syntax.
   * @param {GainRecord} other Record to compare.
   * @returns {boolean} Whether both records encode identical syntax.
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

/**
 * Validate the wire-visible geometry and ordering of one gain record.
 * @param {GainRecord} record Record to validate.
 * @returns {GainRecord} The validated input record.
 */
export function validateGainRecord(record) {
  if (
    !Number.isInteger(record.entries) ||
    record.entries < 0 ||
    record.entries > 7
  ) {
    throw new RangeError('ATRAC3 gain point count must be in 0..7')
  }
  let previousLocation = -1
  for (let index = 0; index < record.entries; index++) {
    const level = record.levels[index]
    const location = record.locations[index]
    if (level > GAIN_LEVEL_MAX) {
      throw new RangeError('ATRAC3 gain level must be in 0..15')
    }
    if (location > GAIN_LOCATION_MAX) {
      throw new RangeError('ATRAC3 gain location must be in 0..31')
    }
    if (location <= previousLocation) {
      throw new RangeError('ATRAC3 gain locations must be strictly ascending')
    }
    if (index > 0 && level === record.levels[index - 1]) {
      throw new RangeError('Adjacent ATRAC3 gain levels must differ')
    }
    previousLocation = location
  }
  return record
}

/**
 * Return the exact number of bits needed to code one gain record.
 * @param {GainRecord} record Gain record to measure.
 * @returns {number} Exact encoded length in bits.
 */
export function gainRecordBits(record) {
  if (record.entries < 0 || record.entries > GAIN_SLOT_COUNT) {
    throw new RangeError('ATRAC3 gain point count must be in 0..7')
  }
  return 3 + record.entries * 9
}

/**
 * Pack gain records to a bit-writer-compatible sink.
 * @param {GainRecord[]} records Ordered transform-unit gain records.
 * @param {{write: Function}} sink Bit writer or exact counter.
 * @returns {void}
 */
export function packGainRecords(records, sink) {
  for (const record of records) {
    if (record.entries < 0 || record.entries > GAIN_SLOT_COUNT) {
      throw new RangeError('ATRAC3 gain point count must be in 0..7')
    }
    sink.write(record.entries, 3)
    for (let entry = 0; entry < record.entries; entry++) {
      sink.write(record.levels[entry], 4)
      sink.write(record.locations[entry], 5)
    }
  }
}

/**
 * Read one gain record from a bit-reader-compatible source.
 * @param {{read: Function}} reader Reader positioned at the record count.
 * @returns {GainRecord} Decoded gain record.
 */
export function readGainRecord(reader) {
  const record = new GainRecord()
  record.entries = reader.read(3)
  for (let entry = 0; entry < record.entries; entry++) {
    record.levels[entry] = reader.read(4)
    record.locations[entry] = reader.read(5)
  }
  return record
}
