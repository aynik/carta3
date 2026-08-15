import { describe, expect, it } from 'vitest'
import {
  selectJointStereoModes,
  selectJointStereoRatios,
} from '../codec/analysis/joint-stereo.js'
import { JointStereoState } from '../codec/state/joint-stereo.js'
import { applyJointStereoConversion } from '../codec/transforms/joint-stereo.js'

function layers() {
  return [
    { spectrum: new Float32Array(1024) },
    { spectrum: new Float32Array(1024) },
  ]
}

describe('ATRAC3 layered joint stereo', () => {
  it('copies transactions without replacing destination storage', () => {
    const source = new JointStereoState()
    const destination = new JointStereoState()
    const ratios = destination.selectedRatios
    const energy = destination.energies[0]
    source.selectedRatios[0] = 1.25
    source.energies[0].left = 42

    source.copyTo(destination)

    expect(destination.selectedRatios).toBe(ratios)
    expect(destination.energies[0]).toBe(energy)
    expect(destination.selectedRatios[0]).toBe(1.25)
    expect(destination.energies[0].left).toBe(42)
  })

  it('selects silent balanced modes and shifts the three-frame history', () => {
    const state = new JointStereoState()
    state.ratioScaledSlotCount = 0
    state.energies[0] = { left: 11, right: 12 }
    state.previousEnergies[0] = { left: 21, right: 22 }
    selectJointStereoModes(state, layers())
    expect([...state.slotModes]).toEqual([-3, -3, -3, -3])
    expect(state.energies[0]).toEqual({ left: 0, right: 0 })
    expect(state.previousEnergies[0]).toEqual({ left: 11, right: 12 })
    expect(state.secondPreviousEnergies[0]).toEqual({ left: 21, right: 22 })
    expect([0, 8]).not.toContain(state.outputSelector)
  })

  it('selects the left-dominant mode in a scaled slot', () => {
    const state = new JointStereoState()
    state.ratioScaledSlotCount = 4
    const signal = layers()
    for (let coefficient = 0; coefficient < 256; coefficient++) {
      signal[0].spectrum[coefficient * 4] = 1000
    }
    const sourceSpectra = signal.map((layer) => layer.spectrum.slice())
    selectJointStereoModes(state, signal)
    selectJointStereoRatios(state)
    expect(state.slotModes[0]).toBe(1)
    expect(signal.map((layer) => layer.spectrum)).toEqual(sourceSpectra)
  })

  it('applies the selected conversion in place with finite balanced output', () => {
    const state = new JointStereoState()
    state.ratioScaledSlotCount = 0
    state.outputSelector = 1
    state.previousOutputSelector = 1
    state.slotModes.fill(3)
    selectJointStereoRatios(state)
    const signal = layers()
    signal[0].spectrum.fill(2)
    signal[1].spectrum.fill(4)
    applyJointStereoConversion(state, signal)
    expect(signal[0].spectrum.every(Number.isFinite)).toBe(true)
    expect(signal[0].spectrum.some((value) => value !== 2)).toBe(true)
  })
})
