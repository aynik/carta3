/**
 * Carta3 Audio Codec - Canonical stream profiles.
 *
 * ATRAC3 is stereo-only, always runs at 44.1 kHz, and codes 1024 PCM samples
 * per channel in each frame.
 */

import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE } from './constants.js'
import { PROFILE_ROWS } from './tables.js'

/**
 * Convert one immutable table row into the public profile shape.
 *
 * @param {object} row
 * @returns {object}
 */
function materializeProfile(row) {
  const modeFlag = row.syntaxMode === 2 ? 1 : 0
  const sampleRateIndex = 1
  return Object.freeze({
    ...row,
    channels: CHANNELS,
    frameSamples: FRAME_SAMPLES,
    sampleRate: SAMPLE_RATE,
    modeFlag,
    codecConfiguration:
      (modeFlag << 17) | (sampleRateIndex << 13) | (row.bytesPerFrame >> 3),
  })
}

/**
 * Resolve one of Carta3's maintained ATRAC3 profiles.
 *
 * @param {object} [options] Requested stream geometry.
 * @param {number} [options.bitrateKbps=132] Maintained bitrate.
 * @param {number} [options.channels=2] Required stereo channel count.
 * @param {number} [options.sampleRate=44100] Required sample rate.
 * @returns {object|null} Immutable profile, or `null` when unsupported.
 */
export function resolveProfile({
  bitrateKbps = 132,
  channels = CHANNELS,
  sampleRate = SAMPLE_RATE,
} = {}) {
  if (channels !== CHANNELS || sampleRate !== SAMPLE_RATE) {
    return null
  }

  const row = PROFILE_ROWS.find(
    (candidate) => candidate.bitrateKbps === bitrateKbps
  )
  return row ? materializeProfile(row) : null
}

/**
 * Resolve a maintained profile from ATRAC3 WAVE format fields.
 *
 * @param {object} format Parsed WAVE format geometry.
 * @param {number} format.channels Channel count.
 * @param {number} format.sampleRate Sample rate in hertz.
 * @param {number} format.blockAlign Encoded bytes per frame.
 * @param {number} format.modeFlag ATRAC3 syntax-mode flag.
 * @returns {object|null} Immutable matching profile, or `null`.
 */
export function resolveWaveProfile({
  channels,
  sampleRate,
  blockAlign,
  modeFlag,
}) {
  const syntaxMode = modeFlag ? 2 : 1
  const row = PROFILE_ROWS.find(
    (candidate) =>
      candidate.bytesPerFrame === blockAlign &&
      candidate.syntaxMode === syntaxMode
  )

  if (!row || channels !== CHANNELS || sampleRate !== SAMPLE_RATE) {
    return null
  }
  return materializeProfile(row)
}
