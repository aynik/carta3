import { describe, expect, it } from 'vitest'
import {
  selectJointStereoModes,
  selectJointStereoRatios,
} from '../codec/analysis/stereo.js'
import { JointStereoHistory, JointStereoWork } from '../codec/state/stereo.js'
import { applyJointStereoConversion } from '../codec/signal/stereo.js'

/**
 * Test helper for layers.
 *
 * @returns {object[]}
 */
function layers() {
  return [
    { spectrum: new Float32Array(1024) },
    { spectrum: new Float32Array(1024) },
  ]
}

/**
 * Test helper for energyEvidence.
 *
 * @returns {{left: number, right: number}[]}
 */
function energyEvidence() {
  return Array.from({ length: 4 }, () => ({ left: 0, right: 0 }))
}

describe('ATRAC3 layered joint stereo', () => {
  it('stages history without copying a prior frame plan', () => {
    const source = new JointStereoHistory()
    const destination = new JointStereoWork()
    const selectedRatios = destination.selectedRatios
    source.slotModes[0] = 3
    source.outputSelector = 7
    source.previousRatios[0] = 1.25
    destination.ratioScaledSlotCount = 1
    destination.absoluteModeHints[0] = 1
    destination.transitionStartRatios[0] = 2
    destination.selectedRatios[0] = 2.25

    source.stageTo(destination)

    expect(destination.ratioScaledSlotCount).toBe(1)
    expect(destination.slotModes[0]).toBe(3)
    expect(destination.previousOutputSelector).toBe(7)
    expect(destination.outputSelector).toBe(7)
    expect(destination.previousRatios[0]).toBe(1.25)
    expect(destination.absoluteModeHints[0]).toBe(1)
    expect(destination.transitionStartRatios[0]).toBe(2)
    expect(destination.selectedRatios).toBe(selectedRatios)
    expect(destination.selectedRatios[0]).toBe(2.25)
  })

  it('commits history without publishing the frame plan', () => {
    const source = new JointStereoWork()
    const destination = new JointStereoHistory()
    source.slotModes[0] = 1
    source.outputSelector = 9
    source.previousRatios[0] = 1.25
    source.absoluteModeHints[0] = 3
    source.previousOutputSelector = 7
    source.transitionStartRatios[0] = 1.5
    source.selectedRatios[0] = 1.75
    destination.commitFrom(source)

    expect(destination.slotModes[0]).toBe(1)
    expect(destination.outputSelector).toBe(9)
    expect(destination.previousRatios[0]).toBe(1.25)
    expect(destination).not.toHaveProperty('ratioScaledSlotCount')
    expect(destination).not.toHaveProperty('absoluteModeHints')
    expect(destination).not.toHaveProperty('previousOutputSelector')
    expect(destination).not.toHaveProperty('transitionStartRatios')
    expect(destination).not.toHaveProperty('selectedRatios')
  })

  it('resets profile history without creating a frame plan', () => {
    const history = new JointStereoHistory()
    history.slotModes.fill(3)
    history.outputSelector = 7
    history.previousRatios.fill(2)

    history.reset(true)

    expect([...history.slotModes]).toEqual([-3, -3, -3, -3])
    expect(history.outputSelector).toBe(15)
    expect([...history.previousRatios]).toEqual([1, 1, 1, 1])

    history.reset(false)

    expect([...history.slotModes]).toEqual([0, 0, 0, 0])
    expect(history.outputSelector).toBe(0)
    expect([...history.previousRatios]).toEqual([0, 0, 0, 0])
  })

  it('returns silent evidence while selecting balanced modes', () => {
    const state = new JointStereoWork()
    state.ratioScaledSlotCount = 0
    const energies = selectJointStereoModes(state, layers())
    expect([...state.slotModes]).toEqual([-3, -3, -3, -3])
    expect(energies[0]).toEqual({ left: 0, right: 0 })
    expect([0, 8]).not.toContain(state.outputSelector)
  })

  it('selects the left-dominant mode in a scaled slot', () => {
    const state = new JointStereoWork()
    state.ratioScaledSlotCount = 4
    const signal = layers()
    for (let coefficient = 0; coefficient < 256; coefficient++) {
      signal[0].spectrum[coefficient * 4] = 1000
    }
    const sourceSpectra = signal.map((layer) => layer.spectrum.slice())
    const energies = selectJointStereoModes(state, signal)
    selectJointStereoRatios(state, energies)
    expect(state.slotModes[0]).toBe(1)
    expect(signal.map((layer) => layer.spectrum)).toEqual(sourceSpectra)
  })

  it('applies the selected conversion in place with finite balanced output', () => {
    const state = new JointStereoWork()
    state.ratioScaledSlotCount = 0
    state.outputSelector = 1
    state.previousOutputSelector = 1
    state.slotModes.fill(3)
    selectJointStereoRatios(state, energyEvidence())
    const signal = layers()
    signal[0].spectrum.fill(2)
    signal[1].spectrum.fill(4)
    applyJointStereoConversion(state, signal)
    expect(signal[0].spectrum.every(Number.isFinite)).toBe(true)
    expect(signal[0].spectrum.some((value) => value !== 2)).toBe(true)
  })
})
