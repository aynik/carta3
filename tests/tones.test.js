import { describe, expect, it } from 'vitest'
import { extractMultitone } from '../codec/coding/tones.js'
import {
  TONE_POLICY_NONE,
  TONE_POLICY_THRESHOLD,
} from '../codec/core/constants.js'
import { EncoderChannelBlock } from '../codec/state/encoder.js'

describe('ATRAC3 multitone lowering', () => {
  it('deep-copies populated tone state into destination-owned lists', () => {
    const source = new EncoderChannelBlock()
    const destination = new EncoderChannelBlock()
    const destinationEntries = destination.toneEntries
    const destinationPool = destination.tonePool
    source.toneEntries.push({ count: 1, indices: new Int32Array([3, 5]) })
    source.tonePool.push({ start: 16, coefficients: new Int32Array([7, -2]) })

    source.copyTo(destination)

    expect(destination.toneEntries).toBe(destinationEntries)
    expect(destination.tonePool).toBe(destinationPool)
    expect(destination.toneEntries).toEqual(source.toneEntries)
    expect(destination.tonePool).toEqual(source.tonePool)
    expect(destination.toneEntries[0]).not.toBe(source.toneEntries[0])
    expect(destination.tonePool[0]).not.toBe(source.tonePool[0])
    source.toneEntries[0].indices[0] = 99
    source.tonePool[0].coefficients[0] = 99
    expect(destination.toneEntries[0].indices[0]).toBe(3)
    expect(destination.tonePool[0].coefficients[0]).toBe(7)
  })

  it('leaves every candidate field untouched under the no-tone policy', () => {
    const block = new EncoderChannelBlock()
    const residual = new Float32Array(1024).fill(20)
    const original = new Int32Array(256).fill(12)
    const transformed = new Int32Array(256).fill(60)
    expect(
      extractMultitone(
        1000,
        176,
        3,
        12,
        TONE_POLICY_NONE,
        original,
        transformed,
        residual,
        block
      )
    ).toBe(0)
    expect(block.toneEntryIndex).toBe(0)
    expect(block.toneCount).toBe(0)
  })

  it('admits, quantizes, and subtracts strong four-line groups', () => {
    const block = new EncoderChannelBlock()
    const residual = new Float32Array(1024)
    residual.set([4000, -3200, 2200, -1000], 16)
    const original = new Int32Array(256)
    const transformed = new Int32Array(256)
    original[4] = 10
    transformed[4] = 60
    const before = [...residual.slice(16, 20)]
    const bits = extractMultitone(
      1000,
      176,
      3,
      10,
      TONE_POLICY_THRESHOLD,
      original,
      transformed,
      residual,
      block
    )
    expect(bits).toBeGreaterThan(0)
    expect(block.toneEntryIndex).toBe(1)
    expect(block.toneCount).toBe(1)
    expect(block.tonePool[0].start).toBe(16)
    expect([...residual.slice(16, 20)]).not.toEqual(before)
  })

  it('does not publish an entry when its fixed side data exceeds budget', () => {
    const block = new EncoderChannelBlock()
    const original = new Int32Array(256)
    const transformed = new Int32Array(256)
    transformed[0] = 63
    expect(
      extractMultitone(
        8,
        1,
        3,
        0,
        TONE_POLICY_THRESHOLD,
        original,
        transformed,
        new Float32Array(1024).fill(100),
        block
      )
    ).toBe(0)
    expect(block.toneEntryIndex).toBe(0)
  })
})
