/**
 * Carta3 Audio Codec - Streaming ATRAC3 encoder pipeline.
 *
 * Validation and detached state surround analysis, allocation, quantization,
 * and packing in one linear recipe. Atomic commit publishes successful frames.
 */

import { BufferPool } from '../core/buffers.js'
import {
  FRAME_SAMPLES,
  JOINT_STEREO_SLOT_ROUNDING,
  LAYER_PRIMARY_HEADER_BITS,
  LAYER_SECONDARY_HEADER_BITS,
  SAMPLE_RATE,
  SPECTRUM_GROUPS,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import {
  LAYER_BAND_OFFSETS,
  LAYER_PROFILE_CONFIGURATION,
} from '../core/tables.js'
import { packLayeredChannel } from '../io/layered-channel.js'
import { packSoundUnit } from '../io/sound-unit.js'
import { scalePcmFrame } from '../io/pcm.js'
import { pipe } from '../utils.js'

/** Identify a failed pre-transform sound-unit phase and channel. */
import { analyze } from '../analysis/stage.js'
/**
 * Validate a complete stereo frame before transactional scratch advances.
 *
 * @returns {function(Float32Array[]): EncoderFrame} Reusable validation stage.
 */
import { allocate } from '../allocation/stage.js'
import { quantize } from '../quantization/stage.js'
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
 * Capture reusable destination nodes for one all-channel transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Transaction capture stage.
 */
function beginIndependent(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.independentChannels
  const work = encoder.frame.analysisWork
  const blocks = encoder.frame.channelBlocks
  const previousGainRecords = histories.map((history) => history.gainRecords)
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      histories[channel].stageTo(work[channel])
      blocks[channel].reset()
    }
    frame.analysisWork = work
    frame.channelBlocks = blocks
    frame.previousGainRecords = previousGainRecords
    return frame
  }
}

/**
 * Advance the four-band QMF histories for both frame-transaction channels.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Independent band analysis.
 */

/**
 * Choose exact sound-unit syntax without publishing persistent state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation stage.
 */

/**
 * Pack the complete stereo frame after all coding decisions are final.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Wire-publication stage.
 */
function packIndependent(context) {
  const { profile } = context
  const encoder = context.bufferPool.encoder
  const unitBytes = profile.bytesPerFrame / 2
  return (frame) => {
    const output = encoder.frame.packedBytes.subarray(0, profile.bytesPerFrame)
    output.fill(0)
    for (let channel = 0; channel < 2; channel++) {
      packSoundUnit(
        frame.channelBlocks[channel],
        frame.soundUnitBits[channel],
        output,
        channel * unitBytes
      )
    }
    frame.output = output
    return frame
  }
}

/**
 * Publish all histories only after the complete frame has packed.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): Uint8Array} Atomic commit stage.
 */
function commitIndependent(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.independentChannels
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      histories[channel].commitFrom(
        frame.analysisWork[channel],
        frame.channelBlocks[channel].gainRecords
      )
    }
    return frame.output.slice()
  }
}

/**
 * Capture layered states and shared stereo history into the frame transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layer transaction stage.
 */
export function beginLayered(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.layeredHistories
  const work = encoder.frame.layeredWork
  const jointHistory = encoder.state.jointStereoHistory
  const jointWork = encoder.frame.jointStereoWork
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      histories[layer].stageTo(work[layer])
    }
    jointHistory.stageTo(jointWork)
    frame.layers = work
    frame.jointStereo = jointWork
    return frame
  }
}

/**
 * Run the stateful low-rate QMF over the complete stereo transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered band analysis.
 */

/**
 * Select a shared 66 kbps budget without writing the frame buffer.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Joint allocation operation.
 */

/**
 * Pack completed layers into their final independent or shared spans.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layer packing stage.
 */
export function packLayered(context) {
  const { profile } = context
  const encoder = context.bufferPool.encoder
  const stride = profile.bytesPerFrame / 2
  const joint = profile.bitrateKbps === 66
  return (frame) => {
    const output = encoder.frame.packedBytes.subarray(0, profile.bytesPerFrame)
    output.fill(0)
    const offsets = joint ? frame.layeredOffsets : [0, stride]
    for (let layer = 0; layer < 2; layer++) {
      const end = packLayeredChannel(
        frame.layers[layer],
        frame.layeredAllocationWork[layer],
        frame.layeredSymbols[layer],
        offsets[layer],
        output,
        {
          previousOutput: frame.jointStereo.previousOutputSelector,
          gainSelectors: frame.jointStereo.absoluteModeHints,
        }
      )
      const limit = joint
        ? layer === 0
          ? offsets[1] * 8
          : profile.bytesPerFrame * 8
        : (layer + 1) * stride * 8
      if (end > limit) {
        throw new RangeError(
          `ATRAC3 layer ${layer} exceeds its selected frame span`
        )
      }
    }
    if (joint) {
      output.subarray(offsets[1], profile.bytesPerFrame).reverse()
    }
    frame.output = output
    return frame
  }
}

