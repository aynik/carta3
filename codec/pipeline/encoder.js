/**
 * Carta3 Audio Codec - Streaming ATRAC3 encoder composed from explicit transactional stages.
 */

import { allocateSoundUnitCandidates } from '../coding/allocation.js'
import {
  selectJointStereoModes,
  selectJointStereoRatios,
} from '../analysis/joint-stereo.js'
import { allocateLayeredResidual } from '../coding/layered.js'
import { selectJointLayerBudget } from '../coding/budget.js'
import {
  applyResidualModeTransaction,
  createResidualQualityProfile,
  finalizeResidualPareto,
} from '../coding/finalization.js'
import { measureResidualSource } from '../analysis/residual.js'
import { planGainControl } from '../analysis/gain.js'
import { analyzeLayeredGain } from '../analysis/layered-gain.js'
import { BufferPool } from '../core/buffers.js'
import {
  BAND_PART_FLOATS,
  FORWARD_TRANSFORM_CARRY_OFFSET,
  FRAME_SAMPLES,
  PAIR_BLOCK_GAIN_COUNT_WORD,
  SUBBAND_COUNT,
  TRANSFORM_CARRY_OFFSET_FLOATS,
} from '../core/constants.js'
import { LayeredEncoderState } from '../state/layered.js'
import { resolveProfile } from '../core/profiles.js'
import {
  countLayeredChannelBits,
  packLayeredChannel,
} from '../io/layered-channel.js'
import { packSoundUnit } from '../io/sound-unit.js'
import { scalePcmFrame } from '../io/pcm.js'
import {
  prepareGainAdjustedWindows,
  prepareLayeredGain,
} from '../transforms/gain-scale.js'
import { applyJointStereoConversion } from '../transforms/joint-stereo.js'
import {
  runLayeredMdct,
  transformPreparedSubbands,
} from '../transforms/mdct.js'
import {
  analyzeIndependentQmf,
  analyzeLayeredQmf,
  bandMdctOffset,
} from '../transforms/qmf.js'
import { pipe } from '../utils.js'

/** Identify a failed pre-transform sound-unit phase and channel. */
class SoundUnitAnalysisError extends Error {
  /**
   * Create an error annotated with its failed phase and channel index.
   *
   * @param {string} stage
   * @param {number} channel
   */
  constructor(stage, channel) {
    super(`ATRAC3 ${stage} failed for channel ${channel}`)
    this.name = 'SoundUnitAnalysisError'
    this.stage = stage
    this.channel = channel
  }
}

/**
 * Return whether any record changes the unity gain window.
 *
 * @param {GainRecord[]} records
 * @returns {boolean}
 */
function gainRecordsAreActive(records) {
  return records.some((record) => record.entries !== 0)
}

/**
 * Select a detached ring node without overwriting committed state.
 *
 * @param {number} activeIndex
 * @returns {number}
 */
function nextRingIndex(activeIndex) {
  return (activeIndex + 2) % 3
}

/**
 * Expose the four newest QMF halves without copying them.
 *
 * @param {object} analysisWork
 * @returns {Float32Array[]}
 */
function currentBandHalves(analysisWork) {
  return Array.from({ length: SUBBAND_COUNT }, (_, band) => {
    const offset = bandMdctOffset(band)
    return analysisWork.subarray(offset, offset + BAND_PART_FLOATS)
  })
}

/**
 * Expose the coded-gain MDCT overlap carry.
 *
 * @param {object} analysisWork
 * @returns {Float32Array[]}
 */
function transformCarry(analysisWork) {
  return analysisWork.subarray(
    TRANSFORM_CARRY_OFFSET_FLOATS,
    TRANSFORM_CARRY_OFFSET_FLOATS + FRAME_SAMPLES
  )
}

/**
 * Expose the independent zero-gain reference overlap carry.
 *
 * @param {object} analysisWork
 * @returns {Float32Array[]}
 */
function referenceTransformCarry(analysisWork) {
  return analysisWork.subarray(
    FORWARD_TRANSFORM_CARRY_OFFSET,
    FORWARD_TRANSFORM_CARRY_OFFSET + FRAME_SAMPLES
  )
}

/**
 * Validate a complete stereo frame before transactional scratch advances.
 *
 * @returns {function(Float32Array[]): EncoderFrame} Reusable validation stage.
 */
export function validateFrameStage() {
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
    return { channels }
  }
}

/**
 * Capture reusable destination nodes for one all-channel transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Transaction capture stage.
 */
