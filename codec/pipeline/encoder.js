/**
 * Carta3 Audio Codec - Streaming ATRAC3 encoder pipeline.
 *
 * Validation and detached state surround analysis, allocation, quantization,
 * and packing in one linear recipe. Atomic commit publishes successful frames.
 */

import { allocate } from '../allocation/stage.js'
import { analyze } from '../analysis/stage.js'
import { scalePcmFrame } from '../boundary/pcm.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { pack } from '../packing.js'
import { quantize } from '../quantization/stage.js'
import { initializeEncoderStream } from '../state/encoder.js'
import { BufferPool } from '../state/storage.js'
import { beginEncoderFrame, commitEncoderFrame } from '../state/stream.js'
import { pipe } from '../utils.js'

/**
 * Stable ownership shared by one persistent encoder pipeline.
 *
 * @typedef {object} EncoderContext
 * @property {object} profile Resolved immutable stream profile.
 * @property {BufferPool} bufferPool Persistent, frame, and scratch storage.
 */

/**
 * Validated normalized or codec-domain PCM presented to signal analysis.
 *
 * @typedef {object} PcmFrame
 * @property {Float32Array[]} channels Equal planar stereo channels.
 */

/**
 * Allocate stream state and stable construction context.
 *
 * @param {object} options Profile options for 66, 105, or 132 kbps.
 * @param {BufferPool} bufferPool Reusable persistent and scratch storage.
 * @returns {EncoderContext} Pipeline ownership context.
 */
function createEncoderContext(options, bufferPool) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3 encoder profile')
  initializeEncoderStream(profile, bufferPool.encoder)
  return { profile, bufferPool }
}

/**
 * Validate a complete stereo frame before transactional scratch advances.
 *
 * @returns {function(Float32Array[]): PcmFrame} Reusable validation stage.
 */
export function validateFrame() {
  return (channels) => {
    if (!Array.isArray(channels) || channels.length !== 2) {
      throw new RangeError('ATRAC3 encode requires one stereo PCM frame')
    }
    for (const channel of channels) {
      if (
        !(channel instanceof Float32Array) ||
        channel.length !== FRAME_SAMPLES
      ) {
        throw new RangeError(
          'Each ATRAC3 PCM channel must contain 1024 float samples'
        )
      }
    }
    return {
      channels,
    }
  }
}

/**
 * Compose one persistent encoder accepting normalized Web Audio PCM.
 *
 * The adapter reuses one codec-domain frame for the lifetime of the closure.
 *
 * @param {object} [options] Profile options for 66, 105, or 132 kbps.
 * @param {BufferPool} [bufferPool] Reusable persistent and scratch storage.
 * @returns {function(Float32Array[]): Uint8Array} One-frame stereo encoder.
 */
export function encode(options = {}, bufferPool = new BufferPool()) {
  const context = createEncoderContext(options, bufferPool)
  const encodeFrame = pipe(
    context,
    validateFrame,
    beginEncoderFrame,
    analyze,
    allocate,
    quantize,
    pack,
    commitEncoderFrame
  )
  const codecFrame = [
    new Float32Array(FRAME_SAMPLES),
    new Float32Array(FRAME_SAMPLES),
  ]
  const validateInput = validateFrame()
  return (channels) => {
    validateInput(channels)
    return encodeFrame(scalePcmFrame(channels, codecFrame))
  }
}
