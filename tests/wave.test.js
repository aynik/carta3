import { describe, expect, it } from 'vitest'
import { WAVE_FORMAT_TAG, WAVE_HEADER_BYTES } from '../codec/core/constants.js'
import { createWave, parseWave } from '../codec/io/wave.js'

describe('ATRAC3 RIFF/WAVE container', () => {
  it('writes the canonical ATRAC3 WAVE header layout', () => {
    const frames = [new Uint8Array(384), new Uint8Array(384).fill(0x5a)]
    const wave = createWave(frames, { sampleCount: 2048 })
    const view = new DataView(wave.buffer)
    expect(wave).toHaveLength(WAVE_HEADER_BYTES + 768)
    expect(new TextDecoder().decode(wave.subarray(0, 4))).toBe('RIFF')
    expect(view.getUint16(20, true)).toBe(WAVE_FORMAT_TAG)
    expect(view.getUint32(16, true)).toBe(32)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint16(32, true)).toBe(384)
    expect(view.getUint16(36, true)).toBe(14)
    expect(view.getUint32(56, true)).toBe(12)
    expect(view.getUint32(60, true)).toBe(2048)
    expect(view.getUint32(68, true)).toBe(1024)
    expect(view.getUint32(76, true)).toBe(768)
  })

  it('round-trips profile, fact alignment, and frame boundaries', () => {
    const frames = [new Uint8Array(384).fill(3), new Uint8Array(384).fill(7)]
    const parsed = parseWave(createWave(frames))
    expect(parsed.profile.bitrateKbps).toBe(132)
    expect(parsed.fact.alignmentSampleCount).toBe(1024)
    expect(parsed.frameCount).toBe(2)
    expect([...parsed.frames()].map((frame) => frame[0])).toEqual([3, 7])
    const iterator = parsed.frames()
    expect(iterator[Symbol.iterator]()).toBe(iterator)
    expect(iterator.next().value[0]).toBe(3)
    expect(iterator.next().value[0]).toBe(7)
    expect(iterator.next().done).toBe(true)
  })

  it('rejects a frame with incorrect block alignment', () => {
    expect(() => createWave([new Uint8Array(192)])).toThrow(/alignment/)
  })
})