export function transactionStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      const active = encoder.state.activeChannelBlockIndices[channel]
      const target = nextRingIndex(active)
      encoder.frame.channelBlockIndices[channel] = target
      encoder.frame.previousChannelBlocks[channel] =
        encoder.state.channelBlockRing[channel][active]
      encoder.state.channelBlockRing[channel][target].stageTo(
        encoder.frame.channelBlocks[channel]
      )
      encoder.frame.independentChannels[channel].set(
        encoder.state.independentChannels[channel]
      )
    }
    frame.channelStates = encoder.frame.independentChannels
    frame.channelBlocks = encoder.frame.channelBlocks
    frame.previousChannelBlocks = encoder.frame.previousChannelBlocks
    return frame
  }
}

/**
 * Advance the four-band QMF histories for both frame-transaction channels.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Stateful QMF stage.
 */
export function qmfStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < frame.channels.length; channel++) {
      analyzeIndependentQmf(
        frame.channels[channel],
        frame.channelStates[channel],
        encoder.scratch.qmf
      )
    }
    frame.bandHalves = frame.channelStates.map(currentBandHalves)
    return frame
  }
}

/**
 * Plan both channels' gain records before either plan can be published.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Atomic gain-analysis stage.
 */
export function gainStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < frame.channels.length; channel++) {
      const planned = planGainControl(
        frame.channelStates[channel],
        frame.previousChannelBlocks[channel].gainRecords,
        frame.channelBlocks[channel].gainRecords,
        encoder.scratch.gainScale,
        encoder.scratch.gainAnalysis
      )
      if (!planned) {
        throw new SoundUnitAnalysisError('gain planning', channel)
      }
    }
    return frame
  }
}

/**
 * Apply selected gain windows and advance carry without transforming.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Gain preparation stage.
 */
export function gainPreparationStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      const prepared = prepareGainAdjustedWindows(
        frame.bandHalves[channel],
        frame.previousChannelBlocks[channel].gainRecords,
        frame.channelBlocks[channel].gainRecords,
        transformCarry(frame.channelStates[channel]),
        encoder.frame.preparedMdctWindows[channel],
        encoder.scratch.gainScale
      )
      if (!prepared) {
        throw new SoundUnitAnalysisError('gain application', channel)
      }
    }
    frame.mdctWindows = encoder.frame.preparedMdctWindows
    return frame
  }
}

/**
 * Transform prepared four-band windows without applying or selecting gain.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Forward MDCT stage.
 */
export function mdctStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      transformPreparedSubbands(
        frame.mdctWindows[channel],
        encoder.frame.analyzedSpectra[channel],
        encoder.scratch.mdct[channel]
      )
    }
    frame.spectra = encoder.frame.analyzedSpectra
    return frame
  }
}

/**
 * Prepare the independent zero-gain comparison used by allocation.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Reference preparation stage.
 */
export function referencePreparationStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    encoder.frame.referenceTransformNeeded.fill(0)
    frame.referenceTransformNeeded = encoder.frame.referenceTransformNeeded
    for (let channel = 0; channel < 2; channel++) {
      const needsTransform =
        gainRecordsAreActive(frame.channelBlocks[channel].gainRecords) ||
        gainRecordsAreActive(frame.previousChannelBlocks[channel].gainRecords)
      if (!needsTransform) {
        encoder.frame.referenceSpectra[channel].set(frame.spectra[channel])
        const carry = referenceTransformCarry(frame.channelStates[channel])
        const bands = frame.bandHalves[channel]
        for (let band = 0; band < SUBBAND_COUNT; band++) {
          carry.set(bands[band], band * BAND_PART_FLOATS)
        }
        continue
      }
      const prepared = prepareGainAdjustedWindows(
        frame.bandHalves[channel],
        encoder.scratch.gainScale.neutralRecords,
        encoder.scratch.gainScale.neutralRecords,
        referenceTransformCarry(frame.channelStates[channel]),
        encoder.frame.preparedReferenceWindows[channel],
        encoder.scratch.gainScale
      )
      if (!prepared) {
        throw new SoundUnitAnalysisError('reference preparation', channel)
      }
      frame.referenceTransformNeeded[channel] = 1
    }
    frame.referenceWindows = encoder.frame.preparedReferenceWindows
    frame.referenceSpectra = encoder.frame.referenceSpectra
    return frame
  }
}

/**
 * Transform only zero-gain windows that require a second MDCT.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Reference transform stage.
 */
export function referenceSpectrumStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      if (!frame.referenceTransformNeeded[channel]) continue
      transformPreparedSubbands(
        frame.referenceWindows[channel],
        frame.referenceSpectra[channel],
        encoder.scratch.mdct[channel]
      )
    }
    return frame
  }
}

/**
 * Choose exact sound-unit syntax without publishing persistent state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation stage.
 */
