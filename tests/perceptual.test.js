import { describe, expect, it } from 'vitest'
import { buildReconstructionMask } from '../codec/analysis/perceptual.js'

describe('ATRAC3 reconstruction masking profile', () => {
  it('keeps silence thresholds finite and strictly positive', () => {
    const thresholds = buildReconstructionMask(
      new Float32Array(1024),
      new Int32Array(32),
      29
    )
    expect(
      thresholds.every((value) => Number.isFinite(value) && value > 0)
    ).toBe(true)
  })

  it('spreads one low-band masker farther upward than downward', () => {
    const spectrum = new Float32Array(1024)
    spectrum[80] = 10
    const thresholds = buildReconstructionMask(
      spectrum,
      new Int32Array(32).fill(15),
      29
    )
    expect(thresholds[10]).toBeGreaterThan(thresholds[8])
    expect(thresholds[11]).toBeGreaterThan(thresholds[7])
  })
})
