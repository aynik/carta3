/**
 * Carta3 Audio Codec - Streaming decoder pipeline.
 *
 * Encoded bytes pass through unpacking, dequantization, and synthesis. Frame
 * validation, detached state, atomic commit, and PCM normalization surround
 * that semantic recipe.
 */

import { DecoderState } from '../state/decoder.js'
import { BufferPool } from '../core/buffers.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { normalizePcm } from '../io/pcm.js'
import { pipe } from '../utils.js'

/**
 * Reverse the second shared-layout region into its decoder-facing order.
 *
 * @param {Uint8Array} source
 * @param {number} stepBytes
 * @param {number} previousBitPosition
 * @returns {number}
 */
import { unpack } from '../unpacking.js'
/**
 * Reject malformed frame storage before capturing persistent state.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(Uint8Array): DecoderFrame} Reusable validation stage.
 */
import { dequantize } from '../dequantization/stage.js'
import { synthesize } from '../synthesis.js'
export function validateFrame(context) {
  const bytes = context.profile.bytesPerFrame
  return (input) => {
    if (!(input instanceof Uint8Array) || input.length !== bytes) {
      throw new RangeError(`ATRAC3 decoder requires one ${bytes}-byte frame`)
    }
    return {
      input,
    }
  }
}

/**
 * Capture both channel histories and the shared header transactionally.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} State-capture stage.
 */
export function beginTransaction(context) {
  return (frame) => {
    const decoder = context.bufferPool.decoder
    decoder.state.stageTo(decoder.frame)
    return frame
  }
}

/**
 * Parse both syntax regions and preflight shared selectors without mutation.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Unpacking stage with decoded syntax and stereo plan.
 */

/**
 * Reconstruct spectra after both channels pass complete syntax checks.
 *
 * @returns {function(DecoderFrame): DecoderFrame} Dequantization stage.
 */

/**
 * Synthesize detached band histories from reconstructed spectra.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Spectrum synthesis application.
 */

/**
 * Publish both histories atomically and detach the planar PCM result.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): Float32Array[]} Commit stage.
 */
export function commitFrame(context) {
  const decoder = context.bufferPool.decoder
  if (context.profile.bitrateKbps === 66) {
    return (frame) => {
      decoder.frame.header.advanceFrom(frame.pendingJointHeader)
      decoder.state.commitFrom(decoder.frame)
      return decoder.frame.channels.map((channel) =>
        channel.synthesisBuffer.slice(0, FRAME_SAMPLES)
      )
    }
  }
  return () => {
    decoder.state.commitFrom(decoder.frame)
    return decoder.frame.channels.map((channel) =>
      channel.synthesisBuffer.slice(0, FRAME_SAMPLES)
    )
  }
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
  const context = {
    profile,
    bufferPool,
  }
  return pipe(
    context,
    validateFrame,
    beginTransaction,
    unpack,
    dequantize,
    synthesize,
    commitFrame
  )
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
