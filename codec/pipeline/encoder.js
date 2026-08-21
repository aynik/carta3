/**
 * Carta3 Audio Codec - Streaming ATRAC3 encoder pipeline.
 *
 * Validation and detached state surround analysis, allocation, quantization,
 * and packing in one linear recipe. Atomic commit publishes successful frames.
 */

import { allocateSoundUnitCandidates } from '../coding/allocation.js'
import {
  selectJointStereoModes,
  selectJointStereoRatios,
} from '../analysis/joint-stereo.js'
import {
  allocateLayeredResidual,
  quantizeLayeredResidual,
} from '../coding/layered.js'
import { allocateJointLayers } from '../coding/budget.js'
import {
  applyResidualProposal,
  createResidualQualityProfile,
  refineResidual,
} from '../coding/finalization.js'
import { measureResidualSource } from '../analysis/residual.js'
import { planGainControl } from '../analysis/gain.js'
import { analyzeLayeredGain } from '../analysis/layered-gain.js'
import { BufferPool } from '../core/buffers.js'
import {
  BAND_PART_FLOATS,
  FORWARD_TRANSFORM_CARRY_OFFSET,
  FRAME_SAMPLES,
  JOINT_STEREO_SLOT_ROUNDING,
  LAYER_PRIMARY_HEADER_BITS,
  LAYER_SECONDARY_HEADER_BITS,
  PAIR_BLOCK_GAIN_COUNT_WORD,
  SAMPLE_RATE,
  SPECTRUM_GROUPS,
  SUBBAND_COUNT,
  TRANSFORM_CARRY_OFFSET_FLOATS,
} from '../core/constants.js'
import { resolveProfile } from '../core/profiles.js'
import {
  LAYER_BAND_OFFSETS,
  LAYER_PROFILE_CONFIGURATION,
} from '../core/tables.js'
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
    return { channels }
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
export function analyzeBands(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < frame.channels.length; channel++) {
      analyzeIndependentQmf(
        frame.channels[channel],
        frame.analysisWork[channel],
        encoder.scratch.qmf
      )
    }
    frame.bandHalves = frame.analysisWork.map(currentBandHalves)
    return frame
  }
}

/**
 * Plan both channels' gain records before either plan can be published.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Independent gain analysis.
 */
