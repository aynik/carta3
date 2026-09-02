/** Carta3 single-precision complex fast Fourier transform. */

import { MDCT_BIT_REVERSE_INDICES, transformTables } from '../core/tables.js'
import { float32Add, float32Multiply, float32Subtract } from '../utils.js'

/** Complex radix-2 FFT with Carta3's pinned Float32 evaluation order. */
export class FFT {
  /**
   * Transform split complex data in place.
   *
   * @param {Float32Array} real Real input and output components.
   * @param {Float32Array} imaginary Imaginary input and output components.
   */
  static transform(real, imaginary) {
    if (
      !(real instanceof Float32Array) ||
      !(imaginary instanceof Float32Array) ||
      real.length !== 128 ||
      imaginary.length !== real.length
    ) {
      throw new RangeError('Carta3 FFT requires two 128-value Float32 arrays')
    }

    for (let pair = 0; pair < MDCT_BIT_REVERSE_INDICES.length; pair += 2) {
      const sourceIndex = MDCT_BIT_REVERSE_INDICES[pair]
      const destinationIndex = MDCT_BIT_REVERSE_INDICES[pair + 1]
      const realValue = real[sourceIndex]
      real[sourceIndex] = real[destinationIndex]
      real[destinationIndex] = realValue
      const imaginaryValue = imaginary[sourceIndex]
      imaginary[sourceIndex] = imaginary[destinationIndex]
      imaginary[destinationIndex] = imaginaryValue
    }

    const tables = transformTables()
    let step = 64
    let butterflyLength = 2
    for (let stage = 0; stage <= 6; stage++) {
      const half = butterflyLength >> 1
      let base = 0
      let secondLaneBase = half
      let groups = step
      while (groups !== 0) {
        let twiddleIndex = 0
        let butterflyCount = half
        let firstLane = base
        let secondLane = secondLaneBase
        while (butterflyCount !== 0) {
          const twiddleCosine = tables.mdctTwiddleCosines[twiddleIndex]
          const twiddleSine = tables.mdctTwiddleSines[twiddleIndex]
          const firstReal = real[firstLane]
          const firstImaginary = imaginary[firstLane]
          const secondReal = real[secondLane]
          const secondImaginary = imaginary[secondLane]
          const rotatedReal = float32Subtract(
            float32Multiply(secondReal, twiddleCosine),
            float32Multiply(secondImaginary, twiddleSine)
          )
          const rotatedImaginary = float32Add(
            float32Multiply(secondImaginary, twiddleCosine),
            float32Multiply(secondReal, twiddleSine)
          )
          real[secondLane] = float32Subtract(firstReal, rotatedReal)
          imaginary[secondLane] = float32Subtract(
            firstImaginary,
            rotatedImaginary
          )
          real[firstLane] = float32Add(firstReal, rotatedReal)
          imaginary[firstLane] = float32Add(firstImaginary, rotatedImaginary)
          twiddleIndex += step
          firstLane++
          secondLane++
          butterflyCount--
        }
        base += butterflyLength
        secondLaneBase += butterflyLength
        groups--
      }
      step >>= 1
      butterflyLength <<= 1
    }
  }
}
