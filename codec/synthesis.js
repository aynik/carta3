/** Carta3 PCM synthesis stage. */

import {
  DECODER_MAX_UNITS,
  DECODER_SPECTRAL_LINES_PER_UNIT,
  FRAME_SAMPLES,
  RESIDUAL_DELAY_SAMPLES,
} from './core/constants.js'
import { applyInverseGainScale } from './signal/gain.js'
import {
  applyDecoderJointStereoMix,
  prepareDecoderJointStereoMix,
} from './signal/stereo.js'
import { inverseMdctBlock } from './signal/spectrum.js'
import { synthesizeQmfChannel } from './signal/bands.js'
import { pipe } from './utils.js'

/**
 * Synthesize detached band histories from reconstructed spectra.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Spectrum synthesis.
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
        inverseMdctBlock(
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
 * Apply prior-frame gain envelopes after inverse transforms are complete.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Gain synthesis.
 */
function synthesizeGain(context) {
  const stagedState = context.bufferPool.decoder.frame
  return (frame) => {
    for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
      const channel = stagedState.channels[channelIndex]
      const decoded = frame.decodedChannels[channelIndex]
      for (let unit = 0; unit < frame.activeBlockCounts[channelIndex]; unit++) {
        applyInverseGainScale(channel, unit, channel.pairTables[unit])
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
 * @returns {function(DecoderFrame): DecoderFrame} Stereo preparation.
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
 * Apply the current-frame stereo decision to signal work only.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Stereo mixing.
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
 * @returns {function(DecoderFrame): DecoderFrame} Stereo synthesis.
 */
function synthesizeStereo(context) {
  return pipe(context, prepareStereo, mixStereo)
}

/**
 * Run fixed four-band synthesis independently for each frame channel.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} PCM synthesis.
 */
function synthesizePcm(context) {
  const stagedState = context.bufferPool.decoder.frame
  return (frame) => {
    for (const channel of stagedState.channels) {
      synthesizeQmfChannel(channel)
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
