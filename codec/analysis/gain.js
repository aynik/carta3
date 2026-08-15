/**
 * Carta3 Audio Codec - Gain detection, lowering, and cross-frame continuity planning.
 *
 * Detection first produces detached candidate records. Continuity edits are
 * then compared in reconstructed sample space before the pipeline publishes
 * either channel's plan.
 */

import { gainRecordBits } from '../coding/gain.js'
import {
  ATTACK_CANDIDATE_COUNT,
  BAND_PART_FLOATS,
  BAND_STRIDE_FLOATS,
  LOG2_E_F32,
  MAX_SELECTED_GAIN_CANDIDATES,
  SUBBAND_COUNT,
} from '../core/constants.js'
import { reconstructGainPairSignal } from '../transforms/gain-scale.js'
import { bandGainOffset } from '../transforms/qmf.js'
import { absoluteMaximum } from '../utils.js'

/**
 * Measure consecutive fixed-width absolute maxima into caller storage.
 *
 * @param {Float32Array} values
 * @param {number} start
 * @param {number} chunkLength
 * @param {Float32Array} output
 */
function fillAbsMaxChunks(values, start, chunkLength, output) {
  for (let chunk = 0; chunk < output.length; chunk++) {
    output[chunk] = absoluteMaximum(
      values,
      start + chunk * chunkLength,
      start + (chunk + 1) * chunkLength
    )
  }
}

/**
 * Detect an adaptive logarithmic rise and advance detector smoothing.
 *
 * @param {number} value Candidate peak magnitude.
 * @param {number} ceiling Previous running peak.
 * @param {{smoothedRise: number}} state Mutable detector history.
 * @returns {boolean} Whether the current rise triggers an event.
 */
export function detectGainLogFlux(value, ceiling, state) {
  const rise =
    ceiling > 0 && value > ceiling
      ? Math.max(0, Math.log(value / ceiling) * LOG2_E_F32)
      : 0
  const detected = rise > state.smoothedRise + 0.7
  state.smoothedRise = 0.3 * rise + 0.7 * state.smoothedRise
  return detected
}

/**
 * Convert a positive gain ratio to the codec's rounded log2 step.
 *
 * @param {number} value
 * @returns {number}
 */
function gainLog2Round(value) {
  const safe = value <= 1e-20 ? 1e-20 : value
  return Math.trunc(Math.log10(safe) / Math.log10(2) + 0.5)
}

/**
 * Mark one detector slot with its requested positive gain step.
 *
 * @param {object[]} entries
 * @param {number} slot
 * @param {number} requestedStep
 */
function detectCandidate(entries, slot, requestedStep) {
  entries[slot].requestedStep = Math.max(0, requestedStep)
  entries[slot].detected = true
}

/**
 * Retain the strongest detector events within the coded point limit.
 *
 * @param {object[]} entries
 * @param {number} detectedCount
 * @param {Int32Array} ranked
 */
function selectCandidates(entries, detectedCount, ranked) {
  const limit = Math.min(detectedCount, MAX_SELECTED_GAIN_CANDIDATES)
  let rankedCount = 0
  for (let slot = 0; slot < entries.length; slot++) {
    const candidate = entries[slot]
    if (
      !candidate.detected ||
      candidate.selected ||
      candidate.requestedStep <= 0
    ) {
      continue
    }
    let position = rankedCount
    while (
      position > 0 &&
      candidate.requestedStep > entries[ranked[position - 1]].requestedStep
    ) {
      position--
    }
    if (position >= MAX_SELECTED_GAIN_CANDIDATES) continue
    const last = Math.min(rankedCount, MAX_SELECTED_GAIN_CANDIDATES - 1)
    for (let index = last; index > position; index--) {
      ranked[index] = ranked[index - 1]
    }
    ranked[position] = slot
    if (rankedCount < MAX_SELECTED_GAIN_CANDIDATES) rankedCount++
  }
  for (let index = 0; index < Math.min(limit, rankedCount); index++) {
    entries[ranked[index]].selected = true
  }
  if (rankedCount < limit) entries[0].selected = true
}

/**
 * Detect attack/release breakpoints while advancing peak history.
 *
 * @param {Float32Array} spectrum
 * @param {number} sampleCount
 * @param {GainRecord} previousRecord
 * @param {GainAnalysisScratch} gainAnalysisScratch
 * @returns {object|null}
 */
