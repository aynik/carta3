import { describe, expect, it } from 'vitest'
import {
  quantizeNontoneSymbols,
  quantizeSpectralValue,
} from '../codec/coding/quantization.js'

describe('ATRAC3 sound-unit spectral quantization', () => {
  it('clamps every supported scalar lattice', () => {
    for (const steps of [1, 2, 3, 4, 7, 15, 31]) {
      expect(Math.abs(quantizeSpectralValue(1, 1, steps))).toBeLessThanOrEqual(
        steps
      )
      expect(quantizeSpectralValue(1000, 1, steps)).toBe(steps)
      expect(quantizeSpectralValue(-1000, 1, steps)).toBe(-steps)
    }
  })

  it('leaves output untouched for zero word length', () => {
    const output = new Int32Array(8).fill(99)
    expect(
      quantizeNontoneSymbols(0, 0, new Float32Array(8).fill(0.5), output)
    ).toBe(0)
    expect([...output]).toEqual(new Array(8).fill(99))
  })

  it('matches dead-zone and saturating-overflow behavior', () => {
    const spectrum = new Float32Array([
      0, 0.01, -0.01, 0.4, -0.4, 1e9, -1e9, 0.05,
    ])
    const output = new Int32Array(8)
    expect(quantizeNontoneSymbols(5, 0.05, spectrum, output)).toBe(8)
    expect([...output.slice(0, 3)]).toEqual([0, 0, 0])
    expect(output[7]).toBe(0)
    expect(output[5]).toBe(7)
    expect(output[6]).toBe(7)
  })
})
