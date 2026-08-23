/** Carta3 gain-control syntax. */

import {
  GAIN_LEVEL_MAX,
  GAIN_LOCATION_MAX,
  GAIN_SLOT_COUNT,
} from '../core/constants.js'
import { GainRecord } from '../state/gain.js'

/**
 * Validate one wire-visible gain record.
 *
 * @param {object} record
 * @returns {object}
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
 * Return the exact encoded length of one gain record.
 *
 * @param {object} record
 * @returns {number}
 */
export function gainRecordBits(record) {
  if (record.entries < 0 || record.entries > GAIN_SLOT_COUNT) {
    throw new RangeError('ATRAC3 gain point count must be in 0..7')
  }
  return 3 + record.entries * 9
}

/**
 * Pack ordered transform-unit gain records.
 *
 * @param {object[]} records
 * @param {object} sink
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
 * Read one gain record.
 *
 * @param {object} reader
 * @returns {object}
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