function detectGainCandidates(
  spectrum,
  sampleCount,
  previousRecord,
  gainAnalysisScratch
) {
  const { maxima, groupMaxima, candidates, rankedCandidateSlots } =
    gainAnalysisScratch
  gainAnalysisScratch.resetCandidates()
  let detectedCount = 0
  const stride = sampleCount / 64
  const half = sampleCount / 2
  fillAbsMaxChunks(spectrum, half, stride, maxima)
  const peakHistory = absoluteMaximum(maxima, 0, ATTACK_CANDIDATE_COUNT)
  if (previousRecord.entries === 0 && peakHistory <= 10 && maxima[32] <= 10) {
    return {
      candidates,
      detectedCount,
      initialMaxGain: 0,
      fallbackAttackStep: 0,
      peakHistory,
    }
  }

  const maxWindow = absoluteMaximum(spectrum, half - stride * 4, half)
  let initialMaxGain = 0
  for (let index = 0; index < previousRecord.entries; index++) {
    const level = previousRecord.levels[index]
    if (level > 15) return null
    initialMaxGain = Math.max(initialMaxGain, -4 + level)
  }

  let previousMax = previousRecord.peakHistory
  const attackState = { smoothedRise: 0 }
  for (let index = 0; index <= 31; index++) {
    if (maxima[index] > previousMax) previousMax = maxima[index]
    const next = maxima[index + 1]
    const fired = detectGainLogFlux(next, previousMax, attackState)
    if (next > 10 && fired) {
      const ratio = previousMax > 4 ? next / previousMax : next * 0.25
      detectCandidate(candidates, index, gainLog2Round(ratio))
      detectedCount++
    }
  }

  fillAbsMaxChunks(maxima, 0, 4, groupMaxima)
  const canDetectReleases =
    previousRecord.entries > 0 ||
    candidates.slice(0, 32).some((item) => item.detected)
  if (canDetectReleases) {
    let currentMax = maxima[63]
    for (let index = 15; index >= 8; index--) {
      if (groupMaxima[index] > currentMax) currentMax = groupMaxima[index]
    }
    const releaseState = { smoothedRise: 0 }
    for (let index = 7; index >= 0; index--) {
      if (groupMaxima[index] > currentMax) currentMax = groupMaxima[index]
      const baseValue = index === 0 ? maxWindow : groupMaxima[index - 1]
      const fired = detectGainLogFlux(baseValue, currentMax, releaseState)
      if (baseValue > 10 && fired) {
        const ratio = currentMax > 4 ? baseValue / currentMax : baseValue * 0.25
        detectCandidate(candidates, 32 + index, gainLog2Round(ratio))
        detectedCount++
      }
    }
  }

  selectCandidates(candidates, detectedCount, rankedCandidateSlots)
  let fallbackAttackStep = 0
  if (candidates[0].selected && candidates[0].requestedStep === null) {
    const base = Math.max(previousRecord.peakHistory, maxima[0])
    fallbackAttackStep = gainLog2Round(
      base > 4 ? maxima[1] / base : maxima[1] * 0.25
    )
  }
  return {
    candidates,
    detectedCount,
    initialMaxGain,
    fallbackAttackStep,
    peakHistory,
  }
}

/**
 * Clamp one gain step to the remaining representable budget.
 *
 * @param {number} step
 * @param {number} used
 * @param {number} limit
 * @returns {number}
 */
function boundedGainStep(step, used, limit) {
  const requested = Math.max(0, step)
  return Math.min(requested, limit - used)
}

/**
 * Lower detector events into the seven-point coded representation.
 *
 * @param {object} detection
 * @param {GainRecord} previousRecord
 * @returns {object}
 */
function lowerGainCandidates(detection, previousRecord) {
  const up = []
  const down = []
  let maxGain = detection.initialMaxGain
  for (let position = 0; position <= 31; position++) {
    const candidate = detection.candidates[position]
    if (!candidate.selected) continue
    const requested = candidate.requestedStep ?? detection.fallbackAttackStep
    const emitted = boundedGainStep(requested, maxGain, 10)
    maxGain += emitted
    if (emitted > 0) {
      up.push({ position, amount: emitted })
      if (up.length > 6) break
    }
  }

  const limitGain = Math.min(maxGain, 4)
  let downSum = 0
  if (up.length > 0 || previousRecord.entries > 0) {
    for (let index = 7; index >= 0; index--) {
      if (downSum >= limitGain) break
      const candidate = detection.candidates[32 + index]
      if (!candidate.selected) continue
      const emitted = boundedGainStep(
        candidate.requestedStep ?? 0,
        downSum,
        limitGain
      )
      const pointAvailable = up.length <= 6
      downSum += emitted
      if (emitted > 0 && pointAvailable) {
        down.push({ position: index === 0 ? 1 : index * 4, amount: emitted })
      }
      if (up.length + down.length > 6) break
    }
  }
  return { up, down }
}

/**
 * Convert signed gain deltas to the cumulative coded level envelope.
 *
 * @param {object} lowered
 * @param {Int32Array} levels
 * @returns {Int32Array}
 */