export function allocationStage(context) {
  const { profile } = context
  const encoder = context.bufferPool.encoder
  const unitBits = (profile.bytesPerFrame / 2) * 8
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      encoder.frame.selectedSoundUnitBits[channel] =
        allocateSoundUnitCandidates(
          frame.spectra[channel],
          frame.referenceSpectra[channel],
          frame.channelBlocks[channel],
          encoder.scratch.allocation.candidateBlock,
          frame.previousChannelBlocks[channel].gainRecords,
          unitBits,
          encoder.scratch.allocation
        )
    }
    frame.soundUnitBits = encoder.frame.selectedSoundUnitBits
    return frame
  }
}

/**
 * Pack the complete stereo frame after all coding decisions are final.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Wire-publication stage.
 */
export function packingStage(context) {
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
export function commitStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      const target = encoder.frame.channelBlockIndices[channel]
      encoder.state.independentChannels[channel].set(
        frame.channelStates[channel]
      )
      frame.channelBlocks[channel].copyTo(
        encoder.state.channelBlockRing[channel][target]
      )
      encoder.state.activeChannelBlockIndices[channel] = target
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
export function layeredTransactionStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      encoder.state.layeredChannels[layer].copyTo(
        encoder.frame.layeredChannels[layer]
      )
    }
    encoder.state.jointStereo.copyTo(encoder.frame.jointStereo)
    frame.layers = encoder.frame.layeredChannels
    frame.jointStereo = encoder.frame.jointStereo
    return frame
  }
}

/**
 * Run the stateful low-rate QMF over the complete stereo transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered QMF stage.
 */
export function layeredQmfStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      const state = frame.layers[layer]
      analyzeLayeredQmf(
        frame.channels[layer],
        state.spectrum,
        state.qmfHistory,
        encoder.scratch.layeredQmf
      )
    }
    return frame
  }
}

/**
 * Select 66 kbps modes and ratios without modifying either spectrum.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Joint-stereo analysis stage.
 */
export function layeredJointStereoAnalysisStage(context) {
  if (context.profile.bitrateKbps !== 66) return (frame) => frame
  return (frame) => {
    selectJointStereoModes(frame.jointStereo, frame.layers)
    selectJointStereoRatios(frame.jointStereo)
    return frame
  }
}

/**
 * Apply the fully selected 66 kbps conversion to both spectra.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Joint-stereo transform stage.
 */
export function layeredJointStereoTransformStage(context) {
  if (context.profile.bitrateKbps !== 66) return (frame) => frame
  return (frame) => {
    applyJointStereoConversion(frame.jointStereo, frame.layers)
    return frame
  }
}

/**
 * Select layered gain regions without modifying transform samples.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered gain-analysis stage.
 */
export function layeredGainAnalysisStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    const hints = frame.jointStereo.absoluteModeHints
    const modes = frame.jointStereo.slotModes
    for (let layer = 0; layer < 2; layer++) {
      analyzeLayeredGain(
        frame.layers[layer],
        hints,
        modes,
        encoder.frame.layeredTransformStates[layer]
      )
    }
    frame.layeredTransformStates = encoder.frame.layeredTransformStates
    return frame
  }
}

/**
 * Apply each layered gain plan to its detached transform input.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Gain-preparation stage.
 */
export function layeredGainPreparationStage() {
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      prepareLayeredGain(frame.layeredTransformStates[layer])
    }
    return frame
  }
}

/**
 * Run each prepared low-rate layer through only its forward MDCT.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Layered MDCT stage.
 */
export function layeredMdctStage() {
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      runLayeredMdct(frame.layers[layer], frame.layeredTransformStates[layer])
    }
    return frame
  }
}

/**
 * Lower transformed layers into detached allocation images.
 *
 * At 66 kbps this stage selects a shared budget using destination-free exact
 * bit counts; it never writes the frame buffer.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layer allocation stage.
 */
export function layeredAllocationStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    if (context.profile.bitrateKbps === 66) {
      const selected = selectJointLayerBudget({
        layers: frame.layers,
        selectedWorks: encoder.frame.layeredAllocations,
        candidateWorks: encoder.scratch.layeredAllocation.candidateWorks,
        residualSourceProfiles:
          encoder.scratch.layeredAllocation.sourceProfiles,
        jointStereo: frame.jointStereo,
        bytesPerFrame: context.profile.bytesPerFrame,
        measureLayerBits: countLayeredChannelBits,
      })
      frame.layeredOffsets = [0, selected.split]
      frame.layeredJointStereo = true
      frame.layeredBudgetSelection = selected
      frame.layeredAllocationWork = encoder.frame.layeredAllocations
      return frame
    }
    const stereoMode = frame.jointStereo.previousOutputSelector
    for (let layer = 0; layer < 2; layer++) {
      const state = frame.layers[layer]
      const profile = measureResidualSource(
        state,
        encoder.scratch.layeredAllocation.sourceProfiles[layer]
      )
      const work = encoder.frame.layeredAllocations[layer]
      work.fill(0)
      allocateLayeredResidual(
        state,
        profile,
        state.scaleFactorBandLimit,
        state.bitBudget,
        stereoMode,
        work
      )
    }
    frame.layeredAllocationWork = encoder.frame.layeredAllocations
    return frame
  }
}

