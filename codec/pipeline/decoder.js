/**
 * Carta3 Audio Codec - Streaming decoder pipeline.
 *
 * Encoded bytes pass through unpacking, dequantization, and synthesis. Frame
 * validation, detached state, atomic commit, and PCM normalization surround
 * that semantic recipe.
 */

import {
  applyDecoderJointStereoMix,
  prepareDecoderJointStereoMix,
} from '../transforms/joint-stereo.js'
import { DecoderState } from '../state/decoder.js'
import { BufferPool } from '../core/buffers.js'
import {
  DECODER_MAX_UNITS,
  DECODER_SPECTRAL_LINES_PER_UNIT,
  FRAME_SAMPLES,
  RESIDUAL_DELAY_SAMPLES,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import { normalizePcm } from '../io/pcm.js'
import { applyInverseGainEnvelope } from '../transforms/gain-scale.js'
import { applyInverseBlockTransform } from '../transforms/mdct.js'
import { synthesizeLayeredQmf } from '../transforms/qmf.js'
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
function synthesizeSpectrum(context) {
  const decoderFrame = context.bufferPool.decoder.frame
  const activeBlockCounts = decoderFrame.activeBlockCounts
  return (frame) => {
    for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
      const channel = decoderFrame.channels[channelIndex]
      const decoded = frame.decodedChannels[channelIndex]
      const currentBlockCount = decoded.coefficientBlocks
      const blockCount = Math.max(currentBlockCount, channel.previousBlockCount)
      channel.previousBlockCount = currentBlockCount
      channel.synthesisBuffer.copyWithin(
        0,
        FRAME_SAMPLES,
        FRAME_SAMPLES + RESIDUAL_DELAY_SAMPLES
      )
      const activeBlocks = Math.min(blockCount, DECODER_MAX_UNITS)
      activeBlockCounts[channelIndex] = activeBlocks
      for (let unit = 0; unit < activeBlocks; unit++) {
        const spectrumOffset = unit * DECODER_SPECTRAL_LINES_PER_UNIT
        const spectrum = decoded.samples.subarray(
          spectrumOffset,
          spectrumOffset + DECODER_SPECTRAL_LINES_PER_UNIT
        )
        applyInverseBlockTransform(
          spectrum,
          unit,
          decoded.pairTables[unit].gains[0],
          channel
        )
      }
      for (
        let unit = Math.max(blockCount, 1);
        unit < DECODER_MAX_UNITS;
        unit++
      ) {
        channel.overlap[unit].fill(0)
        for (
          let sample = unit;
          sample < FRAME_SAMPLES;
          sample += DECODER_MAX_UNITS
        ) {
          channel.synthesisBuffer[RESIDUAL_DELAY_SAMPLES + sample] = 0
        }
      }
    }
    frame.activeBlockCounts = activeBlockCounts
    return frame
  }
}

/**
 * Apply prior-frame gain envelopes after all inverse transforms are complete.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Gain synthesis application.
 */
function synthesizeGain(context) {
  const stagedState = context.bufferPool.decoder.frame
  return (frame) => {
    for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
      const channel = stagedState.channels[channelIndex]
      const decoded = frame.decodedChannels[channelIndex]
      for (let unit = 0; unit < frame.activeBlockCounts[channelIndex]; unit++) {
        applyInverseGainEnvelope(channel, unit, channel.pairTables[unit])
      }
      for (let unit = 0; unit < DECODER_MAX_UNITS; unit++) {
        decoded.pairTables[unit].copyTo(channel.pairTables[unit])
      }
    }
    return frame
  }
}

/**
 * Prepare the current signal decision from staged header history.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Stereo preparation operation.
 */
function prepareStereo(context) {
  const stagedState = context.bufferPool.decoder.frame
  return (frame) => {
    prepareDecoderJointStereoMix(stagedState.header, stagedState.jointStereoMix)
    frame.jointStereoMix = stagedState.jointStereoMix
    return frame
  }
}

/**
 * Apply the completed current-frame stereo decision to signal work only.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Stereo mixing operation.
 */
function mixStereo(context) {
  const channels = context.bufferPool.decoder.frame.channels
  return (frame) => {
    applyDecoderJointStereoMix(channels, frame.jointStereoMix)
    return frame
  }
}

/**
 * Reconstruct shared-layout stereo from completed inverse transforms.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Stereo synthesis application.
 */
function synthesizeStereo(context) {
  return pipe(context, prepareStereo, mixStereo)
}

/**
 * Run fixed four-band synthesis independently for each frame channel.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} PCM synthesis application.
 */
function synthesizePcm(context) {
  const stagedState = context.bufferPool.decoder.frame
  return (frame) => {
    for (const channel of stagedState.channels) {
      synthesizeLayeredQmf(channel)
    }
    return frame
  }
}

/**
 * Reconstruct PCM from the dequantized channel spectra.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Synthesis stage.
 */
export function synthesize(context) {
  return context.profile.bitrateKbps === 66
    ? pipe(
        context,
        synthesizeSpectrum,
        synthesizeGain,
        synthesizeStereo,
        synthesizePcm
      )
    : pipe(context, synthesizeSpectrum, synthesizeGain, synthesizePcm)
}

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