function gainLevelEnvelope(lowered, levels) {
  let accumulated = 0
  for (let index = lowered.down.length - 1; index >= 0; index--) {
    const step = lowered.down[index]
    step.amount = Math.min(step.amount + accumulated, 4)
    accumulated = step.amount
  }
  const clampUp = 11 + accumulated
  accumulated = 0
  for (let index = lowered.up.length - 1; index >= 0; index--) {
    const step = lowered.up[index]
    step.amount = Math.min(step.amount + accumulated, clampUp)
    accumulated = step.amount
  }
  levels.fill(0)
  let position = 0
  for (const step of lowered.up) {
    while (position <= step.position) levels[position++] += step.amount
  }
  position = 32
  for (const step of lowered.down) {
    while (position >= step.position) levels[position--] += step.amount
  }
  return levels
}

/**
 * Materialize a record in caller-owned storage while preserving unused slots.
 *
 * @param {GainRecord} seed
 * @param {number} peakHistory
 * @param {Int32Array} levels
 * @returns {GainRecord|null}
 */
function buildGainRecord(seed, peakHistory, levels) {
  const events = []
  for (let location = 31; location >= 0; location--) {
    const delta = levels[location] - levels[location + 1]
    if (delta !== 0) events.push([location, delta])
  }
  let sum = 0
  let previousLevel = 0
  const emitted = []
  for (const [location, delta] of events) {
    sum += delta
    if (sum === previousLevel) continue
    // The reference base and transition slots are both 32, so their offset is 0.
    const index = sum + 4
    if (index < 0 || index > 15 || emitted.length >= 7) return null
    emitted.push([location, index])
    previousLevel = sum
  }
  emitted.reverse()
  while (emitted.length > 0 && emitted.at(-1)[1] === 4) emitted.pop()
  seed.peakHistory = peakHistory
  seed.entries = emitted.length
  for (let index = 0; index < emitted.length; index++) {
    seed.locations[index] = emitted[index][0]
    seed.levels[index] = emitted[index][1]
  }
  return seed
}

/**
 * Plan one band's coded gain record without publishing persistent state.
 *
 * @param {Float32Array} spectrum Complete 768-float rolling band slot.
 * @param {GainRecord} previousRecord Prior committed gain record.
 * @param {GainRecord} outputSeed Detached destination seed.
 * @param {GainAnalysisScratch} gainAnalysisScratch
 * @returns {GainRecord|null} Planned record, or `null` when unrepresentable.
 */
export function planBandGainRecord(
  spectrum,
  previousRecord,
  outputSeed,
  gainAnalysisScratch
) {
  if (spectrum.length < 768) {
    throw new RangeError('ATRAC3 band gain analysis requires 768 samples')
  }
  const detection = detectGainCandidates(
    spectrum,
    512,
    previousRecord,
    gainAnalysisScratch
  )
  if (!detection) return null
  if (previousRecord.entries === 0 && detection.detectedCount === 0) {
    outputSeed.entries = 0
    outputSeed.peakHistory = detection.peakHistory
    return outputSeed
  }
  return buildGainRecord(
    outputSeed,
    detection.peakHistory,
    gainLevelEnvelope(
      lowerGainCandidates(detection, previousRecord),
      gainAnalysisScratch.levels
    )
  )
}

/**
 * Measure the strongest prefix excursion around the minimum coded level.
 *
 * @param {GainRecord} record
 * @param {number} minimumSeed
 * @param {number} maximumSeed
 * @returns {number}
 */
function prefixPeakToMinimumLevelDelta(record, minimumSeed, maximumSeed) {
  if (record.entries === 0) return 0
  let minimum = minimumSeed
  let minimumIndex = 0
  for (let index = 0; index < record.entries; index++) {
    if (record.levels[index] < minimum) {
      minimum = record.levels[index]
      minimumIndex = index
    }
  }
  let maximum = maximumSeed
  for (let index = 0; index <= minimumIndex; index++) {
    maximum = Math.max(maximum, record.levels[index])
  }
  return maximum - minimum
}

/**
 * Compare continuity candidates in reconstructed time-domain sample space.
 *
 * @param {Float32Array} candidate
 * @param {Float32Array} reference
 * @returns {object}
 */
function compareSignals(candidate, reference) {
  let candidateEnergy = 0
  let differenceEnergy = 0
  for (let index = 0; index < candidate.length; index++) {
    const candidateValue = candidate[index]
    const referenceValue = reference[index]
    const difference = candidateValue - referenceValue
    candidateEnergy += candidateValue * candidateValue
    differenceEnergy += difference * difference
  }
  return { candidateEnergy, differenceEnergy }
}

