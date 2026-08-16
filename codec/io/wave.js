/** Carta3 Audio Codec - RIFF/WAVE container handling. */

import { WAVE_FORMAT_TAG, WAVE_HEADER_BYTES } from '../core/constants.js'
import { resolveProfile, resolveWaveProfile } from '../core/profiles.js'

const textDecoder = new TextDecoder('ascii')

/**
 * Write one four-character RIFF identifier.
 *
 * @param {Uint8Array} output
 * @param {number} offset
 * @param {string} value
 */
function writeFourCc(output, offset, value) {
  for (let index = 0; index < 4; index++)
    output[offset + index] = value.charCodeAt(index)
}

/**
 * Read one four-character RIFF identifier.
 *
 * @param {Uint8Array} input
 * @param {number} offset
 * @returns {string}
 */
function readFourCc(input, offset) {
  return textDecoder.decode(input.subarray(offset, offset + 4))
}

/**
 * Build the canonical ATRAC3 WAVE header.
 *
 * @param {object} profile Resolved ATRAC3 profile.
 * @param {number} dataBytes Encoded data-chunk byte length.
 * @param {number} [alignmentSampleCount=1024] Fact alignment sample count.
 * @param {number} [sampleCount=0] Visible PCM samples per channel.
 * @returns {Uint8Array} Complete fixed-size RIFF header.
 */
export function createWaveHeader(
  profile,
  dataBytes,
  alignmentSampleCount = 1024,
  sampleCount = 0
) {
  if (!profile || profile.channels !== 2 || dataBytes < 0) {
    throw new RangeError('Invalid ATRAC3 WAVE header geometry')
  }
  const output = new Uint8Array(WAVE_HEADER_BYTES)
  const view = new DataView(output.buffer)
  writeFourCc(output, 0, 'RIFF')
  view.setUint32(4, output.length + dataBytes - 8, true)
  writeFourCc(output, 8, 'WAVE')
  writeFourCc(output, 12, 'fmt ')
  view.setUint32(16, 32, true)
  view.setUint16(20, WAVE_FORMAT_TAG, true)
  view.setUint16(22, profile.channels, true)
  view.setUint32(24, profile.sampleRate, true)
  view.setUint32(
    28,
    Math.trunc(
      (profile.bytesPerFrame * profile.sampleRate + profile.frameSamples / 2) /
        profile.frameSamples
    ),
    true
  )
  view.setUint16(32, profile.bytesPerFrame, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 14, true)
  view.setUint16(38, 1, true)
  view.setUint32(40, profile.channels << 11, true)
  view.setUint16(44, profile.modeFlag, true)
  view.setUint16(46, profile.modeFlag, true)
  view.setUint16(48, 1, true)
  view.setUint16(50, 0, true)
  writeFourCc(output, 52, 'fact')
  view.setUint32(56, 12, true)
  view.setUint32(60, sampleCount >>> 0, true)
  view.setUint32(64, alignmentSampleCount >>> 0, true)
  view.setUint32(68, alignmentSampleCount >>> 0, true)
  writeFourCc(output, 72, 'data')
  view.setUint32(76, dataBytes, true)
  return output
}

/**
 * Materialize a complete ATRAC3 WAVE file from packed frames.
 *
 * @param {Uint8Array[]} frames Profile-sized encoded frames.
 * @param {object} [options] Profile and timeline options.
 * @returns {Uint8Array} Complete WAVE byte image.
 */
export function createWave(frames, options = {}) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3 WAVE profile')
  const dataBytes = frames.length * profile.bytesPerFrame
  const output = new Uint8Array(WAVE_HEADER_BYTES + dataBytes)
  output.set(
    createWaveHeader(
      profile,
      dataBytes,
      options.alignmentSampleCount ?? profile.frameSamples,
      options.sampleCount ??
        Math.max(0, (frames.length - 3) * profile.frameSamples)
    )
  )
  let offset = WAVE_HEADER_BYTES
  for (const frame of frames) {
    if (
      !(frame instanceof Uint8Array) ||
      frame.length !== profile.bytesPerFrame
    ) {
      throw new RangeError('ATRAC3 WAVE frame has the wrong block alignment')
    }
    output.set(frame, offset)
    offset += frame.length
  }
  return output
}

/**
 * Parse and validate Carta3's maintained ATRAC3 RIFF/WAVE subset.
 *
 * @param {Uint8Array} input Complete ATRAC3 WAVE byte image.
 * @returns {object} Profile, fact metadata, data geometry, and frame iterator.
 */
export function parseWave(input) {
  if (!(input instanceof Uint8Array) || input.length < 12) {
    throw new RangeError('ATRAC3 WAVE input is too short')
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  if (readFourCc(input, 0) !== 'RIFF' || readFourCc(input, 8) !== 'WAVE') {
    throw new RangeError('Invalid RIFF/WAVE signature')
  }
  let format = null
  let fact = null
  let dataOffset = -1
  let dataBytes = 0
  for (let offset = 12; offset + 8 <= input.length;) {
    const id = readFourCc(input, offset)
    const size = view.getUint32(offset + 4, true)
    const payload = offset + 8
    if (payload + size > input.length) {
      throw new RangeError('Truncated ATRAC3 WAVE chunk')
    }
    if (id === 'fmt ') {
      if (size < 32 || view.getUint16(payload, true) !== WAVE_FORMAT_TAG) {
        throw new RangeError('Unsupported ATRAC3 WAVE format chunk')
      }
      const modeFlag = view.getUint16(payload + 24, true)
      if (
        view.getUint16(payload + 18, true) !== 1 ||
        modeFlag !== view.getUint16(payload + 26, true) ||
        view.getUint16(payload + 28, true) !== 1 ||
        view.getUint16(payload + 30, true) !== 0
      ) {
        throw new RangeError('Malformed ATRAC3 WAVE extension')
      }
      format = {
        channels: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        blockAlign: view.getUint16(payload + 12, true),
        modeFlag,
      }
    } else if (id === 'fact') {
      if (size >= 12) {
        fact = {
          sampleCount: view.getUint32(payload, true),
          reservedSampleCount: view.getUint32(payload + 4, true),
          alignmentSampleCount: view.getUint32(payload + 8, true),
        }
      }
    } else if (id === 'data') {
      if (dataOffset !== -1)
        throw new RangeError('Duplicate ATRAC3 WAVE data chunk')
      dataOffset = payload
      dataBytes = size
    }
    offset = payload + size + (size & 1)
  }
  if (!format || dataOffset < 0)
    throw new RangeError('Incomplete ATRAC3 WAVE file')
  const profile = resolveWaveProfile(format)
  if (!profile || dataBytes % profile.bytesPerFrame !== 0) {
    throw new RangeError('ATRAC3 WAVE profile or data alignment is invalid')
  }
  return {
    profile,
    fact,
    dataOffset,
    dataBytes,
    frameCount: dataBytes / profile.bytesPerFrame,
    /**
     * Return byte-aligned complete frames from the parsed data chunk.
     *
     * @returns {Generator<Uint8Array>}
     */
    *frames() {
      for (let index = 0; index < this.frameCount; index++) {
        yield input.subarray(
          dataOffset + index * profile.bytesPerFrame,
          dataOffset + (index + 1) * profile.bytesPerFrame
        )
      }
    },
  }
}
