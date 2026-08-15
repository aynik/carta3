import { describe, expect, it } from 'vitest'
import { LayeredEncoderState } from '../codec/state/layered.js'

describe('ATRAC3 layered encoder state', () => {
  it('matches the 66 kbps secondary-layer geometry', () => {
    const state = new LayeredEncoderState({ bitrateKbps: 66 })
    expect(
      state.layers.map((layer) => [
        layer.bitBudget,
        layer.scaleFactorBandLimit,
        layer.stereoFlag,
      ])
    ).toEqual([
      [1133, 25, 0],
      [357, 12, 1133],
    ])
    expect(state.jointStereo.ratioScaledSlotCount).toBe(1)
    expect(state.jointStereo.outputSelector).toBe(15)
    expect([...state.jointStereo.slotModes]).toEqual([-3, -3, -3, -3])
  })

  it('matches the 105 kbps independent-layer geometry', () => {
    const state = new LayeredEncoderState({ bitrateKbps: 105 })
    expect(
      state.layers.map((layer) => [
        layer.bitBudget,
        layer.scaleFactorBandLimit,
        layer.stereoFlag,
      ])
    ).toEqual([
      [1197, 26, 0],
      [1197, 26, 0],
    ])
    expect(state.jointStereo.ratioScaledSlotCount).toBe(-1)
  })
})