/**
 * Select the optional band-1-to-band-0 continuity insertion.
 *
 * @param {Float32Array} targetSpectrum First band's rolling sample slot.
 * @param {GainRecord[]} previousRecords Prior committed channel records.
 * @param {GainRecord[]} plannedRecords Candidate current records.
 * @returns {{location: number, level: number}|null} Detached edit, if viable.
 */
export function planGainContinuityEdit(
  targetSpectrum,
  previousRecords,
  plannedRecords
) {
  const sourceStrength = prefixPeakToMinimumLevelDelta(plannedRecords[1], 4, 0)
  if (sourceStrength <= 1) return null
  const sourceLocation = plannedRecords[1].locations[0]
  if (
    previousRecords[0].entries !== 0 ||
    plannedRecords[0].entries !== 0 ||
    previousRecords[0].peakHistory > 16384
  ) {
    return null
  }
  const scanStart = 256
  const scanEnd = scanStart + (sourceLocation + 1) * 8
  for (let index = scanStart; index < scanEnd; index++) {
    if (Math.abs(targetSpectrum[index]) > 16384) return null
  }
  return { location: sourceLocation, level: 5 }
}

/**
 * Evaluate and apply the optional continuity edit in reconstructed sample space.
 *
 * @param {Float32Array} targetSpectrum First band's rolling sample slot.
 * @param {GainRecord[]} previousRecords Prior committed records.
 * @param {GainRecord[]} plannedRecords Detached current records.
 * @param {GainScaleScratch} gainScaleScratch Reusable gain reconstruction scratch.
 * @returns {GainRecord[]|null} Selected detached records, or `null` on failure.
 */
export function adjustGainContinuity(
  targetSpectrum,
  previousRecords,
  plannedRecords,
  gainScaleScratch
) {
  const edit = planGainContinuityEdit(
    targetSpectrum,
    previousRecords,
    plannedRecords
  )
  if (!edit) return plannedRecords

  const incumbent = plannedRecords[0]
  const candidate = incumbent.copyTo(gainScaleScratch.candidateRecord)
  candidate.entries = 1
  candidate.locations[0] = edit.location
  candidate.levels[0] = edit.level
  const input = targetSpectrum.subarray(256, 512)
  const overlap = targetSpectrum.subarray(512, 768)
  if (
    !reconstructGainPairSignal(
      input,
      overlap,
      previousRecords[0],
      incumbent,
      gainScaleScratch.incumbent,
      gainScaleScratch
    ) ||
    !reconstructGainPairSignal(
      input,
      overlap,
      previousRecords[0],
      candidate,
      gainScaleScratch.candidate,
      gainScaleScratch
    )
  ) {
    return null
  }
  const effect = compareSignals(
    gainScaleScratch.candidate,
    gainScaleScratch.incumbent
  )
  const reversedRelativeDifference =
    effect.candidateEnergy > 0
      ? effect.differenceEnergy / effect.candidateEnergy
      : 0
  const rollback =
    gainRecordBits(incumbent) <= gainRecordBits(candidate) &&
    reversedRelativeDifference <= 0.1
  if (!rollback) candidate.copyTo(incumbent)
  return plannedRecords
}

/**
 * Plan all four channel gain records atomically.
 *
 * @param {Float32Array} channelState Persistent rolling subband state.
 * @param {GainRecord[]} previousRecords Prior committed records.
 * @param {GainRecord[]} outputSeeds Detached destination records.
 * @param {GainScaleScratch} gainScaleScratch Reusable gain reconstruction scratch.
 * @param {GainAnalysisScratch} gainAnalysisScratch Reusable gain-analysis scratch.
 * @returns {GainRecord[]|null} Complete plan, or `null` if any band fails.
 */
export function planGainControl(
  channelState,
  previousRecords,
  outputSeeds,
  gainScaleScratch,
  gainAnalysisScratch
) {
  if (channelState.length < SUBBAND_COUNT * BAND_STRIDE_FLOATS) {
    throw new RangeError(
      'ATRAC3 gain control requires four complete band slots'
    )
  }
  for (let band = 0; band < SUBBAND_COUNT; band++) {
    const offset = bandGainOffset(band)
    const planned = planBandGainRecord(
      channelState.subarray(offset, offset + BAND_STRIDE_FLOATS),
      previousRecords[band],
      outputSeeds[band],
      gainAnalysisScratch
    )
    if (!planned) return null
  }
  return adjustGainContinuity(
    channelState.subarray(
      bandGainOffset(0),
      bandGainOffset(0) + 3 * BAND_PART_FLOATS
    ),
    previousRecords,
    outputSeeds,
    gainScaleScratch
  )
}
