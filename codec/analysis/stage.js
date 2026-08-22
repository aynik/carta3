/**
 * Carta3 signal-analysis stage.
 *
 * Stable profile selection chooses one short analysis recipe at construction.
 */

import { selectJointStereoModes, selectJointStereoRatios } from './stereo.js'
import { planGainRecords } from './gain/independent.js'
import { analyzeLayeredGain } from './gain/layered.js'
import {
  BAND_PART_FLOATS,
  FORWARD_TRANSFORM_CARRY_OFFSET,
  FRAME_SAMPLES,
  SUBBAND_COUNT,
  TRANSFORM_CARRY_OFFSET_FLOATS,
} from '../core/constants.js'
import { selectEncoderMode } from '../core/profiles.js'
import {
  prepareGainAdjustedWindows,
  applyLayeredGainScale,
} from '../signal/gain.js'
import { applyJointStereoConversion } from '../signal/stereo.js'
import {
  writeLayeredMdctOutputs,
  writeIndependentMdctOutputs,
} from '../signal/spectrum.js'
import {
  analyzeIndependentQmfChannel,
  analyzeLayeredQmfChannel,
  bandMdctOffset,
} from '../signal/bands.js'
import { pipe } from '../utils.js'

/** @import { EncoderContext, PcmFrame } from '../pipeline/encoder.js' */
/** @import { GainRecord } from '../state/gain.js' */

/**
 * Continuous codec-domain representation and signal decisions.
 *
 * @typedef {PcmFrame & object} AnalysisFrame
 * @property {Float32Array[]} spectra Retained channel spectra.
 * @property {object[]} channelBlocks Independent-channel signal decisions.
 * @property {object[]} layers Layered signal work when selected.
 */

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
 * @param {Float32Array} analysisWork
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
 * @param {Float32Array} analysisWork
 * @returns {Float32Array}
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
 * @param {Float32Array} analysisWork
 * @returns {Float32Array}
 */
function referenceTransformCarry(analysisWork) {
  return analysisWork.subarray(
    FORWARD_TRANSFORM_CARRY_OFFSET,
    FORWARD_TRANSFORM_CARRY_OFFSET + FRAME_SAMPLES
  )
}

/**
 * Build the gain-adjusted independent spectrum.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Spectrum application.
 */
function analyzeSpectrum(context) {
  return pipe(context, prepareGainWindows, transformSpectrum)
}

/**
 * Build the independent zero-gain comparison spectrum.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Reference application.
 */
function analyzeReference(context) {
  return pipe(context, prepareReference, transformReference)
}

/**
 * Select and apply the configured joint-stereo representation.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Joint-stereo application.
 */
function analyzeStereo(context) {
  return pipe(context, selectStereo, applyStereo)
}

/**
 * Build both gain-adjusted layered spectra.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Layered spectrum application.
 */
function analyzeLayeredSpectrum(context) {
  return pipe(context, applyLayeredGain, transformLayers)
}

/**
 * Compose independent-channel signal analysis.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Analysis application.
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Analysis application.
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Analysis application.
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
 * Advance the four-band QMF histories for both frame-transaction channels.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Independent band analysis.
 */
export function analyzeBands(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < frame.channels.length; channel++) {
      analyzeIndependentQmfChannel(
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Independent gain analysis.
 */
export function planGain(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < frame.channels.length; channel++) {
      const planned = planGainRecords(
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Gain-window application.
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Coded-spectrum operation.
 */
export function transformSpectrum(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      writeIndependentMdctOutputs(
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Reference-window application.
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Reference MDCT operation.
 */
export function transformReference(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      if (!frame.referenceTransformNeeded[channel]) continue
      writeIndependentMdctOutputs(
        frame.referenceWindows[channel],
        frame.referenceSpectra[channel],
        encoder.scratch.mdct[channel]
      )
    }
    return frame
  }
}

/**
 * Run the stateful low-rate QMF over the complete stereo transaction.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Layered band analysis.
 */
export function analyzeLayeredBands(context) {
  const encoder = context.bufferPool.encoder
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      const state = frame.layers[layer]
      analyzeLayeredQmfChannel(
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Stereo selection operation.
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Stereo mapping operation.
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Layered gain analysis.
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
 * @returns {function(AnalysisFrame): AnalysisFrame} Layered-window application.
 */
export function applyLayeredGain() {
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      applyLayeredGainScale(frame.layerWords[layer])
    }
    return frame
  }
}

/**
 * Run each prepared low-rate layer through only its forward MDCT.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Layered MDCT operation.
 */
export function transformLayers(context) {
  const scratch = context.bufferPool.encoder.scratch.layeredMdct
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      writeLayeredMdctOutputs(
        frame.layers[layer],
        frame.layerWords[layer],
        scratch
      )
    }
    return frame
  }
}

/**
 * Select signal analysis for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AnalysisFrame} Analysis stage.
 */
export function analyze(context) {
  const analyzeMode = selectEncoderMode(
    context.profile,
    analyzeIndependent,
    analyzeLayered,
    analyzeJoint
  )
  return analyzeMode(context)
}
