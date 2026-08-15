import { describe, it, expect } from 'vitest'
import {
  absoluteMaximum,
  float32Add,
  float32FromBits,
  float32Multiply,
  float32Subtract,
  float32ToBits,
  float64FromBits,
  pipe,
} from '../codec/utils'

describe('Utilities', () => {
  it('shares exact float arithmetic and bit reinterpretation primitives', () => {
    expect(float32Add(1 / 3, 1 / 7)).toBe(Math.fround(1 / 3 + 1 / 7))
    expect(float32Subtract(1 / 3, 1 / 7)).toBe(Math.fround(1 / 3 - 1 / 7))
    expect(float32Multiply(1 / 3, 1 / 7)).toBe(Math.fround((1 / 3) * (1 / 7)))
    expect(float32FromBits(0x3f800000)).toBe(1)
    expect(float32ToBits(-1)).toBe(0xbf800000)
    expect(float64FromBits(0x3ff0000000000000n)).toBe(1)
    expect(absoluteMaximum(new Float32Array([-2, 7, -11, 5]), 1, 4)).toBe(11)
  })

  describe('pipe', () => {
    it('should compose functions correctly', () => {
      const context = {}
      const add = () => (x) => x + 1
      const multiply = () => (x) => x * 2
      const subtract = () => (x) => x - 3

      const pipeline = pipe(context, add, multiply, subtract)
      // (5 + 1) * 2 - 3 = 9
      expect(pipeline(5)).toBe(9)
    })

    it('should pass context to all stages', () => {
      const context = { value: 10 }
      const stage1 = (ctx) => (x) => x + ctx.value
      const stage2 = (ctx) => (x) => x * ctx.value

      const pipeline = pipe(context, stage1, stage2)
      // (5 + 10) * 10 = 150
      expect(pipeline(5)).toBe(150)
    })
  })
})
