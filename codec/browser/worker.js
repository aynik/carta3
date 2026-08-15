/** Carta3 Audio Codec - Browser worker for complete WAVE jobs. */

import { PROFILE_ROWS } from '../core/tables.js'
import { decodeWavePcm } from '../io/wave-decoder.js'
import { encodeWavePcm } from '../io/wave-encoder.js'
import { parseWave } from '../io/wave.js'
import { createPcmWave } from '../io/serialization.js'

/** Normalize browser binary inputs to a byte view. */
async function asBytes(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('ATRAC3 worker requires a Blob or byte array')
}

/** Project a parsed WAVE image onto worker-safe metadata. */
function metadata(parsed) {
  return {
    bitrateKbps: parsed.profile.bitrateKbps,
    channels: parsed.profile.channels,
    sampleRate: parsed.profile.sampleRate,
    frameCount: parsed.frameCount,
    sampleCount: parsed.fact?.sampleCount ?? null,
  }
}

self.onmessage = async ({ data }) => {
  const { jobId, type } = data
  try {
    let result
    if (type === 'encode') {
      const wave = encodeWavePcm(data.pcmData, data.options)
      result = {
        waveBlob: new Blob([wave], { type: 'audio/wav' }),
        info: metadata(parseWave(wave)),
      }
    } else if (type === 'decode') {
      const wave = await asBytes(data.wave)
      const parsed = parseWave(wave)
      const pcm = decodeWavePcm(wave)
      result = {
        wavBlob: new Blob([createPcmWave(pcm)], { type: 'audio/wav' }),
        info: metadata(parsed),
      }
    } else if (type === 'inspect') {
      result = metadata(parseWave(await asBytes(data.wave)))
    } else if (type === 'getProfiles') {
      result = PROFILE_ROWS.map((profile) => ({ ...profile }))
    } else {
      throw new RangeError(`Unknown worker operation: ${type}`)
    }
    self.postMessage({ jobId, result })
  } catch (error) {
    self.postMessage({ jobId, error: error.message })
  }
}