/**
 * Publish both layered histories only after successful packing.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): Uint8Array} Layer commit stage.
 */
export function commitLayered(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.layeredHistories
  const jointHistory = encoder.state.jointStereoHistory
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      histories[layer].commitFrom(frame.layers[layer])
    }
    jointHistory.commitFrom(frame.jointStereo)
    return frame.output.slice()
  }
}

/**
 * Select the detached transaction for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Transaction stage.
 */
export function beginTransaction(context) {
  return context.profile.bitrateKbps === 132
    ? beginIndependent(context)
    : beginLayered(context)
}

/**
 * Build the gain-adjusted independent spectrum.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Spectrum application.
 */

/**
 * Compose layered allocation and shared finalization.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation application.
 */

/**
 * Publish selected sound-unit candidates as final syntax.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Quantization operation.
 */

/**
 * Select byte packing for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Packing stage.
 */
export function pack(context) {
  return context.profile.bitrateKbps === 132
    ? packIndependent(context)
    : packLayered(context)
}

/**
 * Select atomic state publication for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): Uint8Array} Commit stage.
 */
export function commitFrame(context) {
  return context.profile.bitrateKbps === 132
    ? commitIndependent(context)
    : commitLayered(context)
}

/**
 * Count the residual-band prefix covering one coefficient limit.
 *
 * @param {number} limit Coefficient limit.
 * @returns {number} Covering residual-band count.
 */
function countBands(limit) {
  let count = 1
  while (count < SPECTRUM_GROUPS && LAYER_BAND_OFFSETS[count] < limit) count++
  return count
}

/**
 * Restore independent histories when starting one encoder stream.
 *
 * @param {EncoderContext} context Encoder ownership context.
 */
function setupIndependent(context) {
  const histories = context.bufferPool.encoder.state.independentChannels
  for (const history of histories) history.reset()
}

/**
 * Configure layered frame work and restore its persistent histories.
 *
 * @param {EncoderContext} context Encoder ownership context.
 */
function setupLayered(context) {
  const encoder = context.bufferPool.encoder
  const configuration = LAYER_PROFILE_CONFIGURATION[context.profile.bitrateKbps]
  const work = encoder.frame.layeredWork
  const jointWork = encoder.frame.jointStereoWork
  jointWork.ratioScaledSlotCount = -1
  for (let layer = 0; layer < work.length; layer++) {
    const jointSecondary = configuration.jointStereo && layer === 1
    const coefficientLimit = Math.trunc(
      (configuration.workSizes[layer] * (FRAME_SAMPLES * 2)) / SAMPLE_RATE
    )
    work[layer].bitBudget =
      (configuration.budgetBases[layer] << 3) -
      (jointSecondary ? LAYER_SECONDARY_HEADER_BITS : LAYER_PRIMARY_HEADER_BITS)
    work[layer].scaleFactorBandLimit = countBands(coefficientLimit)
    work[layer].jointSecondary = jointSecondary
    encoder.state.layeredHistories[layer].reset()
    if (jointSecondary) {
      jointWork.ratioScaledSlotCount = Math.max(
        1,
        Math.trunc(
          (coefficientLimit + JOINT_STEREO_SLOT_ROUNDING) / (FRAME_SAMPLES / 4)
        )
      )
    }
  }
  encoder.state.jointStereoHistory.reset(configuration.jointStereo)
}

/**
 * Select construction setup for the resolved stream profile.
 *
 * @param {EncoderContext} context Encoder ownership context.
 */
function setupEncoder(context) {
  const setup =
    context.profile.bitrateKbps === 132 ? setupIndependent : setupLayered
  setup(context)
}

/**
 * Compose the internal signed-amplitude encoder stage chain.
 *
 * @param {object} [options] Profile options for 66, 105, or 132 kbps.
 * @param {BufferPool} [bufferPool] Reusable persistent and scratch storage.
 * @returns {function(Float32Array[]): Uint8Array} One-frame stereo encoder.
 */
function createCodecEncoder(options = {}, bufferPool = new BufferPool()) {
  const profile = resolveProfile(options)
  if (!profile) throw new RangeError('Unsupported ATRAC3 encoder profile')
  const context = {
    profile,
    bufferPool,
  }
  setupEncoder(context)
  return pipe(
    context,
    validateFrame,
    beginTransaction,
    analyze,
    allocate,
    quantize,
    pack,
    commitFrame
  )
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
  const encodeFrame = createCodecEncoder(options, bufferPool)
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
