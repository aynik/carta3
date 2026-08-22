/**
 * Carta3 Audio Codec - Streaming decoder pipeline.
 *
 * Encoded bytes pass through unpacking, dequantization, and synthesis. Frame
 * validation, detached state, atomic commit, and PCM normalization surround
 * that semantic recipe.
 */

import { BufferPool } from '../core/buffers.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { dequantize } from '../dequantization/stage.js'
import { normalizePcm } from '../io/pcm.js'
import { DecoderState } from '../state/decoder.js'
import { beginDecoderFrame, commitDecoderFrame } from '../state/stream.js'
import { synthesize } from '../synthesis.js'
import { unpack } from '../unpacking.js'
import { pipe } from '../utils.js'

/**
 * Detach the synthesized PCM before it crosses the public normalization boundary.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): Float32Array[]} PCM detachment.
 */
function detachPcm(context) {
  const channels = context.bufferPool.decoder.frame.channels
  return () =>
    channels.map((channel) => channel.synthesisBuffer.slice(0, FRAME_SAMPLES))
}

/**
 * Compose the internal signed-amplitude decoder stage chain.
 *
 * @param {object} [options] Profile and decoder-state options.
 * @param {BufferPool} [bufferPool] Reusable persistent and scratch storage.
 * @returns {function(Uint8Array): Float32Array[]} One-frame stereo decoder.
 */
function createCodecDecoder(options = {}, bufferPool = new BufferPool()) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3 decoder profile')
  bufferPool.decoder.state = new DecoderState(options)
  bufferPool.decoder.frame.prepare(profile)
  const context = { profile, bufferPool }

  return pipe(
    context,
    validateFrame,
    beginDecoderFrame,
    unpack,
    dequantize,
    synthesize,
    commitDecoderFrame,
    detachPcm
  )
}

/**
 * Reject malformed frame storage before capturing persistent state.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(Uint8Array): DecoderFrame} Reusable validation stage.
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
  const decodeFrame = createCodecDecoder(options, bufferPool)
  return (frame) => normalizePcm(decodeFrame(frame))
}
