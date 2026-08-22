/**
 * Carta3 Audio Codec - Streaming decoder pipeline.
 *
 * Encoded bytes pass through unpacking, dequantization, and synthesis. Frame
 * validation, detached state, atomic commit, and PCM normalization surround
 * that semantic recipe.
 */

import { BufferPool } from '../state/storage.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { dequantize } from '../dequantization/stage.js'
import { normalizePcm } from '../boundary/pcm.js'
import { initializeDecoderStream } from '../state/decoder.js'
import { beginDecoderFrame, commitDecoderFrame } from '../state/stream.js'
import { synthesize } from '../synthesis.js'
import { unpack } from '../unpacking.js'
import { pipe } from '../utils.js'

/** @import { SynthesisFrame } from '../synthesis.js' */

/**
 * Stable ownership shared by one persistent decoder pipeline.
 *
 * @typedef {object} DecoderContext
 * @property {object} profile Resolved immutable stream profile.
 * @property {BufferPool} bufferPool Persistent, frame, and scratch storage.
 */

/**
 * Validated encoded bytes presented to syntax unpacking.
 *
 * @typedef {object} EncodedFrame
 * @property {Uint8Array} input One complete encoded frame.
 */

/**
 * Detach the synthesized PCM before it crosses the public normalization boundary.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(SynthesisFrame): Float32Array[]} PCM detachment.
 */
function detachPcm(context) {
  const channels = context.bufferPool.decoder.frame.channels
  return () =>
    channels.map((channel) => channel.synthesisBuffer.slice(0, FRAME_SAMPLES))
}

/**
 * Allocate stream state and stable construction context.
 *
 * @param {object} options Profile options for 66, 105, or 132 kbps.
 * @param {BufferPool} bufferPool Reusable persistent and scratch storage.
 * @returns {DecoderContext} Pipeline ownership context.
 */
function createDecoderContext(options, bufferPool) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3 decoder profile')
  initializeDecoderStream(profile, bufferPool.decoder)
  return { profile, bufferPool }
}

/**
 * Reject malformed frame storage before capturing persistent state.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(Uint8Array): EncodedFrame} Reusable validation stage.
 */
export function validateFrame(context) {
  const bytes = context.profile.bytesPerFrame
  return (input) => {
    if (!(input instanceof Uint8Array) || input.length !== bytes) {
      throw new RangeError(`ATRAC3 decoder requires one ${bytes}-byte frame`)
    }
    return { input }
  }
}

/**
 * Compose one persistent decoder returning normalized Web Audio PCM.
 *
 * @param {object} [options] Profile and decoder-state options.
 * @param {BufferPool} [bufferPool] Reusable persistent and scratch storage.
 * @returns {function(Uint8Array): Float32Array[]} One-frame stereo decoder.
 */
export function decode(options = {}, bufferPool = new BufferPool()) {
  const context = createDecoderContext(options, bufferPool)
  const decodeFrame = pipe(
    context,
    validateFrame,
    beginDecoderFrame,
    unpack,
    dequantize,
    synthesize,
    commitDecoderFrame,
    detachPcm
  )
  return (frame) => normalizePcm(decodeFrame(frame))
}
