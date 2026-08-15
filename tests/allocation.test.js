import { describe, expect, it } from 'vitest'
import {
  SoundUnitCandidateError,
  allocateNontoneSoundUnit,
  allocateSoundUnitCandidates,
} from '../codec/coding/allocation.js'
import { TONE_POLICY_THRESHOLD } from '../codec/core/constants.js'
import { BufferPool } from '../codec/core/buffers.js'
import { packSoundUnit } from '../codec/io/sound-unit.js'

function blockFromPool(pool, channel = 0) {
  return pool.encoder.state.channelBlockRing[channel][0]
}

describe('ATRAC3 132 kbps non-tone allocation baseline', () => {
  it('classifies an unfit speculative candidate without masking other errors', () => {
    const pool = new BufferPool()
    expect(() =>
      allocateNontoneSoundUnit(
        new Float32Array(1024),
        new Float32Array(1024),
        blockFromPool(pool),
        pool.encoder.state.channelBlockRing[0][1].gainRecords,
        0,
        pool.encoder.scratch.allocation
      )
    ).toThrow(SoundUnitCandidateError)

    const unexpected = new Error('unexpected tone candidate failure')
    const selected = new Proxy(blockFromPool(pool), {
      set(target, property, value) {
        if (property === 'toneEntries') throw unexpected
        return Reflect.set(target, property, value)
      },
    })
    expect(() =>
      allocateSoundUnitCandidates(
        new Float32Array(1024),
        new Float32Array(1024),
        selected,
        pool.encoder.scratch.allocation.candidateBlock,
        pool.encoder.state.channelBlockRing[0][1].gainRecords,
        1536,
        pool.encoder.scratch.allocation
      )
    ).toThrow(unexpected)
  })

  it('reduces silence to a valid minimal spectral prefix', () => {
    const pool = new BufferPool()
    const block = blockFromPool(pool)
    const bits = allocateNontoneSoundUnit(
      new Float32Array(1024),
      new Float32Array(1024),
      block,
      pool.encoder.state.channelBlockRing[0][1].gainRecords,
      1536,
      pool.encoder.scratch.allocation
    )
    expect(block.spectrumGroupCount).toBe(1)
    expect(block.componentGroupCount).toBe(3)
    expect(block.wordLengths[0]).toBe(0)
    expect(bits).toBeLessThanOrEqual(1536)
    expect(packSoundUnit(block, bits, new Uint8Array(192))).toBe(bits)
  })

  it('allocates a finite, packable spectrum inside the exact unit budget', () => {
    const pool = new BufferPool()
    const source = Float32Array.from({ length: 1024 }, (_, index) =>
      Math.fround(
        280 * Math.sin(index * 0.031) +
          90 * Math.sin(index * 0.173) +
          ((index * 37) % 19) -
          9
      )
    )
    const block = blockFromPool(pool)
    const bits = allocateNontoneSoundUnit(
      source,
      source,
      block,
      pool.encoder.state.channelBlockRing[0][1].gainRecords,
      1536,
      pool.encoder.scratch.allocation
    )
    expect(bits).toBeLessThanOrEqual(1536)
    expect(block.wordLengths.some((value) => value > 0)).toBe(true)
    expect(block.spectrumGroupCount).toBeGreaterThan(1)
    expect(() => packSoundUnit(block, bits, new Uint8Array(192))).not.toThrow()
  })

  it('admits strong sparse groups under the reference tone policy', () => {
    const pool = new BufferPool()
    const source = new Float32Array(1024)
    source.set([5000, -4200, 3100, -1700], 64)
    const block = blockFromPool(pool)
    const bits = allocateNontoneSoundUnit(
      source,
      source,
      block,
      pool.encoder.state.channelBlockRing[0][1].gainRecords,
      1536,
      pool.encoder.scratch.allocation,
      undefined,
      TONE_POLICY_THRESHOLD
    )
    expect(block.toneEntryIndex).toBe(1)
    expect(block.toneCount).toBe(1)
    expect(bits).toBeLessThanOrEqual(1536)
    expect(() => packSoundUnit(block, bits, new Uint8Array(192))).not.toThrow()
  })
})
