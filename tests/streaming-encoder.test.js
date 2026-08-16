import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { BufferPool } from '../codec/core/buffers.js'
import { IndependentChannelHeader } from '../codec/io/syntax.js'
import { createWave } from '../codec/io/wave.js'
import { PCM_SCALE } from '../codec/io/pcm.js'
import { encode } from '../codec/pipeline/encoder.js'
import { createWaveStreamingEncoder } from '../codec/io/wave-encoder.js'

/**
 * Test helper for stereoSignal.
 *
 * @returns {Float32Array[]}
 */
function stereoSignal() {
  return [
    Float32Array.from({ length: 1024 }, (_, index) =>
      Math.fround(Math.sin((2 * Math.PI * 440 * index) / 44100))
    ),
    Float32Array.from({ length: 1024 }, (_, index) =>
      Math.fround(0.7 * Math.sin((2 * Math.PI * 997 * index) / 44100))
    ),
  ]
}

describe('ATRAC3 132 kbps staged encoder transaction', () => {
  it('packs both independent channels into one 384-byte frame', () => {
    const buffers = new BufferPool()
    const encoder = encode({}, buffers)
    const stagedGainRecords = buffers.encoder.frame.channelBlocks.map(
      (block) => ({
        records: block.gainRecords,
        entries: [...block.gainRecords],
      })
    )
    const frame = encoder(stereoSignal())
    expect(frame).toHaveLength(384)
    expect(IndependentChannelHeader.isValid(frame[0])).toBe(true)
    expect(IndependentChannelHeader.isValid(frame[192])).toBe(true)
    expect([...buffers.encoder.state.activeChannelBlockIndices]).toEqual([2, 2])
    for (let channel = 0; channel < 2; channel++) {
      const block = buffers.encoder.frame.channelBlocks[channel]
      expect(block.gainRecords).toBe(stagedGainRecords[channel].records)
      for (let band = 0; band < block.gainRecords.length; band++) {
        expect(block.gainRecords[band]).toBe(
          stagedGainRecords[channel].entries[band]
        )
      }
    }
    const second = encoder(stereoSignal())
    expect(second).toHaveLength(384)
    expect([...buffers.encoder.state.activeChannelBlockIndices]).toEqual([1, 1])
  })

  it('validates the complete stereo input before advancing state', () => {
    const buffers = new BufferPool()
    const encoder = encode({}, buffers)
    const before = buffers.encoder.state.independentChannels.map((state) =>
      state.slice()
    )
    expect(() =>
      encoder([new Float32Array(1024), new Float32Array(1000)])
    ).toThrow(/1024/)
    expect([...buffers.encoder.state.activeChannelBlockIndices]).toEqual([0, 0])
    expect([...buffers.encoder.state.independentChannels[0]]).toEqual([
      ...before[0],
    ])
    expect([...buffers.encoder.state.independentChannels[1]]).toEqual([
      ...before[1],
    ])
  })

  it('keeps stream lifetime and three-frame drain outside the frame stages', () => {
    const empty = createWaveStreamingEncoder()
    expect(empty.finish()).toEqual([])
    const stream = createWaveStreamingEncoder()
    expect(stream.write(stereoSignal())).toHaveLength(1)
    expect(stream.finish().map((frame) => frame.length)).toEqual([
      384, 384, 384,
    ])
    expect(stream.finish()).toEqual([])
    expect(() => stream.write(stereoSignal())).toThrow(/finalized/)
  })

  it('lazily emits frames without materializing a complete input chunk', () => {
    const stream = createWaveStreamingEncoder()
    let encodeCalls = 0
    stream.encodeFrame = () => {
      encodeCalls++
      return new Uint8Array(384)
    }
    const channels = [new Float32Array(4096), new Float32Array(4096)]
    const frames = stream.frames(channels)
    expect(encodeCalls).toBe(0)
    expect(frames.next().done).toBe(false)
    expect(encodeCalls).toBe(1)
    expect(stream.sampleCount).toBe(69)
    expect([...frames]).toHaveLength(2)
    expect(encodeCalls).toBe(4)
    expect(stream.sampleCount).toBe(4096)
  })

  it('matches the complete WAVE timeline reference vector', () => {
    const sampleCount = 10 * 1024
    const channels = [
      new Float32Array(sampleCount),
      new Float32Array(sampleCount),
    ]
    for (let sample = 0; sample < sampleCount; sample++) {
      channels[0][sample] =
        Math.round(22000 * Math.sin((2 * Math.PI * 440 * sample) / 44100)) /
        PCM_SCALE
      channels[1][sample] =
        Math.round(16000 * Math.sin((2 * Math.PI * 660 * sample) / 44100)) /
        PCM_SCALE
    }

    const encoder = createWaveStreamingEncoder({ bitrateKbps: 132 })
    const frames = []
    const chunkSizes = [17, 333, 2048, 1, 777]
    let offset = 0
    let chunkIndex = 0
    while (offset < sampleCount) {
      const count = Math.min(
        chunkSizes[chunkIndex++ % chunkSizes.length],
        sampleCount - offset
      )
      frames.push(
        ...encoder.write([
          channels[0].subarray(offset, offset + count),
          channels[1].subarray(offset, offset + count),
        ])
      )
      offset += count
    }
    frames.push(...encoder.finish())
    const wave = createWave(frames, {
      bitrateKbps: 132,
      sampleCount,
    })
    expect(frames).toHaveLength(13)
    expect(createHash('sha256').update(wave).digest('hex')).toBe(
      '0433559f95f98c6d481b7180511c8182986379ff92faa4981376f703707199c9'
    )
  })

  it('preserves the broadband sound-unit allocation timeline', () => {
    const encoder = encode({ bitrateKbps: 132 })
    const hash = createHash('sha256')
    let seed = 0x9e3779b9
    for (let frame = 0; frame < 100; frame++) {
      const channels = [new Float32Array(1024), new Float32Array(1024)]
      for (const channel of channels) {
        for (let sample = 0; sample < channel.length; sample++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
          channel[sample] = (((seed / 0xffffffff) * 2 - 1) * 12000) / PCM_SCALE
        }
      }
      hash.update(encoder(channels))
    }
    expect(hash.digest('hex')).toBe(
      '001302d89f9cdcbea29c6cb5df025b1630a28d6fd277770f3f0fd05a872abbe9'
    )
  })
})

