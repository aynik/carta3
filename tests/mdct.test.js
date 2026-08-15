import { describe, expect, it } from 'vitest'
import { forwardMdct256 } from '../codec/transforms/mdct.js'
import { MdctScratch } from '../codec/state/encoder.js'

const bitsView = new DataView(new ArrayBuffer(4))

/**
 * Test helper for floatBits.
 *
 * @param {number} value
 * @returns {number}
 */
function floatBits(value) {
  bitsView.setFloat32(0, value, true)
  return bitsView.getUint32(0, true)
}

/**
 * Test helper for checksum.
 *
 * @param {ArrayLike<number>} values
 * @returns {number}
 */
function checksum(values) {
  let sum = 0n
  let xor = 0n
  for (const value of values) {
    const bits = BigInt(floatBits(value))
    sum = (sum + bits) & 0xffffffffffffffffn
    xor ^= bits
  }
  return [sum, xor]
}

/**
 * Test helper for referenceSignal.
 *
 * @returns {Float32Array}
 */
function referenceSignal() {
  const source = new Float32Array(512)
  for (let index = 0; index < source.length; index++) {
    source[index] =
      (((index * 73) % 257) - 128) / 128 + (((index * 19) % 31) - 15) / 64
  }
  return source
}

describe('ATRAC3 forward MDCT', () => {
  it('keeps caller-owned scratch and validates geometry', () => {
    const scratch = new MdctScratch()
    const output = new Float32Array(256)
    expect(forwardMdct256(new Float32Array(512), output, false, scratch)).toBe(
      output
    )
    expect(output.every((value) => value === 0)).toBe(true)
    expect(() =>
      forwardMdct256(new Float32Array(511), output, false, scratch)
    ).toThrow(/512 input/)
    expect(() => forwardMdct256(new Float32Array(512), output, false)).toThrow(
      /scratch/
    )
  })

  it('reverses only the final coefficient order', () => {
    const source = referenceSignal()
    const forward = new Float32Array(256)
    const reversed = new Float32Array(256)
    forwardMdct256(source, forward, false, new MdctScratch())
    forwardMdct256(source, reversed, true, new MdctScratch())
    expect([...reversed]).toEqual([...forward].reverse())
  })

  it('matches the reference vector checksum', () => {
    const output = new Float32Array(256)
    forwardMdct256(referenceSignal(), output, false, new MdctScratch())
    // Captured from an isolated forward_mdct_256 reference contract.
    expect(checksum(output)).toEqual([0x7bfe07a00fn, 0x0705378fn])
  })
})
