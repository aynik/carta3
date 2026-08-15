import { describe, expect, it } from 'vitest'
import { ANALYSIS_WORK_FLOATS, FRAME_SAMPLES } from '../codec/core/constants.js'
import {
  analyzeIndependentQmf,
  bandSplitOffset,
} from '../codec/transforms/qmf.js'
import { IndependentQmfScratch } from '../codec/state/encoder.js'

const bitsView = new DataView(new ArrayBuffer(4))

function checksum(values) {
  let sum = 0n
  let xor = 0n
  for (const value of values) {
    bitsView.setFloat32(0, value, true)
    const bits = BigInt(bitsView.getUint32(0, true))
    sum = (sum + bits) & 0xffffffffffffffffn
    xor ^= bits
  }
  return [sum, xor]
}

function frame(generation) {
  const values = new Float32Array(FRAME_SAMPLES)
  for (let index = 0; index < values.length; index++) {
    values[index] =
      (((index * (37 + generation * 2)) % 521) - 260) / 256 +
      (((index * 11 + generation * 7) % 29) - 14) / 64
  }
  return values
}

describe('ATRAC3 four-band QMF analysis', () => {
  it('keeps silence and all persistent state at zero', () => {
    const work = new Float32Array(ANALYSIS_WORK_FLOATS)
    expect(
      analyzeIndependentQmf(
        new Float32Array(FRAME_SAMPLES),
        work,
        new IndependentQmfScratch()
      )
    ).toBe(work)
    expect(work.every((value) => value === 0)).toBe(true)
  })

  it('advances three-deep history instead of replacing work storage', () => {
    const work = new Float32Array(ANALYSIS_WORK_FLOATS)
    const scratch = new IndependentQmfScratch()
    analyzeIndependentQmf(frame(0), work, scratch)
    const firstSplit = work.slice(bandSplitOffset(0), bandSplitOffset(0) + 256)
    analyzeIndependentQmf(frame(1), work, scratch)
    expect(work.slice(bandSplitOffset(0) - 256, bandSplitOffset(0))).toEqual(
      firstSplit
    )
  })

  it('matches the two-frame persistent-state reference checksum', () => {
    const work = new Float32Array(ANALYSIS_WORK_FLOATS)
    const scratch = new IndependentQmfScratch()
    analyzeIndependentQmf(frame(0), work, scratch)
    analyzeIndependentQmf(frame(1), work, scratch)
    expect(checksum(work)).toEqual([0x0425c3442c91n, 0x36c78d9dn])
  })
})