describe('ATRAC3 105 kbps staged encoder transaction', () => {
  it('matches the complete independent-layer WAVE timeline reference', () => {
    const sampleCount = 10 * 1024
    const channels = [
      new Float32Array(sampleCount),
      new Float32Array(sampleCount),
    ]
    for (let sample = 0; sample < sampleCount; sample++) {
      channels[0][sample] =
        Math.round(22000 * Math.sin((2 * Math.PI * 440 * sample) / 44100)) /
        PCM_SCALE
      channels[1][sample] =
        Math.round(16000 * Math.sin((2 * Math.PI * 660 * sample) / 44100)) /
        PCM_SCALE
    }

    const encoder = createWaveStreamingEncoder({ bitrateKbps: 105 })
    const frames = []
    const chunkSizes = [17, 333, 2048, 1, 777]
    let offset = 0
    let chunkIndex = 0
    while (offset < sampleCount) {
      const count = Math.min(
        chunkSizes[chunkIndex++ % chunkSizes.length],
        sampleCount - offset
      )
      frames.push(
        ...encoder.write([
          channels[0].subarray(offset, offset + count),
          channels[1].subarray(offset, offset + count),
        ])
      )
      offset += count
    }
    frames.push(...encoder.finish())
    const wave = createWave(frames, {
      bitrateKbps: 105,
      sampleCount,
    })
    expect(frames).toHaveLength(13)
    expect(wave).toHaveLength(4032)
    expect(createHash('sha256').update(wave).digest('hex')).toBe(
      'b047f98fe56f97d6d1e3c214c0f1a6e36c82a9a9d58b2b82bd6a3582e9079f17'
    )
  })
})

describe('ATRAC3 66 kbps staged joint-stereo transaction', () => {
  it('matches the complete shared-budget WAVE timeline reference', () => {
    const sampleCount = 10 * 1024
    const channels = [
      new Float32Array(sampleCount),
      new Float32Array(sampleCount),
    ]
    for (let sample = 0; sample < sampleCount; sample++) {
      channels[0][sample] =
        Math.round(22000 * Math.sin((2 * Math.PI * 440 * sample) / 44100)) /
        PCM_SCALE
      channels[1][sample] =
        Math.round(16000 * Math.sin((2 * Math.PI * 660 * sample) / 44100)) /
        PCM_SCALE
    }

    const encoder = createWaveStreamingEncoder({ bitrateKbps: 66 })
    const frames = []
    const chunkSizes = [17, 333, 2048, 1, 777]
    let offset = 0
    let chunkIndex = 0
    while (offset < sampleCount) {
      const count = Math.min(
        chunkSizes[chunkIndex++ % chunkSizes.length],
        sampleCount - offset
      )
      frames.push(
        ...encoder.write([
          channels[0].subarray(offset, offset + count),
          channels[1].subarray(offset, offset + count),
        ])
      )
      offset += count
    }
    frames.push(...encoder.finish())
    const wave = createWave(frames, {
      bitrateKbps: 66,
      sampleCount,
    })
    expect(frames).toHaveLength(13)
    expect(wave).toHaveLength(2576)
    expect(createHash('sha256').update(wave).digest('hex')).toBe(
      '66acca7764c5b6f36378b1da1f2bd27f6e7185f5e8338573d3feb3bd7bc2eed3'
    )
  })
})
