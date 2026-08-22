import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/state/storage.js'
import { FRAME_SAMPLES } from '../codec/core/constants.js'
import { resolveProfile } from '../codec/core/profiles.js'
import { PCM_SCALE, normalizePcm } from '../codec/boundary/pcm.js'
import { encodeWavePcm } from '../codec/io/wave-encoder.js'
import { parseWave } from '../codec/boundary/container.js'
import { dequantize } from '../codec/dequantization/stage.js'
import { decode, validateFrame } from '../codec/pipeline/decoder.js'
import { DecoderFrameState, DecoderState } from '../codec/state/decoder.js'
import { beginDecoderFrame, commitDecoderFrame } from '../codec/state/stream.js'
import { synthesize } from '../codec/synthesis.js'
import { unpack } from '../codec/unpacking.js'
import { pipe } from '../codec/utils.js'

const SAMPLE_COUNT = 10 * 1024
const waveCache = new Map()

/**
 * Detach signed codec PCM for the explicit semantic recipe.
 *
 * @param {object} context
 * @returns {function(object): Float32Array[]}
 */
function detachPcm(context) {
  return () =>
    context.bufferPool.decoder.frame.channels.map((channel) =>
      channel.synthesisBuffer.slice(0, FRAME_SAMPLES)
    )
}

/**
 * Test helper for referenceWave.
 *
 * @param {number} bitrateKbps
 * @returns {Uint8Array}
 */
function referenceWave(bitrateKbps) {
  let wave = waveCache.get(bitrateKbps)
  if (wave) return wave
  const channels = [
    new Float32Array(SAMPLE_COUNT),
    new Float32Array(SAMPLE_COUNT),
  ]
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    channels[0][sample] =
      Math.round(22000 * Math.sin((2 * Math.PI * 440 * sample) / 44100)) /
      PCM_SCALE
    channels[1][sample] =
      Math.round(16000 * Math.sin((2 * Math.PI * 660 * sample) / 44100)) /
      PCM_SCALE
  }
  wave = encodeWavePcm(channels, { bitrateKbps })
  waveCache.set(bitrateKbps, wave)
  return wave
}

/**
 * Test helper for decodeTimelineFloatBits.
 *
 * @param {number} bitrateKbps
 * @returns {number[]}
 */
function decodeTimelineFloatBits(bitrateKbps) {
  const parsed = parseWave(referenceWave(bitrateKbps))
  const decodeFrame = decode({ bitrateKbps })
  const decodedFrames = Array.from(parsed.frames(), decodeFrame)
  const sampleCount = parsed.fact.sampleCount
  const skipSamples = parsed.fact.alignmentSampleCount + 69
  const bytes = new Uint8Array(sampleCount * 2 * Float32Array.BYTES_PER_ELEMENT)
  const view = new DataView(bytes.buffer)
  for (let sample = 0; sample < sampleCount; sample++) {
    const timelineSample = sample + skipSamples
    const frame = decodedFrames[timelineSample >> 10]
    const frameSample = timelineSample & 1023
    for (let channel = 0; channel < 2; channel++) {
      view.setFloat32(
        (sample * 2 + channel) * Float32Array.BYTES_PER_ELEMENT,
        frame[channel][frameSample],
        true
      )
    }
  }
  return bytes
}

/**
 * Test helper for decoderStateHash.
 *
 * @param {BufferPool} pool
 * @returns {number}
 */
function decoderStateHash(pool) {
  const hash = createHash('sha256')
  const header = pool.decoder.state.header
  hash.update(
    Uint8Array.of(
      header.jointStereoLayout ? 1 : 0,
      header.pairScaleIndex + 1,
      header.unitMode,
      header.previousPairScaleIndex + 1,
      header.previousUnitMode
    )
  )
  hash.update(header.gainScaleSelectors)
  hash.update(header.previousGainScaleSelectors)
  for (const channel of pool.decoder.state.channels) {
    hash.update(Uint8Array.of(channel.previousBlockCount))
    hash.update(new Uint8Array(channel.synthesisTail.buffer))
    for (const overlap of channel.overlap) {
      hash.update(new Uint8Array(overlap.buffer))
    }
    for (const table of channel.pairTables) {
      hash.update(new Uint8Array(table.starts.buffer))
      hash.update(new Uint8Array(table.gains.buffer))
    }
  }
  return hash.digest('hex')
}

/**
 * Snapshot the chronological fields of one decoder header.
 *
 * @param {object} header
 * @returns {object}
 */
function headerSnapshot(header) {
  return {
    gains: [...header.gainScaleSelectors],
    pair: header.pairScaleIndex,
    unit: header.unitMode,
    previousGains: [...header.previousGainScaleSelectors],
    previousPair: header.previousPairScaleIndex,
    previousUnit: header.previousUnitMode,
  }
}

