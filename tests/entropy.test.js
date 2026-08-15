import { describe, expect, it } from 'vitest'
import {
  huffmanFamilies,
  measureHuffmanBits,
  writeHuffman,
} from '../codec/coding/entropy.js'
import { BitCounter, BitReader, BitWriter } from '../codec/io/bitstream.js'

describe('ATRAC3 grouped Huffman families', () => {
  it('materializes the exact family geometry once', () => {
    const families = huffmanFamilies()
    expect(families).toBe(huffmanFamilies())
    expect(families).toHaveLength(4)
    expect(families[0][1].codes).toHaveLength(16)
    expect(families[0][7].codes).toHaveLength(64)
    expect(families[0][1].valuesPerCodeword).toBe(2)
    expect(families[0][7].valuesPerCodeword).toBe(1)
    expect(families[2]).toBe(families[0])
  })

  it('shares exact grouped cost and emission traversal', () => {
    const table = huffmanFamilies()[0][1]
    const values = new Int32Array([0, 0, 1, -1, -2, 1, 0, 0])
    const expected = measureHuffmanBits(table, values)
    const counter = new BitCounter()
    expect(writeHuffman(table, values, counter)).toBe(expected)
    const output = new Uint8Array(16)
    const writer = new BitWriter(output)
    expect(writeHuffman(table, values, writer)).toBe(expected)
    expect(writer.bitPosition).toBe(expected)
  })

  it('emits right-aligned codewords through the MSB sink', () => {
    const table = huffmanFamilies()[1][7]
    const values = new Int32Array([-1, -2, 3, 0x42])
    const output = new Uint8Array(8)
    const writer = new BitWriter(output)
    writeHuffman(table, values, writer)
    const reader = new BitReader(output)
    expect(reader.read(6)).toBe(63)
    expect(reader.read(6)).toBe(62)
    expect(reader.read(6)).toBe(3)
    expect(reader.read(6)).toBe(2)
  })

  it('rejects odd paired runs', () => {
    expect(() =>
      measureHuffmanBits(huffmanFamilies()[0][1], new Int32Array([0]))
    ).toThrow(/even count/)
  })
})
