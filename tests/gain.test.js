import { describe, expect, it } from 'vitest'
import {
  GainRecord,
  gainRecordBits,
  packGainRecords,
  readGainRecord,
  validateGainRecord,
} from '../codec/coding/gain.js'
import { BitCounter, BitReader, BitWriter } from '../codec/io/bitstream.js'

/**
 * Test helper for record.
 *
 * @param {Array<[number, number]>} entries
 * @returns {GainRecord}
 */
function record(entries) {
  const result = new GainRecord()
  result.entries = entries.length
  for (let index = 0; index < entries.length; index++) {
    result.locations[index] = entries[index][0]
    result.levels[index] = entries[index][1]
  }
  return result
}

describe('ATRAC3 gain records', () => {
  it('copies only coded fields and preserves detector history', () => {
    const source = record([
      [3, 4],
      [11, 7],
    ])
    source.peakHistory = 123
    const target = new GainRecord()
    target.peakHistory = 456
    target.copyCodedFieldsFrom(source)
    expect(target.codedEquals(source)).toBe(true)
    expect(target.peakHistory).toBe(456)
  })

  it('validates count, range, ordering, and adjacent levels', () => {
    expect(validateGainRecord(record([[3, 4]]))).toBeTruthy()
    expect(() => validateGainRecord(record([[32, 4]]))).toThrow(/location/)
    expect(() =>
      validateGainRecord(
        record([
          [3, 4],
          [2, 5],
        ])
      )
    ).toThrow(/ascending/)
    expect(() =>
      validateGainRecord(
        record([
          [2, 5],
          [3, 5],
        ])
      )
    ).toThrow(/must differ/)
  })

  it('round-trips raw count/level/location syntax and exact bit cost', () => {
    const records = [
      record([
        [5, 3],
        [11, 4],
      ]),
      record([]),
      record([[31, 15]]),
    ]
    const counter = new BitCounter()
    packGainRecords(records, counter)
    expect(counter.bitPosition).toBe(
      records.reduce((sum, item) => sum + gainRecordBits(item), 0)
    )
    const bytes = new Uint8Array(Math.ceil(counter.bitPosition / 8))
    const writer = new BitWriter(bytes)
    packGainRecords(records, writer)
    const reader = new BitReader(bytes)
    for (const expected of records) {
      expect(readGainRecord(reader).codedEquals(expected)).toBe(true)
    }
    expect(reader.bitPosition).toBe(counter.bitPosition)
  })
})
