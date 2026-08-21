import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import { FRAME_SAMPLES } from '../codec/core/constants.js'
import { encode } from '../codec/pipeline/encoder.js'
import { LayerHistory, LayerWork } from '../codec/state/layered.js'

/** @returns {LayerHistory} History with distinct values. */
function seedHistory() {
  const history = new LayerHistory()
  history.windowMatrix[0] = 2
  history.gainHistory[0] = 3
  history.transformHistory[0] = 4
  history.qmfHistory[0] = 5
  history.pairGains[0].magnitudeBits[0] = 6
  history.pairGains[0].magnitudeBits[31] = 10
  history.pairGains[0].maximumBits = 7
  history.pairGains[0].lastMaximumBits = 8
  history.pairGains[0].gainCount = 9
  return history
}

/** @returns {LayerWork} Work with distinct product and history values. */
function seedWork() {
  const work = new LayerWork()
  seedHistory().stageTo(work)
  work.spectrum[0] = 1
  work.scaleFactorBandLimit = 8
  work.bitBudget = 9
  work.jointSecondary = true
  return work
}

describe('ATRAC3 layered encoder state', () => {
  it('stages history without copying spectrum or configuration', () => {
    const source = seedHistory()
    const destination = new LayerWork()
    destination.spectrum[0] = 10
    destination.scaleFactorBandLimit = 11
    destination.bitBudget = 12
    destination.jointSecondary = true
    const syntax = Uint32Array.from({ length: 0x10 }, (_, index) => 13 + index)
    destination.pairBlocks[0].set(syntax)
    destination.priorGainCount = 14

    source.stageTo(destination)

    expect(destination.spectrum[0]).toBe(10)
    expect(destination.pairBlocks[0].subarray(0, 0x10)).toEqual(syntax)
    expect([
      destination.windowMatrix[0],
      destination.gainHistory[0],
      destination.transformHistory[0],
      destination.qmfHistory[0],
      destination.pairBlocks[0][0x10],
      destination.pairBlocks[0][0x2f],
      destination.pairBlocks[0][0x30],
      destination.pairBlocks[0][0x31],
      destination.pairBlocks[0][0x32],
      destination.priorGainCount,
    ]).toEqual([2, 3, 4, 5, 6, 10, 7, 8, 9, 14])
    expect([
      destination.scaleFactorBandLimit,
      destination.bitBudget,
      destination.jointSecondary,
    ]).toEqual([11, 12, true])
  })

  it('commits only history into compact persistent storage', () => {
    const source = seedWork()
    source.pairBlocks[0][0] = 10
    source.priorGainCount = 11
    const destination = new LayerHistory()

    destination.commitFrom(source)

    expect([
      destination.windowMatrix[0],
      destination.gainHistory[0],
      destination.transformHistory[0],
      destination.qmfHistory[0],
      destination.pairGains[0].magnitudeBits[0],
      destination.pairGains[0].magnitudeBits[31],
      destination.pairGains[0].maximumBits,
      destination.pairGains[0].lastMaximumBits,
      destination.pairGains[0].gainCount,
    ]).toEqual([2, 3, 4, 5, 6, 10, 7, 8, 9])
    expect(destination).not.toHaveProperty('pairBlocks')
    expect(destination).not.toHaveProperty('priorGainCount')
    expect(destination).not.toHaveProperty('spectrum')
    expect(destination).not.toHaveProperty('scaleFactorBandLimit')
    expect(destination).not.toHaveProperty('bitBudget')
    expect(destination).not.toHaveProperty('jointSecondary')
  })

  it('configures only stable 66 kbps frame scalars', () => {
    const pool = new BufferPool()
    const layers = pool.encoder.frame.layeredWork
    layers[0].spectrum[0] = 10
    layers[0].windowMatrix[0] = 11

    encode({ bitrateKbps: 66 }, pool)

    expect(
      layers.map((layer) => [
        layer.bitBudget,
        layer.scaleFactorBandLimit,
        layer.jointSecondary,
      ])
    ).toEqual([
      [1133, 25, false],
      [357, 12, true],
    ])
    expect(layers[0].spectrum[0]).toBe(10)
    expect(layers[0].windowMatrix[0]).toBe(11)
    expect(pool.encoder.frame.jointStereoWork.ratioScaledSlotCount).toBe(1)
    expect(pool.encoder.state.jointStereoHistory.outputSelector).toBe(15)
    expect([...pool.encoder.state.jointStereoHistory.slotModes]).toEqual([
      -3, -3, -3, -3,
    ])
  })

  it('configures only stable 105 kbps frame scalars', () => {
    const pool = new BufferPool()
    const layers = pool.encoder.frame.layeredWork

    encode({ bitrateKbps: 105 }, pool)

    expect(
      layers.map((layer) => [
        layer.bitBudget,
        layer.scaleFactorBandLimit,
        layer.jointSecondary,
      ])
    ).toEqual([
      [1197, 26, false],
      [1197, 26, false],
    ])
    expect(pool.encoder.frame.jointStereoWork.ratioScaledSlotCount).toBe(-1)
    expect(pool.encoder.state.jointStereoHistory.outputSelector).toBe(0)
    expect([...pool.encoder.state.jointStereoHistory.slotModes]).toEqual([
      0, 0, 0, 0,
    ])
  })

  it('keeps the configured 66 kbps primary budget across frames', () => {
    const bufferPool = new BufferPool()
    const encodeFrame = encode({ bitrateKbps: 66 }, bufferPool)
    const primary = bufferPool.encoder.frame.layeredWork[0]
    const configuredBudget = primary.bitBudget
    const channels = [
      new Float32Array(FRAME_SAMPLES),
      new Float32Array(FRAME_SAMPLES),
    ]

    encodeFrame(channels)
    expect(primary.bitBudget).toBe(configuredBudget)
    encodeFrame(channels)
    expect(primary.bitBudget).toBe(configuredBudget)
  })

  it('stages neutral history and configuration after a profile change', () => {
    const bufferPool = new BufferPool()
    const channels = [
      new Float32Array(FRAME_SAMPLES),
      new Float32Array(FRAME_SAMPLES),
    ]
    encode({ bitrateKbps: 66 }, bufferPool)(channels)
    const history = bufferPool.encoder.state.layeredHistories[0]
    history.windowMatrix[0] = 1
    history.qmfHistory[0] = 2
    history.pairGains[0].magnitudeBits[0] = 3
    history.pairGains[0].gainCount = 4
    const jointHistory = bufferPool.encoder.state.jointStereoHistory
    jointHistory.slotModes[0] = 5
    jointHistory.outputSelector = 6
    jointHistory.previousRatios[0] = 7

    const encodeFrame = encode({ bitrateKbps: 105 }, bufferPool)
    expect(history.windowMatrix[0]).toBe(0)
    expect(history.qmfHistory[0]).toBe(0)
    expect(history.pairGains[0].magnitudeBits[0]).toBe(0)
    expect(history.pairGains[0].gainCount).toBe(0)
    expect(jointHistory.slotModes[0]).toBe(0)
    expect(jointHistory.outputSelector).toBe(0)
    expect(jointHistory.previousRatios[0]).toBe(0)
    expect(bufferPool.encoder.frame.jointStereoWork.ratioScaledSlotCount).toBe(
      -1
    )
    encodeFrame(channels)

    expect(
      bufferPool.encoder.frame.jointStereoWork.previousOutputSelector
    ).toBe(0)
    expect(
      bufferPool.encoder.frame.layeredWork.map((layer) => [
        layer.bitBudget,
        layer.scaleFactorBandLimit,
        layer.jointSecondary,
      ])
    ).toEqual([
      [1197, 26, false],
      [1197, 26, false],
    ])
  })
})
