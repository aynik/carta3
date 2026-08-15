import { describe, expect, it } from 'vitest'
import { GainRecord } from '../codec/coding/gain.js'
import {
  reconstructGainPairSignal,
  reconstructGainScale,
} from '../codec/transforms/gain-scale.js'
import { GainScaleScratch } from '../codec/state/encoder.js'

function record(entries) {
  const result = new GainRecord()
  result.entries = entries.length
  entries.forEach(([location, level], index) => {
    result.locations[index] = location
    result.levels[index] = level
  })
  return result
}

describe('ATRAC3 forward gain scale', () => {
  it('produces unity for two inactive records', () => {
    const output = new Float32Array(512)
    expect(
      reconstructGainScale(record([]), record([]), output, new Int32Array(64))
    ).toBe(512)
    expect(output.every((value) => value === 1)).toBe(true)
  })

  it('matches the one-group descending reference transition', () => {
    const output = new Float32Array(512)
    reconstructGainScale(
      record([]),
      record([[0, 5]]),
      output,
      new Int32Array(64)
    )
    expect(output[511]).toBe(1)
    expect(output[263]).toBe(Math.fround(2 ** -0.125))
    expect(output[256]).toBe(0.5)
    expect(output[255]).toBe(0.5)
  })

  it('rejects invalid gain indices', () => {
    expect(
      reconstructGainScale(
        record([]),
        record([[0, 16]]),
        new Float32Array(512),
        new Int32Array(64)
      )
    ).toBeNull()
  })

  it('reconstructs and divides a complete gain-pair time signal', () => {
    const input = new Float32Array(256).fill(2)
    const overlap = new Float32Array(256).fill(4)
    const output = reconstructGainPairSignal(
      input,
      overlap,
      record([]),
      record([[0, 5]]),
      new Float32Array(512),
      new GainScaleScratch()
    )
    expect(output[0]).toBe(4)
    expect(output[255]).toBe(4)
    expect(output[511]).toBe(4)
  })
})