export function planGain(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < frame.channels.length; channel++) {
      const planned = planGainControl(
        frame.analysisWork[channel],
        frame.previousGainRecords[channel],
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
 * @returns {function(EncoderFrame): EncoderFrame} Gain-window application.
 */
export function prepareGainWindows(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      const prepared = prepareGainAdjustedWindows(
        frame.bandHalves[channel],
        frame.previousGainRecords[channel],
        frame.channelBlocks[channel].gainRecords,
        transformCarry(frame.analysisWork[channel]),
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
 * @returns {function(EncoderFrame): EncoderFrame} Coded-spectrum operation.
 */
export function transformSpectrum(context) {
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
 * @returns {function(EncoderFrame): EncoderFrame} Reference-window application.
 */
export function prepareReference(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    encoder.frame.referenceTransformNeeded.fill(0)
    frame.referenceTransformNeeded = encoder.frame.referenceTransformNeeded
    for (let channel = 0; channel < 2; channel++) {
      const needsTransform =
        gainRecordsAreActive(frame.channelBlocks[channel].gainRecords) ||
        gainRecordsAreActive(frame.previousGainRecords[channel])
      if (!needsTransform) {
        encoder.frame.referenceSpectra[channel].set(frame.spectra[channel])
        const carry = referenceTransformCarry(frame.analysisWork[channel])
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
        referenceTransformCarry(frame.analysisWork[channel]),
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
 * @returns {function(EncoderFrame): EncoderFrame} Reference MDCT operation.
 */
export function transformReference(context) {
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
function allocateIndependent(context) {
  const { profile } = context
  const encoder = context.bufferPool.encoder
  const unitBits = (profile.bytesPerFrame / 2) * 8
  return (frame) => {
    const candidates = encoder.frame.soundUnitCandidates
    for (let channel = 0; channel < 2; channel++) {
      frame.channelBlocks[channel].copyTo(candidates[channel])
      encoder.frame.selectedSoundUnitBits[channel] =
        allocateSoundUnitCandidates(
          frame.spectra[channel],
          frame.referenceSpectra[channel],
          candidates[channel],
          encoder.scratch.allocation.candidateBlock,
          frame.previousGainRecords[channel],
          unitBits,
          encoder.scratch.allocation
        )
    }
    frame.soundUnits = candidates
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
export function analyzeLayeredBands(context) {
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
 * @returns {function(EncoderFrame): EncoderFrame} Stereo selection operation.
 */
export function selectStereo() {
  return (frame) => {
    const energies = selectJointStereoModes(frame.jointStereo, frame.layers)
    selectJointStereoRatios(frame.jointStereo, energies)
    return frame
  }
}

/**
 * Apply the fully selected 66 kbps conversion to both spectra.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Stereo mapping operation.
 */
export function applyStereo() {
  return (frame) => {
    applyJointStereoConversion(frame.jointStereo, frame.layers)
    return frame
  }
}

/**
 * Select layered gain regions without modifying transform samples.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered gain analysis.
 */
export function planLayeredGain(context) {
  const encoder = context.bufferPool.encoder
  const words = encoder.frame.layerWords
  const scratch = encoder.scratch.layeredGain
  return (frame) => {
    const hints = frame.jointStereo.absoluteModeHints
    const modes = frame.jointStereo.slotModes
    for (let layer = 0; layer < 2; layer++) {
      analyzeLayeredGain(
        frame.layers[layer],
        hints,
        modes,
        words[layer],
        scratch
      )
    }
    frame.layerWords = words
    return frame
  }
}

/**
 * Apply each layered gain plan to its detached transform input.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Layered-window application.
 */
export function applyLayeredGain() {
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      prepareLayeredGain(frame.layerWords[layer])
    }
    return frame
  }
}

/**
 * Run each prepared low-rate layer through only its forward MDCT.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered MDCT operation.
 */
export function transformLayers(context) {
  const scratch = context.bufferPool.encoder.scratch.layeredMdct
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      runLayeredMdct(frame.layers[layer], frame.layerWords[layer], scratch)
    }
    return frame
  }
}

/**
 * Select a shared 66 kbps budget without writing the frame buffer.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Joint allocation operation.
 */
function allocateJoint(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    const split = allocateJointLayers({
      layers: frame.layers,
      outputWorks: encoder.frame.layeredAllocations,
      candidateWorks: encoder.scratch.layeredAllocation.candidateWorks,
      residualSourceProfiles: encoder.scratch.layeredAllocation.sourceProfiles,
      jointStereo: frame.jointStereo,
      bytesPerFrame: context.profile.bytesPerFrame,
      measureLayerBits: countLayeredChannelBits,
    })
    frame.layeredOffsets = [0, split]
    frame.layeredAllocationWork = encoder.frame.layeredAllocations
    return frame
  }
}

/**
 * Allocate the two independent 105 kbps residual layers.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layer allocation operation.
 */
function allocateSeparate(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
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
 * Lower transformed layers into detached allocation images.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layer allocation stage.
 */
export function allocateResiduals(context) {
  return context.profile.bitrateKbps === 66
    ? allocateJoint(context)
    : allocateSeparate(context)
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
export function finalizeLayered() {
  return (frame) => {
    const states = frame.layers
    const works = frame.layeredAllocationWork
    const canPropose = !layeredHasGainPoints(states)
    let canApply = true
    let hasProposal = false
    const proposals = [null, null]

    for (let layer = 0; layer < 2; layer++) {
      const qualityProfile =
        canPropose && canApply
          ? createResidualQualityProfile(states[layer])
          : null
      const proposal = refineResidual(
        states[layer],
        works[layer],
        qualityProfile
      )
      proposals[layer] = proposal
      if (proposal) {
        hasProposal = true
        if (!proposal.strictlyImprovesAll) canApply = false
      }
    }

    if (hasProposal && canApply) {
      for (let layer = 0; layer < 2; layer++) {
        if (proposals[layer]) {
          applyResidualProposal(proposals[layer], works[layer])
        }
      }
    }
    return frame
  }
}

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
function analyzeSpectrum(context) {
  return pipe(context, prepareGainWindows, transformSpectrum)
}

/**
 * Build the independent zero-gain comparison spectrum.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Reference application.
 */
function analyzeReference(context) {
  return pipe(context, prepareReference, transformReference)
}

/**
 * Select and apply the configured joint-stereo representation.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Joint-stereo application.
 */
function analyzeStereo(context) {
  return pipe(context, selectStereo, applyStereo)
}

/**
 * Build both gain-adjusted layered spectra.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered spectrum application.
 */
function analyzeLayeredSpectrum(context) {
  return pipe(context, applyLayeredGain, transformLayers)
}

/**
 * Compose independent-channel signal analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis application.
 */
function analyzeIndependent(context) {
  return pipe(
    context,
    analyzeBands,
    planGain,
    analyzeSpectrum,
    analyzeReference
  )
}

/**
 * Compose layered signal analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis application.
 */
function analyzeLayered(context) {
  return pipe(
    context,
    analyzeLayeredBands,
    planLayeredGain,
    analyzeLayeredSpectrum
  )
}

/**
 * Compose joint-stereo signal analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis application.
 */
function analyzeJoint(context) {
  return pipe(
    context,
    analyzeLayeredBands,
    analyzeStereo,
    planLayeredGain,
    analyzeLayeredSpectrum
  )
}

/**
 * Select signal analysis for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Analysis stage.
 */
export function analyze(context) {
  if (context.profile.bitrateKbps === 132) {
    return analyzeIndependent(context)
  }
  return context.profile.bitrateKbps === 66
    ? analyzeJoint(context)
    : analyzeLayered(context)
}

/**
 * Compose layered allocation and shared finalization.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation application.
 */
function allocateLayered(context) {
  return pipe(context, allocateResiduals, finalizeLayered)
}

/**
 * Select bit allocation for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation stage.
 */
export function allocate(context) {
  return context.profile.bitrateKbps === 132
    ? allocateIndependent(context)
    : allocateLayered(context)
}

/**
 * Publish selected sound-unit candidates as final syntax.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Quantization operation.
 */
function quantizeIndependent() {
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      frame.soundUnits[channel].copyTo(frame.channelBlocks[channel])
    }
    return frame
  }
}

/**
 * Materialize both layers' retained residual symbols.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Quantization operation.
 */
function quantizeLayered(context) {
  const symbols = context.bufferPool.encoder.frame.layeredSymbols
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      quantizeLayeredResidual(
        frame.layers[layer],
        frame.layeredAllocationWork[layer],
        symbols[layer]
      )
    }
    frame.layeredSymbols = symbols
    return frame
  }
}

/**
 * Select final symbol materialization for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Quantization stage.
 */
export function quantize(context) {
  return context.profile.bitrateKbps === 132
    ? quantizeIndependent()
    : quantizeLayered(context)
}

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
  const context = { profile, bufferPool }
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
