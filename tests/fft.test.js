import { describe, expect, it } from 'vitest'
import { FFT } from '../codec/signal/fft.js'

describe('ATRAC3 complex FFT', () => {
  it('transforms an impulse without changing its exact amplitude', () => {
    const real = new Float32Array(128)
    const imaginary = new Float32Array(128)
    real[0] = 1

    FFT.transform(real, imaginary)

    expect([...real]).toEqual(Array(128).fill(1))
    expect([...imaginary]).toEqual(Array(128).fill(0))
  })

  it('requires the pinned transform geometry', () => {
    expect(() =>
      FFT.transform(new Float32Array(64), new Float32Array(64))
    ).toThrow(/128-value/)
    expect(() => FFT.transform([], [])).toThrow(/128-value/)
  })
})