/**
 * Return whether gain syntax makes equal-rate stereo exchange unsafe.
 *
 * @param {object[]} states
 * @returns {boolean}
 */
function layeredHasGainPoints(states) {
  return states.some((state) =>
    state.pairBlocks.some((block) => block[PAIR_BLOCK_GAIN_COUNT_WORD] !== 0)
  )
}

/**
 * Refine each completed layer, then atomically publish only a jointly viable
 * pair of equal-rate residual-mode exchanges. This is the shared stereo
 * decision boundary between channel-local allocation and channel emission.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Residual finalization stage.
 */
export function layeredFinalizationStage() {
  return (frame) => {
    const states = frame.layers
    const works = frame.layeredAllocationWork
    const transactionRequested = !layeredHasGainPoints(states)
    let strictTransactionViable = true
    let hasModeTransaction = false
    const transactions = [null, null]

    for (let layer = 0; layer < 2; layer++) {
      const searchRequested = transactionRequested && strictTransactionViable
      const qualityProfile = searchRequested
        ? createResidualQualityProfile(states[layer])
        : null
      const finalized = finalizeResidualPareto(
        states[layer],
        works[layer],
        qualityProfile
      )
      const transaction = finalized.modeTransaction
      transactions[layer] = transaction
      if (transaction) {
        hasModeTransaction = true
        if (!transaction.strictlyImprovesAll) strictTransactionViable = false
      }
    }

    if (hasModeTransaction && strictTransactionViable) {
      for (let layer = 0; layer < 2; layer++) {
        if (transactions[layer]) {
          applyResidualModeTransaction(transactions[layer], works[layer])
        }
      }
    }
    frame.layeredModeTransactions = transactions
    return frame
  }
}

/**
 * Pack completed layers into their final independent or shared spans.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layer packing stage.
 */
export function layeredPackingStage(context) {
  const { profile } = context
  const encoder = context.bufferPool.encoder
  const stride = profile.bytesPerFrame / 2
  return (frame) => {
    const output = encoder.frame.packedBytes.subarray(0, profile.bytesPerFrame)
    output.fill(0)
    const offsets = frame.layeredOffsets ?? [0, stride]
    for (let layer = 0; layer < 2; layer++) {
      const end = packLayeredChannel(
        frame.layers[layer],
        frame.layeredAllocationWork[layer],
        offsets[layer],
        output,
        {
          previousOutput: frame.jointStereo.previousOutputSelector,
          gainSelectors: frame.jointStereo.absoluteModeHints,
        }
      )
      const limit = frame.layeredJointStereo
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
    if (frame.layeredJointStereo) {
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
export function layeredCommitStage(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      frame.layers[layer].copyTo(encoder.state.layeredChannels[layer])
    }
    frame.jointStereo.copyTo(encoder.state.jointStereo)
    return frame.output.slice()
  }
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
  const context = { options, profile, bufferPool }
  if (profile.bitrateKbps === 66 || profile.bitrateKbps === 105) {
    const configured = new LayeredEncoderState(options)
    for (let layer = 0; layer < 2; layer++) {
      configured.layers[layer].copyTo(
        bufferPool.encoder.state.layeredChannels[layer]
      )
    }
    configured.jointStereo.copyTo(bufferPool.encoder.state.jointStereo)
    return pipe(
      context,
      validateFrameStage,
      layeredTransactionStage,
      layeredQmfStage,
      layeredJointStereoAnalysisStage,
      layeredJointStereoTransformStage,
      layeredGainAnalysisStage,
      layeredGainPreparationStage,
      layeredMdctStage,
      layeredAllocationStage,
      layeredFinalizationStage,
      layeredPackingStage,
      layeredCommitStage
    )
  }
  if (profile.bitrateKbps !== 132) {
    throw new RangeError(
      'The current ATRAC3 stage chains support 66/105/132 kbps'
    )
  }
  return pipe(
    context,
    validateFrameStage,
    transactionStage,
    qmfStage,
    gainStage,
    gainPreparationStage,
    mdctStage,
    referencePreparationStage,
    referenceSpectrumStage,
    allocationStage,
    packingStage,
    commitStage
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
  const validateFrame = validateFrameStage()
  return (channels) => {
    validateFrame(channels)
    return encodeFrame(scalePcmFrame(channels, codecFrame))
  }
}
