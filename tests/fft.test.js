import { describe, expect, it } from 'vitest'
import { FFT } from '../codec/signal/fft.js'

describe('ATRAC3 complex FFT', () => {
  it.each([16, 64, 128])(
    'transforms a %i-point impulse without changing its exact amplitude',
    (size) => {
      const real = new Float32Array(size)
      const imaginary = new Float32Array(size)
      real[0] = 1

      FFT.transform(real, imaginary)

      expect([...real]).toEqual(Array(size).fill(1))
      expect([...imaginary]).toEqual(Array(size).fill(0))
    }
  )

  it.each([16, 64, 128])('resolves DC for a %i-point transform', (size) => {
    const real = new Float32Array(size).fill(1)
    const imaginary = new Float32Array(size)

    FFT.transform(real, imaginary)

    expect(real[0]).toBe(size)
    expect(imaginary[0]).toBe(0)
    expect([...real.subarray(1)]).toEqual(Array(size - 1).fill(0))
    expect([...imaginary.subarray(1)]).toEqual(Array(size - 1).fill(0))
  })
})
