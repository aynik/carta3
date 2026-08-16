import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPcmWave } from '../codec/io/serialization.js'
import { decodeWavePcm } from '../codec/io/wave-decoder.js'
import { encodeWavePcm } from '../codec/io/wave-encoder.js'

const responses = []

beforeAll(async () => {
  globalThis.self = {
    postMessage(message) {
      responses.push(message)
    },
  }
  await import('../codec/browser/worker.js')
})

afterAll(() => {
  delete globalThis.self
})

/**
 * Send one request to the browser worker handler.
 *
 * @param {object} data Worker request.
 * @returns {Promise<object>} Worker result.
 */
async function request(data) {
  responses.length = 0
  await globalThis.self.onmessage({ data })
  expect(responses).toHaveLength(1)
  expect(responses[0].error).toBeUndefined()
  return responses[0].result
}

describe('Carta3 browser worker PCM boundaries', () => {
  it('streams normalized PCM through byte-exact WAVE blobs', async () => {
    const sampleCount = 1500
    const channels = [
      Float32Array.from({ length: sampleCount }, (_, sample) =>
        Math.fround(0.6 * Math.sin((2 * Math.PI * 440 * sample) / 44100))
      ),
      Float32Array.from({ length: sampleCount }, (_, sample) =>
        Math.fround(0.4 * Math.sin((2 * Math.PI * 660 * sample) / 44100))
      ),
    ]
    const options = { bitrateKbps: 105 }
    const expectedWave = encodeWavePcm(channels, options)
    const encoded = await request({
      jobId: 1,
      type: 'encode',
      pcmData: channels,
      options,
    })
    expect(new Uint8Array(await encoded.waveBlob.arrayBuffer())).toEqual(
      expectedWave
    )
    expect(encoded.info).toMatchObject({
      bitrateKbps: 105,
      channels: 2,
      sampleRate: 44100,
      frameCount: 5,
      sampleCount,
    })

    const decoded = await request({
      jobId: 2,
      type: 'decode',
      wave: encoded.waveBlob,
    })
    const expectedPcmWave = createPcmWave(decodeWavePcm(expectedWave))
    expect(new Uint8Array(await decoded.wavBlob.arrayBuffer())).toEqual(
      expectedPcmWave
    )
  })
})
