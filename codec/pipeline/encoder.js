/**
 * Carta3 Audio Codec - Streaming ATRAC3 encoder pipeline.
 *
 * Validation and detached state surround analysis, allocation, quantization,
 * and packing in one linear recipe. Atomic commit publishes successful frames.
 */

import { BufferPool } from '../state/storage.js'
import {
  FRAME_SAMPLES,
  JOINT_STEREO_SLOT_ROUNDING,
  LAYER_PRIMARY_HEADER_BITS,
  LAYER_SECONDARY_HEADER_BITS,
  SAMPLE_RATE,
  SPECTRUM_GROUPS,
} from '../core/constants.js'
import { resolveProfile, selectEncoderMode } from '../core/profiles.js'
import {
  LAYER_BAND_OFFSETS,
  LAYER_PROFILE_CONFIGURATION,
} from '../core/tables.js'
import { scalePcmFrame } from '../boundary/pcm.js'
import { beginEncoderFrame, commitEncoderFrame } from '../state/stream.js'
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
import { pack } from '../packing.js'
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
  const setup = selectEncoderMode(
    context.profile,
    setupIndependent,
    setupLayered,
    setupLayered
  )
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
    beginEncoderFrame,
    analyze,
    allocate,
    quantize,
    pack,
    commitEncoderFrame
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
