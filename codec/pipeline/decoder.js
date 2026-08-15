/**
 * Carta3 Audio Codec - Streaming decoder pipeline.
 */

import { applyDecoderJointStereoMix } from '../transforms/joint-stereo.js'
import { DecoderState } from '../state/decoder.js'
import { BufferPool } from '../core/buffers.js'
import {
  DECODER_MAX_UNITS,
  DECODER_SPECTRAL_LINES_PER_UNIT,
  FRAME_SAMPLES,
  RESIDUAL_DELAY_SAMPLES,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import {
  reconstructChannelSpectrum,
  unpackChannelSyntax,
} from '../io/channel-decoder.js'
import { IndependentChannelHeader, JointStereoHeader } from '../io/syntax.js'
import { applyInverseGainEnvelope } from '../transforms/gain-scale.js'
import { applyInverseBlockTransform } from '../transforms/mdct.js'
import { synthesizeLayeredQmf } from '../transforms/qmf.js'
import { pipe } from '../utils.js'

/** Reverse the second shared-layout region into its decoder-facing order. */
function prepareJointStereoRegion(source, stepBytes, previousBitPosition) {
  let left = 0
  let right = stepBytes
  let carriedByte = 0
  while (right > left) {
    right--
    carriedByte = source[right]
    if (carriedByte !== 0xf8) break
  }
  const consumedBytes = (previousBitPosition + 7) >> 3
  const availableBytes = right - left + 1 - consumedBytes
  if (right <= left) return availableBytes
  while (right > left) {
    const leftValue = source[left]
    source[right] = leftValue
    right--
    source[left] = carriedByte
    left++
    if (right <= left) break
    carriedByte = source[right]
  }
  return availableBytes
}

/** Convert a validated wire header into a semantic transform plan. */
function createJointStereoMixPlan(state, header, unitMode) {
  const selectors = header.gainSelectors
  const gainScaleSelectors = Uint8Array.from(state.header.gainScaleSelectors)
  for (let band = 3; band >= 0; band--) {
    if (selectors[band] === 2) {
      throw new RangeError(`Invalid ATRAC3 joint selector in band ${band}`)
    }
    gainScaleSelectors[band] = selectors[band]
  }
  return {
    firstHeaderByte: header.first,
    gainScaleSelectors,
    unitMode,
  }
}

/**
 * Reject malformed frame storage before capturing persistent state.
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(Uint8Array): DecoderFrame} Reusable validation stage.
 */
export function validateDecodeFrameStage(context) {
  const bytes = context.profile.bytesPerFrame
  return (input) => {
    if (!(input instanceof Uint8Array) || input.length !== bytes) {
      throw new RangeError(`ATRAC3 decoder requires one ${bytes}-byte frame`)
    }
    return { input }
  }
}

/**
 * Capture both channel histories and the shared header transactionally.
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} State-capture stage.
 */
export function decodeTransactionStage(context) {
  return (frame) => {
    const decoder = context.bufferPool.decoder
    decoder.state.copyTo(decoder.frame.decoderState)
    return frame
  }
}

/**
 * Parse both syntax regions and preflight shared selectors without mutation.
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Syntax stage.
 */
export function channelSyntaxStage(context) {
  const decoder = context.bufferPool.decoder
  const { profile } = context
  return (frame) => {
    const padded = decoder.scratch.paddedFrame
    padded.fill(0)
    padded.set(frame.input)
    const stagedState = decoder.frame.decoderState
    const stepBytes = stagedState.header.stepBytes
    const joint = stagedState.header.jointStereoLayout
    let channelOffset = 0
    let bitLimitBytes = stepBytes
    let bitPosition = 0
    const headers = [null, null]

    for (let channel = 0; channel < 2; channel++) {
      const swapped = joint && channel === 1
      let valid
      let unitMode
      let jointHeader = null
      if (swapped) {
        bitLimitBytes = prepareJointStereoRegion(padded, stepBytes, bitPosition)
        const header = JointStereoHeader.unpack(padded[0], padded[1])
        jointHeader = header
        valid = header.isValid
        unitMode = header.unitMode
        bitPosition = 16
      } else {
        const raw = padded[channelOffset]
        valid = IndependentChannelHeader.isValid(raw)
        unitMode = IndependentChannelHeader.unpack(raw).unitMode
        bitPosition = channelOffset * 8 + 8
      }
      if (!valid) {
        throw new RangeError(`Invalid ATRAC3 channel ${channel} header`)
      }
      bitPosition = unpackChannelSyntax(
        padded,
        bitPosition,
        unitMode,
        decoder.frame.decodedChannels[channel]
      )
      const bitLimit = bitLimitBytes * 8 + 16
      if (bitPosition > bitLimit) {
        throw new RangeError(`ATRAC3 channel ${channel} exceeds its bit limit`)
      }
      headers[channel] = { unitMode, swapped, jointHeader }
      channelOffset += stepBytes
      if (!joint) bitLimitBytes += stepBytes
    }

    frame.headers = headers
    frame.decodedChannels = decoder.frame.decodedChannels
    frame.jointMixPlan = headers[1].swapped
      ? createJointStereoMixPlan(
          stagedState,
          headers[1].jointHeader,
          headers[1].unitMode
        )
      : null
    frame.profile = profile
    return frame
  }
}

/**
 * Reconstruct spectra after both channels pass complete syntax checks.
 * @returns {function(DecoderFrame): DecoderFrame} Inverse-quantization stage.
 */
export function spectrumReconstructionStage() {
  return (frame) => {
    for (const decoded of frame.decodedChannels) {
      reconstructChannelSpectrum(decoded)
    }
    return frame
  }
}

/**
 * Transform reconstructed spectra into detached frame band histories.
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Inverse-transform stage.
 */
export function inverseTransformStage(context) {
  const decoderFrame = context.bufferPool.decoder.frame
  const activeBlockCounts = decoderFrame.activeBlockCounts
  return (frame) => {
    for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
      const channel = decoderFrame.decoderState.channels[channelIndex]
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
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Inverse-gain stage.
 */
export function inverseGainStage(context) {
  const stagedState = context.bufferPool.decoder.frame.decoderState
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
 * Apply shared-layout stereo reconstruction after both inverse transforms.
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Joint-stereo transform stage.
 */
export function jointStereoDecodeStage(context) {
  const stagedState = context.bufferPool.decoder.frame.decoderState
  return (frame) => {
    if (frame.jointMixPlan) {
      applyDecoderJointStereoMix(stagedState, frame.jointMixPlan)
    }
    return frame
  }
}

/**
 * Run fixed four-band synthesis independently for each frame channel.
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} QMF synthesis stage.
 */
export function synthesisStage(context) {
  const stagedState = context.bufferPool.decoder.frame.decoderState
  return (frame) => {
    for (const channel of stagedState.channels) {
      synthesizeLayeredQmf(channel)
    }
    return frame
  }
}

/**
 * Publish both histories atomically and detach the planar PCM result.
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): Float32Array[]} Commit stage.
 */
export function decodeCommitStage(context) {
  const decoder = context.bufferPool.decoder
  return () => {
    decoder.frame.decoderState.copyTo(decoder.state)
    return decoder.state.channels.map((channel) =>
      channel.synthesisBuffer.slice(0, FRAME_SAMPLES)
    )
  }
}

/**
 * Compose one persistent streaming ATRAC3 decoder from explicit stages.
 * @param {object} [options] Profile and decoder-state options.
 * @param {BufferPool} [bufferPool] Reusable persistent and scratch storage.
 * @returns {function(Uint8Array): Float32Array[]} One-frame stereo decoder.
 */
export function decode(options = {}, bufferPool = new BufferPool()) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3 decoder profile')
  bufferPool.decoder.state = new DecoderState(options)
  bufferPool.decoder.frame.decoderState = new DecoderState(options)
  const context = { options, profile, bufferPool }
  return pipe(
    context,
    validateDecodeFrameStage,
    decodeTransactionStage,
    channelSyntaxStage,
    spectrumReconstructionStage,
    inverseTransformStage,
    inverseGainStage,
    jointStereoDecodeStage,
    synthesisStage,
    decodeCommitStage
  )
}