describe('ATRAC3 staged streaming decoder', () => {
  it('stages and commits only genuine channel synthesis history', () => {
    const state = new DecoderState({ bitrateKbps: 105 })
    const frame = new DecoderFrameState().prepare(state.profile)
    const history = state.channels[0]
    const work = frame.channels[0]
    work.synthesisBuffer.fill(-1)
    history.synthesisTail.fill(2)
    history.previousBlockCount = 3
    history.overlap[0][0] = 4
    history.pairTables[0].starts[0] = 5
    history.pairTables[0].gains[0] = 6

    state.stageTo(frame)

    expect(
      work.synthesisBuffer
        .subarray(0, FRAME_SAMPLES)
        .every((sample) => sample === -1)
    ).toBe(true)
    expect(work.synthesisBuffer.subarray(FRAME_SAMPLES)).toEqual(
      history.synthesisTail
    )
    expect(work.previousBlockCount).toBe(3)
    expect(work.overlap[0][0]).toBe(4)
    expect(work.pairTables[0].starts[0]).toBe(5)
    expect(work.pairTables[0].gains[0]).toBe(6)

    work.synthesisBuffer.subarray(FRAME_SAMPLES).fill(7)
    work.previousBlockCount = 2
    work.overlap[0][0] = 8
    work.pairTables[0].starts[0] = 9
    work.pairTables[0].gains[0] = 10
    state.commitFrom(frame)

    expect(history.synthesisTail.every((sample) => sample === 7)).toBe(true)
    expect(history.previousBlockCount).toBe(2)
    expect(history.overlap[0][0]).toBe(8)
    expect(history.pairTables[0].starts[0]).toBe(9)
    expect(history.pairTables[0].gains[0]).toBe(10)
  })

  it('matches the semantic decoder recipe with independent state', () => {
    const options = { bitrateKbps: 105 }
    const input = parseWave(referenceWave(options.bitrateKbps))
      .frames()
      .next().value

    const expectedPool = new BufferPool()
    const expected = decode(options, expectedPool)(input)

    const bufferPool = new BufferPool()
    bufferPool.decoder.state = new DecoderState(options)
    bufferPool.decoder.frame.prepare(bufferPool.decoder.state.profile)
    const context = {
      options,
      profile: resolveProfile(options),
      bufferPool,
    }
    const decodeFrame = pipe(
      context,
      validateFrame,
      beginDecoderFrame,
      unpack,
      dequantize,
      synthesize,
      commitDecoderFrame,
      detachPcm
    )
    const result = normalizePcm(decodeFrame(input))

    expect(result).toEqual(expected)
    expect(decoderStateHash(bufferPool)).toBe(decoderStateHash(expectedPool))
  })

  it('mixes from staged history and advances the pending joint header at commit', () => {
    const options = { bitrateKbps: 66 }
    const input = parseWave(referenceWave(options.bitrateKbps))
      .frames()
      .next().value
    const bufferPool = new BufferPool()
    bufferPool.decoder.state = new DecoderState(options)
    bufferPool.decoder.frame.prepare(bufferPool.decoder.state.profile)
    const context = {
      options,
      profile: resolveProfile(options),
      bufferPool,
    }
    const persistentBefore = headerSnapshot(bufferPool.decoder.state.header)
    let frame = validateFrame(context)(input)
    frame = beginDecoderFrame(context)(frame)
    const stagedBefore = headerSnapshot(bufferPool.decoder.frame.header)

    frame = unpack(context)(frame)

    expect(frame.pendingJointHeader).toBe(
      bufferPool.decoder.frame.pendingJointHeader
    )
    expect(frame).not.toHaveProperty('jointStereoMix')
    expect(headerSnapshot(bufferPool.decoder.frame.header)).toEqual(
      stagedBefore
    )
    const pending = {
      gains: [...frame.pendingJointHeader.gainScaleSelectors],
      pair: frame.pendingJointHeader.pairScaleIndex,
      unit: frame.pendingJointHeader.unitMode,
    }

    frame = dequantize()(frame)
    frame = synthesize(context)(frame)

    expect(frame.jointStereoMix).toBe(bufferPool.decoder.frame.jointStereoMix)
    expect(headerSnapshot(bufferPool.decoder.frame.header)).toEqual(
      stagedBefore
    )
    expect(headerSnapshot(bufferPool.decoder.state.header)).toEqual(
      persistentBefore
    )

    commitDecoderFrame(context)(frame)

    const committed = headerSnapshot(bufferPool.decoder.state.header)
    expect(committed.previousGains).toEqual(stagedBefore.gains)
    expect(committed.previousPair).toBe(stagedBefore.pair)
    expect(committed.previousUnit).toBe(stagedBefore.unit)
    expect(committed.gains).toEqual(pending.gains)
    expect(committed.pair).toBe(pending.pair)
    expect(committed.unit).toBe(pending.unit)
  })

  it.each([
    [132, '933e74b0945791083552759cd827b6ccf152c735c4e12cb0610c0855ea84fb26'],
    [105, 'c00acd8146cb89710268452acec414bf87ca128e6dfa5c10efd68aa4ee0519c5'],
    [66, '422b26c27b7d0641abd4ff7a987cafff1bf85f3caddcac2d80f25dcb4e254bc9'],
  ])(
    'matches the %i kbps decoded WAVE timeline reference',
    (bitrateKbps, expectedHash) => {
      const decoded = decodeTimelineFloatBits(bitrateKbps)
      expect(createHash('sha256').update(decoded).digest('hex')).toBe(
        expectedHash
      )
    }
  )

  it('normalizes detached output without recalibrating decoder state', () => {
    const parsed = parseWave(referenceWave(132))
    const pool = new BufferPool()
    const decodeFrame = decode({ bitrateKbps: 132 }, pool)
    const decoded = decodeFrame(parsed.frames().next().value)
    for (let channel = 0; channel < 2; channel++) {
      const internal = pool.decoder.frame.channels[channel].synthesisBuffer
      for (let sample = 0; sample < FRAME_SAMPLES; sample++) {
        expect(decoded[channel][sample]).toBe(
          Math.fround(internal[sample] / PCM_SCALE)
        )
      }
    }
  })

  it('does not publish either channel when second-channel syntax is invalid', () => {
    const parsed = parseWave(referenceWave(105))
    const frames = [...parsed.frames()]
    const pool = new BufferPool()
    const decodeFrame = decode({ bitrateKbps: 105 }, pool)
    decodeFrame(frames[0])
    const before = decoderStateHash(pool)
    const invalid = frames[1].slice()
    invalid[152] = 0
    expect(() => decodeFrame(invalid)).toThrow(/channel 1 header/)
    expect(decoderStateHash(pool)).toBe(before)
  })
})
