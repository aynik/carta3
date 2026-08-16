import { describe, expect, it } from 'vitest'
import { AudioProcessor } from '../codec/io/processor.js'

/**
 * Test helper for signal.
 *
 * @param {number} [sampleCount]
 * @returns {Float32Array[]}
 */
function signal(sampleCount = 1500) {
  const channels = [
    new Float32Array(sampleCount),
    new Float32Array(sampleCount),
  ]
  for (let sample = 0; sample < sampleCount; sample++) {
    channels[0][sample] = Math.round(
      12000 * Math.sin((2 * Math.PI * 440 * sample) / 44100)
    )
    channels[1][sample] = Math.round(
      9000 * Math.sin((2 * Math.PI * 660 * sample) / 44100)
    )
  }
  return channels
}

/**
 * Test helper for chunks.
 *
 * @param {Float32Array[]} channels
 * @returns {AsyncGenerator<Float32Array[]>}
 */
async function* chunks(channels) {
  for (let offset = 0; offset < channels[0].length; offset += 317) {
    yield channels.map((channel) => channel.subarray(offset, offset + 317))
  }
}

describe('AudioProcessor ATRAC3 boundaries', () => {
  it('streams arbitrary PCM chunks through the WAVE encoder timeline', async () => {
    const frames = []
    for await (const frame of AudioProcessor.encodeStream(chunks(signal()), {
      bitrateKbps: 66,
    })) {
      frames.push(frame)
    }
    expect(frames.length).toBeGreaterThan(3)
    expect(frames.every((frame) => frame.length === 192)).toBe(true)
  })

  it('round-trips an ATRAC3 WAVE Blob and decodes its exact sample count', async () => {
    const channels = signal()
    const wave = AudioProcessor.encodeWavePcm(channels, {
      bitrateKbps: 105,
    })
    const parsed = await AudioProcessor.parseWaveBlob(
      new Blob([wave], { type: 'audio/wav' })
    )
    expect(parsed.fact.sampleCount).toBe(channels[0].length)
    const frames = await AudioProcessor.collectFrames(parsed.frames)
    expect(frames).toHaveLength(parsed.profile.bitrateKbps === 105 ? 5 : 0)
    const decoded = AudioProcessor.decodeWavePcm(parsed.bytes)
    expect(decoded[0]).toHaveLength(channels[0].length)
    expect(AudioProcessor.createPcmWaveBlob(decoded).type).toBe('audio/wav')
  })

  it('folds planar buffers into zero-padded stereo frames', () => {
    const channels = signal(1025)
    const frames = [...AudioProcessor.frameBufferToFrames(channels)]
    expect(frames).toHaveLength(2)
    expect(frames[0][0]).toHaveLength(1024)
    expect(frames[1][0][0]).toBe(channels[0][1024])
    expect(frames[1][0][1]).toBe(0)
  })
})
