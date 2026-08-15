import { describe, expect, it } from 'vitest'
import { transformTables } from '../codec/core/tables.js'

const UINT64_MASK = 0xffffffffffffffffn
const floatView = new DataView(new ArrayBuffer(4))

function float32Bits(value) {
  floatView.setFloat32(0, value, true)
  return floatView.getUint32(0, true)
}

function checksum(values) {
  let sum = 0n
  let xor = 0n
  for (const value of values) {
    const word = BigInt(value)
    sum = (sum + word) & UINT64_MASK
    xor ^= word
  }
  return [sum, xor]
}

const f32Checksum = (values) => checksum([...values].map(float32Bits))
const u32Checksum = (values) => checksum(values)
const i16Checksum = (values) =>
  checksum([...values].map((value) => value & 0xffff))
const u8Checksum = (values) => checksum(values)

describe('ATRAC3 runtime transform tables', () => {
  it('is initialized once and has the pinned geometry', () => {
    const tables = transformTables()
    expect(transformTables()).toBe(tables)
    expect(tables.mdctPreRotationCosines).toHaveLength(128)
    expect(tables.mdctTwiddleCosines).toHaveLength(64)
    expect(tables.mdctWindow).toHaveLength(512)
    expect(tables.fftStagedCosines).toHaveLength(127)
    expect(tables.fftFinalCosines).toHaveLength(128)
    expect(tables.fftGrayBitReversalIndices).toHaveLength(256)
  })

  it('matches the bit-exact reference table checksums', () => {
    const tables = transformTables()
    expect(f32Checksum(tables.mdctPreRotationCosines)).toEqual([
      0x3ee5e31a34n,
      0x9b0d3000n,
    ])
    expect(f32Checksum(tables.mdctPreRotationSines)).toEqual([
      0x5f4155ea34n,
      0x3f800000n,
    ])
    expect(f32Checksum(tables.mdctTwiddleCosines)).toEqual([
      0x1f26f52b60n,
      0x9b0d3000n,
    ])
    expect(f32Checksum(tables.mdctTwiddleSines)).toEqual([
      0x2f8267fb60n,
      0x3f800000n,
    ])
    expect(u32Checksum(tables.mdctBitReversalIndices)).toEqual([0x1fc0n, 0n])
    expect(f32Checksum(tables.mdctWindow)).toEqual([0x7cf3c8c84en, 0n])
    expect(f32Checksum(tables.mdctBaseCosineMinusFifthSine)).toEqual([
      0x2974ee2688n,
      0x85166492n,
    ])
    expect(f32Checksum(tables.mdctBaseCosinePlusFifthSine)).toEqual([
      0x1f84aff964n,
      0x050c96d6n,
    ])
    expect(f32Checksum(tables.mdctFifthCosinePlusBaseSine)).toEqual([
      0x3f195f12b0n,
      0x0602f046n,
    ])
    expect(f32Checksum(tables.mdctFifthCosineMinusBaseSine)).toEqual([
      0x49dfcbf57en,
      0x849c6d1en,
    ])
    expect(i16Checksum(tables.fftStagedCosines)).toEqual([0x40e12fn, 0xbc0bn])
    expect(i16Checksum(tables.fftStagedSines)).toEqual([0x287e02n, 0x43f4n])
    expect(i16Checksum(tables.fftFinalCosines)).toEqual([0x28de25n, 0x29c1n])
    expect(i16Checksum(tables.fftFinalSines)).toEqual([0x289e24n, 0x7b54n])
    expect(u8Checksum(tables.fftGrayBitReversalIndices)).toEqual([0x7f80n, 0n])
  })
})
