import { describe, expect, it } from 'vitest'
import { GainRecord } from '../codec/coding/gain.js'
import {
  countSoundUnitBits,
  countSoundUnitFixedBits,
  packSoundUnit,
} from '../codec/io/sound-unit.js'
import { BitReader } from '../codec/io/bitstream.js'

/**
 * Test helper for minimalSyntax.
 *
 * @returns {object}
 */
function minimalSyntax() {
  return {
    spectrumGroupCount: 1,
    componentGroupCount: 1,
    componentMode: 1,
    spectrumTableIndex: 0,
    gainRecords: Array.from({ length: 4 }, () => new GainRecord()),
    toneEntryIndex: 0,
    toneEntries: [],
    tonePool: [],
    wordLengths: new Int32Array(32),
    scaleFactorIndices: new Int32Array(32),
    quantizedSpectrum: new Int32Array(1024),
    scratchFlag: 0,
  }
}

describe('ATRAC3 independent sound-unit packing', () => {
  it('matches the minimal syntax reference traversal', () => {
    const syntax = minimalSyntax()
    expect(countSoundUnitFixedBits(syntax)).toBe(11)
    expect(countSoundUnitBits(syntax)).toBe(25)
    const output = new Uint8Array(64)
    expect(packSoundUnit(syntax, 25, output)).toBe(25)
    const reader = new BitReader(output)
    expect(reader.read(6)).toBe(0x28)
    expect(reader.read(2)).toBe(0)
    expect(reader.read(3)).toBe(0)
    expect(reader.read(5)).toBe(0)
    expect(reader.read(5)).toBe(0)
    expect(reader.read(1)).toBe(0)
    expect(reader.read(3)).toBe(0)
    expect(reader.bitPosition).toBe(25)
  })

  it('prices and emits an active paired spectral band identically', () => {
    const syntax = minimalSyntax()
    syntax.wordLengths[0] = 1
    syntax.scaleFactorIndices[0] = 17
    syntax.quantizedSpectrum.set([0, 0, 1, -1, -1, 1, 0, 0])
    const required = countSoundUnitBits(syntax)
    const output = new Uint8Array(64)
    expect(packSoundUnit(syntax, required, output)).toBe(required)
    expect(required).toBeGreaterThan(25)
  })

  it('verifies the allocation ledger during single-pass packing', () => {
    const syntax = minimalSyntax()
    const exactBits = countSoundUnitBits(syntax)
    expect(packSoundUnit(syntax, exactBits, new Uint8Array(64))).toBe(exactBits)
    expect(() =>
      packSoundUnit(syntax, exactBits + 1, new Uint8Array(64))
    ).toThrow(/expected 26, wrote 25/)
  })

  it('rejects scratch units', () => {
    const syntax = minimalSyntax()
    syntax.scratchFlag = 1
    expect(countSoundUnitFixedBits(syntax)).toBe(19)
    expect(() => countSoundUnitBits(syntax)).toThrow(/Scratch/)
  })

  it('rejects invalid tone and spectrum selector states', () => {
    const syntax = minimalSyntax()
    syntax.toneEntryIndex = 1
    syntax.componentMode = 3
    syntax.toneEntries = [{}]
    expect(() => countSoundUnitBits(syntax)).toThrow(/mode 3/)
    syntax.toneEntryIndex = 0
    syntax.componentMode = 1
    syntax.spectrumTableIndex = 2
    expect(() => countSoundUnitBits(syntax)).toThrow(/selector/)
  })
})
