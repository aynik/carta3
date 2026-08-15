import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import { TRANSFORM_CARRY_OFFSET_FLOATS } from '../codec/core/constants.js'
import { resolveProfile } from '../codec/core/profiles.js'
import {
  allocationStage,
  encode,
  gainPreparationStage,
  gainStage,
  mdctStage,
  packingStage,
  qmfStage,
  referencePreparationStage,
  referenceSpectrumStage,
  transactionStage,
  validateFrameStage,
} from '../codec/pipeline/encoder.js'

function context() {
  return {
    profile: resolveProfile({ bitrateKbps: 132 }),
    bufferPool: new BufferPool(),
  }
}

function beginFrame(codec, channels) {
  let frame = validateFrameStage()(channels)
  frame = transactionStage(codec)(frame)
  frame = qmfStage(codec)(frame)
  return frame
}

describe('ATRAC3 sound-unit analysis flow', () => {
  it('keeps gain choice, signal preparation, and MDCT as distinct phases', () => {
    const codec = context()
    const signal = Float32Array.from({ length: 1024 }, (_, sample) =>
      Math.sin((sample * Math.PI) / 64)
    )
    encode({ bitrateKbps: 132 }, codec.bufferPool)([signal, signal])
    let frame = beginFrame(codec, [signal, signal])
    const encoder = codec.bufferPool.encoder
    const carryBeforeGain = encoder.frame.independentChannels[0].slice(
      TRANSFORM_CARRY_OFFSET_FLOATS,
      TRANSFORM_CARRY_OFFSET_FLOATS + 1024
    )

    frame = gainStage(codec)(frame)
    expect(
      encoder.frame.independentChannels[0].subarray(
        TRANSFORM_CARRY_OFFSET_FLOATS,
        TRANSFORM_CARRY_OFFSET_FLOATS + 1024
      )
    ).toEqual(carryBeforeGain)
    expect(encoder.frame.analyzedSpectra[0].every((value) => value === 0)).toBe(
      true
    )

    frame = gainPreparationStage(codec)(frame)
    expect(frame.mdctWindows).toBe(encoder.frame.preparedMdctWindows)
    expect(
      encoder.frame.preparedMdctWindows[0].some((value) => value !== 0)
    ).toBe(true)
    expect(encoder.frame.analyzedSpectra[0].every((value) => value === 0)).toBe(
      true
    )

    mdctStage(codec)(frame)
    expect(encoder.frame.analyzedSpectra[0].every(Number.isFinite)).toBe(true)
    expect(encoder.frame.analyzedSpectra[0].some((value) => value !== 0)).toBe(
      true
    )
  })

  it('produces silent gain plans, windows, and spectra for silence', () => {
    const codec = context()
    let frame = beginFrame(codec, [
      new Float32Array(1024),
      new Float32Array(1024),
    ])
    frame = gainStage(codec)(frame)
    frame = gainPreparationStage(codec)(frame)
    mdctStage(codec)(frame)

    const encoder = codec.bufferPool.encoder
    expect(
      encoder.frame.channelBlocks.every((block) =>
        block.gainRecords.every((record) => record.entries === 0)
      )
    ).toBe(true)
    expect(
      encoder.frame.analyzedSpectra.every((spectrum) =>
        spectrum.every((value) => value === 0)
      )
    ).toBe(true)
  })

  it('does not publish staged state when final frame packing fails', () => {
    const codec = context()
    const signal = Float32Array.from({ length: 1024 }, (_, sample) =>
      Math.fround(12000 * Math.sin((sample * Math.PI) / 64))
    )
    const persistentBefore =
      codec.bufferPool.encoder.state.independentChannels.map((state) =>
        state.slice()
      )
    let frame = beginFrame(codec, [signal, signal])
    frame = gainStage(codec)(frame)
    frame = gainPreparationStage(codec)(frame)
    frame = mdctStage(codec)(frame)
    frame = referencePreparationStage(codec)(frame)
    frame = referenceSpectrumStage(codec)(frame)
    frame = allocationStage(codec)(frame)
    frame.soundUnitBits[0]--

    expect(() => packingStage(codec)(frame)).toThrow(/expected .* wrote/)
    expect([
      ...codec.bufferPool.encoder.state.activeChannelBlockIndices,
    ]).toEqual([0, 0])
    for (let channel = 0; channel < 2; channel++) {
      expect(
        codec.bufferPool.encoder.state.independentChannels[channel]
      ).toEqual(persistentBefore[channel])
    }
  })
})
