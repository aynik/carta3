/** Carta3 construction-selected allocation solver. */

import { measureResidualSource } from '../allocation/source.js'
import { allocateSoundUnitCandidates } from '../allocation/independent.js'
import { allocateJointLayers } from '../allocation/budget.js'
import {
  applyResidualProposal,
  createResidualQualityProfile,
  refineResidual,
} from '../coding/finalization.js'
import { allocateLayeredResidual } from '../allocation/layered.js'
import { PAIR_BLOCK_GAIN_COUNT_WORD } from '../core/constants.js'
import { countLayeredChannelBits } from '../syntax/unit/writer/layered.js'
import { pipe } from '../utils.js'

/**
 * Choose exact sound-unit syntax without publishing persistent state.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Independent solver.
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
 * Select a shared 66 kbps budget without writing the frame buffer.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Joint allocation operation.
 */
function shareBudget(context) {
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
function allocateResidual(context) {
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
 * Compose layered residual allocation and shared finalization.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered solver.
 */
function allocateLayered(context) {
  return pipe(context, allocateResidual, finalizeLayered)
}

/**
 * Compose joint-stereo shared budgeting and finalization.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Joint solver.
 */
function allocateJoint(context) {
  return pipe(context, shareBudget, finalizeLayered)
}

/**
 * Refine completed layers and publish only a jointly viable proposal pair.
 *
 * @returns {function(EncoderFrame): EncoderFrame} Residual finalization.
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
 * Select the allocation solver for the configured stream profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Selected solver.
 */
export function solve(context) {
  if (context.profile.bitrateKbps === 132) {
    return allocateIndependent(context)
  }
  return context.profile.bitrateKbps === 66
    ? allocateJoint(context)
    : allocateLayered(context)
}
