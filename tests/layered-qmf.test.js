import { describe, expect, it } from 'vitest'
import { analyzeLayeredQmf } from '../codec/transforms/qmf.js'
import {
  FRAME_SAMPLES,
  LAYERED_QMF_HISTORY_FLOATS,
} from '../codec/core/constants.js'

/**
 * Test helper for qmfScratch.
 *
 * @returns {object}
 */
function qmfScratch() {
  return new Float32Array(FRAME_SAMPLES + LAYERED_QMF_HISTORY_FLOATS)
}

describe('ATRAC3 layered QMF analysis', () => {
  it('keeps zero input and zero history silent', () => {
    const spectrum = new Float32Array(1024)
    const history = new Float32Array(138)
    analyzeLayeredQmf(new Float32Array(1024), spectrum, history, qmfScratch())
    expect(spectrum.every((value) => value === 0)).toBe(true)
    expect(history.every((value) => value === 0)).toBe(true)
  })

  it('advances caller-owned history and produces finite deterministic output', () => {
    const input = Float32Array.from({ length: 1024 }, (_, sample) =>
      Math.fround(
        19000 * Math.sin((2 * Math.PI * 731 * sample) / 44100) +
          ((sample * 97) % 31) -
          15
      )
    )
    const spectrum = new Float32Array(1024)
    const history = new Float32Array(138)
    const scratch = qmfScratch()
    analyzeLayeredQmf(input, spectrum, history, scratch)
    const firstSpectrum = spectrum.slice()
    const firstHistory = history.slice()
    analyzeLayeredQmf(input, spectrum, history, scratch)
    expect(firstSpectrum.some((value) => value !== 0)).toBe(true)
    expect(firstHistory.some((value) => value !== 0)).toBe(true)
    expect(spectrum.every(Number.isFinite)).toBe(true)
    expect(history.every(Number.isFinite)).toBe(true)
    expect([...spectrum]).not.toEqual([...firstSpectrum])
  })
})
