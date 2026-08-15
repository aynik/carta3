/** Carta3 Audio Codec - PCM WAVE serialization. */

import {
  CHANNELS,
  PCM_WAVE_BITS_PER_SAMPLE,
  PCM_WAVE_HEADER_BYTES,
  SAMPLE_RATE,
} from '../core/constants.js'
import { float32Add, float32ToBits } from '../utils.js'

/**
 * Match the reference float-to-signed-PCM conversion exactly.
 * @param {number} sample Decoder-domain signed sample value.
 * @returns {number} Clipped signed 16-bit integer.
 */
export function floatToPcm16(sample) {
  if (sample > 32767) return 32767
  if (Number.isNaN(sample) || sample <= -32767) return -32767
  const roundedBits = float32ToBits(float32Add(sample, 12582912))
  return (roundedBits << 16) >> 16
}

/** Write one four-character RIFF identifier. */
function writeFourCc(output, offset, value) {
  for (let index = 0; index < 4; index++) {
    output[offset + index] = value.charCodeAt(index)
  }
}

/**
 * Create a canonical signed 16-bit PCM WAVE header.
 * @param {object} geometry Output PCM geometry.
 * @param {number} geometry.sampleCount Samples per channel.
 * @param {number} [geometry.sampleRate=44100] Sample rate in hertz.
 * @param {number} [geometry.channels=2] Interleaved channel count.
 * @returns {Uint8Array} Fixed-size PCM WAVE header.
 */
export function createPcmWaveHeader({
  sampleCount,
  sampleRate = SAMPLE_RATE,
  channels = CHANNELS,
} = {}) {
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 0 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(channels) ||
    channels <= 0
  ) {
    throw new RangeError('Invalid PCM WAVE geometry')
  }
  const dataBytes = sampleCount * channels * 2
  const output = new Uint8Array(PCM_WAVE_HEADER_BYTES)
  const view = new DataView(output.buffer)
  writeFourCc(output, 0, 'RIFF')
  view.setUint32(4, PCM_WAVE_HEADER_BYTES + dataBytes - 8, true)
  writeFourCc(output, 8, 'WAVE')
  writeFourCc(output, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, PCM_WAVE_BITS_PER_SAMPLE, true)
  writeFourCc(output, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return output
}

/**
 * Interleave decoder-domain float channels as signed 16-bit PCM.
 * @param {Float32Array[]} channels Two equal planar channels.
 * @returns {Uint8Array} Little-endian interleaved PCM bytes.
 */
export function interleavePcm16(channels) {
  if (
    !Array.isArray(channels) ||
    channels.length !== CHANNELS ||
    !(channels[0] instanceof Float32Array) ||
    !(channels[1] instanceof Float32Array) ||
    channels[0].length !== channels[1].length
  ) {
    throw new RangeError('ATRAC3 PCM must contain two equal Float32 channels')
  }
  const output = new Uint8Array(channels[0].length * CHANNELS * 2)
  const view = new DataView(output.buffer)
  for (let sample = 0; sample < channels[0].length; sample++) {
    for (let channel = 0; channel < CHANNELS; channel++) {
      view.setInt16(
        (sample * CHANNELS + channel) * 2,
        floatToPcm16(channels[channel][sample]),
        true
      )
    }
  }
  return output
}

/**
 * Create a complete signed 16-bit PCM WAVE byte image.
 * @param {Float32Array[]} channels Two equal planar channels.
 * @param {object} [options] Optional sample-rate/header overrides.
 * @returns {Uint8Array} Header followed by interleaved PCM data.
 */
export function createPcmWave(channels, options = {}) {
  const pcm = interleavePcm16(channels)
  const header = createPcmWaveHeader({
    ...options,
    sampleCount: channels[0].length,
    channels: CHANNELS,
  })
  const output = new Uint8Array(header.length + pcm.length)
  output.set(header)
  output.set(pcm, header.length)
  return output
}
