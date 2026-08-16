/** Carta3 Audio Codec - Browser worker for complete WAVE jobs. */

import {
  FRAME_SAMPLES,
  WAVE_DELAY_SAMPLES,
  WAVE_HEADER_BYTES,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { PROFILE_ROWS } from '../core/tables.js'
import { createWaveStreamingDecoder } from '../io/wave-decoder.js'
import { createWaveStreamingEncoder } from '../io/wave-encoder.js'
import { createWaveHeader, parseWave } from '../io/wave.js'
import { createPcmWaveHeader, interleavePcm16 } from '../io/serialization.js'

/**
 * Normalize browser binary inputs to a byte view.
 *
 * @param {Blob|Uint8Array|ArrayBuffer} value
 * @returns {Promise<Uint8Array>}
 */
async function asBytes(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('ATRAC3 worker requires a Blob or byte array')
}

/**
 * Project a parsed WAVE image onto worker-safe metadata.
 *
 * @param {object} parsed
 * @returns {object}
 */
function metadata(parsed) {
  return {
    bitrateKbps: parsed.profile.bitrateKbps,
    channels: parsed.profile.channels,
    sampleRate: parsed.profile.sampleRate,
    frameCount: parsed.frameCount,
    sampleCount: parsed.fact?.sampleCount ?? null,
  }
}

/**
 * Handle onmessage.
 *
 * @param {object} event
 */
self.onmessage = async ({ data }) => {
  const { jobId, type } = data
  try {
    let result
    if (type === 'encode') {
      const options = data.options ?? {}
      const profile = resolveProfile(options)
      if (!profile) throw new RangeError('Unsupported ATRAC3 WAVE profile')
      const encoder = createWaveStreamingEncoder(options)
      const encodedFrames = []
      for (const frame of encoder.frames(data.pcmData)) {
        encodedFrames.push(frame)
      }
      encodedFrames.push(...encoder.finish())
      const waveBlob = new Blob(
        [
          createWaveHeader(
            profile,
            encodedFrames.length * profile.bytesPerFrame,
            profile.frameSamples,
            encoder.sampleCount
          ),
          ...encodedFrames,
        ],
        { type: 'audio/wav' }
      )
      result = {
        waveBlob,
        info: {
          bitrateKbps: profile.bitrateKbps,
          channels: profile.channels,
          sampleRate: profile.sampleRate,
          frameCount:
            (waveBlob.size - WAVE_HEADER_BYTES) / profile.bytesPerFrame,
          sampleCount: encoder.sampleCount,
        },
      }
    } else if (type === 'decode') {
      const wave = await asBytes(data.wave)
      const parsed = parseWave(wave)
      const sampleCount =
        parsed.fact?.sampleCount ??
        Math.max(
          0,
          parsed.frameCount * FRAME_SAMPLES - FRAME_SAMPLES - WAVE_DELAY_SAMPLES
        )
      const pcmParts = [createPcmWaveHeader({ sampleCount })]
      const decoder = createWaveStreamingDecoder({
        bitrateKbps: parsed.profile.bitrateKbps,
        sampleCount,
        alignmentSampleCount:
          parsed.fact?.alignmentSampleCount ?? FRAME_SAMPLES,
      })
      for (const frame of parsed.frames()) {
        const chunk = decoder.write(frame)
        if (chunk[0].length !== 0) pcmParts.push(interleavePcm16(chunk))
      }
      decoder.finish()
      result = {
        wavBlob: new Blob(pcmParts, { type: 'audio/wav' }),
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
