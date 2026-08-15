import { describe, expect, it } from 'vitest'
import {
  adjustGainContinuity,
  planBandGainRecord,
  planGainContinuityEdit,
} from '../codec/analysis/gain.js'
import { GainRecord } from '../codec/coding/gain.js'
import { BufferPool } from '../codec/core/buffers.js'

describe('ATRAC3 sound-unit gain analysis', () => {
  it('keeps flat low-level bands inactive while updating peak history', () => {
    const pool = new BufferPool()
    const seed = new GainRecord()
    seed.locations[3] = 0xdeadbeef
    const planned = planBandGainRecord(
      new Float32Array(768).fill(1),
      undefined,
      seed,
      pool.encoder.scratch.gainAnalysis
    )
    expect(planned).toBe(seed)
    expect(planned.entries).toBe(0)
    expect(planned.peakHistory).toBe(1)
    expect(planned.locations[3]).toBe(0xdeadbeef)
  })

  it('detects and lowers a strong attack into the expected record', () => {
    const pool = new BufferPool()
    const spectrum = new Float32Array(768)
    spectrum.fill(1, 256, 264)
    spectrum.fill(64, 264, 768)
    const planned = planBandGainRecord(
      spectrum,
      undefined,
      undefined,
      pool.encoder.scratch.gainAnalysis
    )
    expect({
      entries: planned.entries,
      locations: [...planned.locations.slice(0, planned.entries)],
      levels: [...planned.levels.slice(0, planned.entries)],
      peakHistory: planned.peakHistory,
    }).toEqual({ entries: 1, locations: [0], levels: [8], peakHistory: 64 })
  })

  it('plans band-1 continuity but rolls it back for an unchanged silent signal', () => {
    const pool = new BufferPool()
    const previous = Array.from({ length: 4 }, () => new GainRecord())
    const planned = Array.from({ length: 4 }, () => new GainRecord())
    planned[1].entries = 1
    planned[1].locations[0] = 3
    planned[1].levels[0] = 10
    planned[2].entries = 1
    planned[2].locations[0] = 9
    planned[2].levels[0] = 15
    expect(
      planGainContinuityEdit(new Float32Array(768), previous, planned)
    ).toEqual({ location: 3, level: 5 })
    const inactiveWord = 0xdeadbeef
    planned[0].locations[1] = inactiveWord
    const target = planned[0]
    adjustGainContinuity(
      new Float32Array(768),
      previous,
      planned,
      pool.encoder.scratch.gainScale
    )
    expect(planned[0]).toBe(target)
    expect(planned[0].entries).toBe(0)
    expect(planned[0].locations[1]).toBe(inactiveWord)
  })
})
