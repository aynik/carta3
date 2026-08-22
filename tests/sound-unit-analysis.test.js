import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import {
  ANALYSIS_WORK_FLOATS,
  BAND_PART_FLOATS,
  BAND_STRIDE_FLOATS,
  FORWARD_TRANSFORM_CARRY_OFFSET,
  FRAME_SAMPLES,
  QMF_DELAY,
  ROOT_HISTORY_OFFSET,
  SUBBAND_COUNT,
  TRANSFORM_CARRY_OFFSET_FLOATS,
} from '../codec/core/constants.js'
import { resolveProfile } from '../codec/core/profiles.js'
import {
  analyzeBands,
  planGain,
  prepareGainWindows,
  prepareReference,
  transformReference,
  transformSpectrum,
} from '../codec/analysis/stage.js'
import { allocate } from '../codec/allocation/stage.js'
import { quantize } from '../codec/quantization/stage.js'
import {
  beginTransaction,
  encode,
  pack,
  validateFrame,
} from '../codec/pipeline/encoder.js'
import { IndependentChannelHistory } from '../codec/state/encoder.js'

/**
 * Test helper for context.
 *
 * @returns {object}
 */
function context() {
  return {
    profile: resolveProfile({ bitrateKbps: 132 }),
    bufferPool: new BufferPool(),
  }
}

/**
 * Test helper for beginFrame.
 *
 * @param {Function} codec
 * @param {Float32Array[]} channels
 * @returns {object}
 */
function beginFrame(codec, channels) {
  let frame = validateFrame()(channels)
  frame = beginTransaction(codec)(frame)
  frame = analyzeBands(codec)(frame)
  return frame
}

/**
 * Snapshot persistent independent-channel history.
 *
 * @param {IndependentChannelHistory} history
 * @returns {object}
 */
function snapshotHistory(history) {
  return {
    bandTails: history.bandTails.map((tail) => tail.slice()),
    transformCarry: history.transformCarry.slice(),
    referenceCarry: history.referenceCarry.slice(),
    qmfDelays: history.qmfDelays.slice(),
    gainRecords: history.gainRecords.map((record) => record.clone()),
  }
}

describe('ATRAC3 sound-unit analysis flow', () => {
  it('stages and commits only genuine independent-channel history', () => {
    const history = new IndependentChannelHistory()
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      history.bandTails[band].fill(band + 1)
    }
    history.transformCarry.fill(5)
    history.referenceCarry.fill(6)
    history.qmfDelays.fill(7)
    const work = new Float32Array(ANALYSIS_WORK_FLOATS).fill(-1)

    history.stageTo(work)

    for (let band = 0; band < SUBBAND_COUNT; band++) {
      const offset = band * BAND_STRIDE_FLOATS
      expect(work.subarray(offset, offset + BAND_PART_FLOATS)).toEqual(
        new Float32Array(BAND_PART_FLOATS).fill(-1)
      )
      expect(
        work.subarray(offset + BAND_PART_FLOATS, offset + 3 * BAND_PART_FLOATS)
      ).toEqual(history.bandTails[band])
    }
    expect(
      work.subarray(
        TRANSFORM_CARRY_OFFSET_FLOATS,
        TRANSFORM_CARRY_OFFSET_FLOATS + FRAME_SAMPLES
      )
    ).toEqual(history.transformCarry)
    expect(
      work.subarray(
        FORWARD_TRANSFORM_CARRY_OFFSET,
        FORWARD_TRANSFORM_CARRY_OFFSET + FRAME_SAMPLES
      )
    ).toEqual(history.referenceCarry)
    expect(
      work.subarray(ROOT_HISTORY_OFFSET, ROOT_HISTORY_OFFSET + 3 * QMF_DELAY)
    ).toEqual(history.qmfDelays)

    work.fill(8)
    const records = new IndependentChannelHistory().gainRecords
    records[0].entries = 1
    records[0].locations[0] = 2
    records[0].levels[0] = 3
    records[0].peakHistory = 4
    history.commitFrom(work, records)

    expect(history.bandTails[0].every((value) => value === 8)).toBe(true)
    expect(history.transformCarry.every((value) => value === 8)).toBe(true)
    expect(history.referenceCarry.every((value) => value === 8)).toBe(true)
    expect(history.qmfDelays.every((value) => value === 8)).toBe(true)
    expect(history.gainRecords[0]).toEqual(records[0])
  })

  it('keeps gain choice, signal preparation, and MDCT as distinct phases', () => {
    const codec = context()
    const signal = Float32Array.from({ length: 1024 }, (_, sample) =>
      Math.sin((sample * Math.PI) / 64)
    )
    encode({ bitrateKbps: 132 }, codec.bufferPool)([signal, signal])
    let frame = beginFrame(codec, [signal, signal])
    const encoder = codec.bufferPool.encoder
    const carryBeforeGain = encoder.frame.analysisWork[0].slice(
      TRANSFORM_CARRY_OFFSET_FLOATS,
      TRANSFORM_CARRY_OFFSET_FLOATS + 1024
    )

    frame = planGain(codec)(frame)
    expect(
      encoder.frame.analysisWork[0].subarray(
        TRANSFORM_CARRY_OFFSET_FLOATS,
        TRANSFORM_CARRY_OFFSET_FLOATS + 1024
      )
    ).toEqual(carryBeforeGain)
    expect(encoder.frame.analyzedSpectra[0].every((value) => value === 0)).toBe(
      true
    )

    frame = prepareGainWindows(codec)(frame)
    expect(frame.mdctWindows).toBe(encoder.frame.preparedMdctWindows)
    expect(
      encoder.frame.preparedMdctWindows[0].some((value) => value !== 0)
    ).toBe(true)
    expect(encoder.frame.analyzedSpectra[0].every((value) => value === 0)).toBe(
      true
    )

    transformSpectrum(codec)(frame)
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
    frame = planGain(codec)(frame)
    frame = prepareGainWindows(codec)(frame)
    transformSpectrum(codec)(frame)

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
      codec.bufferPool.encoder.state.independentChannels.map(snapshotHistory)
    let frame = beginFrame(codec, [signal, signal])
    frame = planGain(codec)(frame)
    frame = prepareGainWindows(codec)(frame)
    frame = transformSpectrum(codec)(frame)
    frame = prepareReference(codec)(frame)
    frame = transformReference(codec)(frame)
    frame.channelBlocks[0].quantizedSpectrum.fill(99)
    frame = allocate(codec)(frame)
    expect(frame.soundUnits[0].quantizedSpectrum).not.toEqual(
      frame.channelBlocks[0].quantizedSpectrum
    )
    frame = quantize(codec)(frame)
    expect(frame.channelBlocks[0].quantizedSpectrum).toEqual(
      frame.soundUnits[0].quantizedSpectrum
    )
    frame.soundUnitBits[0]--

    expect(() => pack(codec)(frame)).toThrow(/expected .* wrote/)
    for (let channel = 0; channel < 2; channel++) {
      expect(
        snapshotHistory(
          codec.bufferPool.encoder.state.independentChannels[channel]
        )
      ).toEqual(persistentBefore[channel])
    }
  })
})
