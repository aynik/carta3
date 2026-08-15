import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BufferPool } from '../codec/core/buffers.js'
import { encodeWavePcm } from '../codec/io/wave-encoder.js'
import { parseWave } from '../codec/io/wave.js'
import { decode } from '../codec/pipeline/decoder.js'

const SAMPLE_COUNT = 10 * 1024
const waveCache = new Map()

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
    channels[0][sample] = Math.round(
      22000 * Math.sin((2 * Math.PI * 440 * sample) / 44100)
    )
    channels[1][sample] = Math.round(
      16000 * Math.sin((2 * Math.PI * 660 * sample) / 44100)
    )
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
  const decodedFrames = parsed.frames().map(decodeFrame)
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
  for (const channel of pool.decoder.state.channels) {
    hash.update(Uint8Array.of(channel.previousBlockCount))
    hash.update(new Uint8Array(channel.synthesisBuffer.buffer))
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

describe('ATRAC3 staged streaming decoder', () => {
  it.each([
    [132, '2f50264480674b0cb54f6b62404fb657112a8660eb885709dcce1ada4d348494'],
    [105, '3f97d6313045d9faca0677e504be666008291ac6fb7f4b7f8f9de7b5021a5ea1'],
    [66, '0c17ca12296731d9f7bfcc9e1d5d10ed43b417a884544cbcde98034093c314e4'],
  ])(
    'matches the %i kbps decoded WAVE timeline reference',
    (bitrateKbps, expectedHash) => {
      const decoded = decodeTimelineFloatBits(bitrateKbps)
      expect(createHash('sha256').update(decoded).digest('hex')).toBe(
        expectedHash
      )
    }
  )

  it('does not publish either channel when second-channel syntax is invalid', () => {
    const parsed = parseWave(referenceWave(105))
    const frames = parsed.frames()
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
