/**
 * Carta3 Audio Codec - Exact 132 kbps sound-unit allocation.
 *
 * The allocator derives scale-factor evidence, tunes a quantization seed to the
 * syntax budget, performs perceptual fill/trim refinement, and only then
 * publishes quantized syntax into a detached channel block.
 */

import {
  ALLOCATION_BAND_COUNT,
  FRAME_SAMPLES,
  INITIAL_132_COMPONENT_GROUPS,
  INITIAL_132_SPECTRUM_GROUPS,
  SOUND_UNIT_FILL_LOWER_TIME_FACTOR,
  SOUND_UNIT_FILL_MOVES_PER_BAND,
  SOUND_UNIT_FILL_RAISE_WORD_LENGTH,
  TONE_POLICY_NONE,
  TONE_POLICY_THRESHOLD,
  TUNE_INITIAL_STEP,
  TUNE_MAX_EXCLUSIVE,
  TUNE_MIN_EXCLUSIVE,
  TUNE_REFINEMENT_STEPS,
  TUNE_SCALE,
  WORD_LENGTH_LIMIT,
} from '../core/constants.js'
import { SoundUnitAllocationScratch } from '../state/encoder.js'
import {
  QUANTIZATION_UNIT_OFFSETS,
  WORD_LENGTH_QUANTIZER_LEVELS,
} from '../core/tables.js'
import { huffmanFamilies } from './entropy.js'
import {
  quantZeroThreshold,
  scaleFactorIndexForAbs,
  spectralScaleForIndex,
  measureNontoneBits,
  quantizeNontoneSymbols,
} from './quantization.js'
import {
  countSoundUnitBits,
  countSoundUnitFixedBits,
} from '../io/sound-unit.js'
import { extractMultitone } from './tones.js'
import {
  buildReconstructionMask,
  measureBandReconstructionNoise,
  measureBandOptionReconstructionNoise,
} from '../analysis/perceptual.js'
import { absoluteMaximum, float32Add, float32Multiply } from '../utils.js'

/** Expected rejection of one speculative sound-unit candidate. */
export class SoundUnitCandidateError extends RangeError {}

const maximumWordLengthThresholds = new Float32Array(
  ALLOCATION_BAND_COUNT
).fill(WORD_LENGTH_LIMIT)

/** Measure four-line scale-factor evidence across the active spectrum prefix. */
function scaleFactorProfile(spectrum, bandCount, values) {
  const coefficientCount = QUANTIZATION_UNIT_OFFSETS[bandCount]
  const groupCount = coefficientCount >> 2
  let sum = 0
  for (let group = 0; group < groupCount; group++) {
    const index = scaleFactorIndexForAbs(
      absoluteMaximum(spectrum, group * 4, group * 4 + 4)
    )
    values[group] = index
    sum += index
  }
  return { values, sum, groupCount }
}

/** Reduce four-line profile values to one maximum per quantization band. */
function bandScaleFactors(profile, bandCount, output) {
  for (let band = 0; band < bandCount; band++) {
    const first = QUANTIZATION_UNIT_OFFSETS[band] >> 2
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1] >> 2
    let maximum = profile.values[first]
    for (let group = first + 1; group < end; group++) {
      maximum = Math.max(maximum, profile.values[group])
    }
    output[band] = maximum
  }
  return output
}

/** Return whether one gain record encodes a strong level excursion. */
function isAttackRecord(record) {
  let minimum = 4
  let maximum = 4
  for (let index = 0; index < record.entries; index++) {
    minimum = Math.min(minimum, record.levels[index])
    maximum = Math.max(maximum, record.levels[index])
  }
  return maximum - minimum >= 3
}

/** Inspect current and prior component records for an active attack. */
function hasAttack(current, previous, componentCount) {
  for (let band = 0; band < componentCount; band++) {
    if (isAttackRecord(current[band])) return true
  }
  for (let band = 0; band < componentCount; band++) {
    if (isAttackRecord(previous[band])) return true
  }
  return false
}

/** Derive attack-aware perceptual word-length thresholds for each band. */
function buildThresholds(
  transformedScaleFactors,
  bandCount,
  averageScaleFactor,
  attack,
  thresholds
) {
  for (let band = 0; band < bandCount; band++) {
    const width =
      QUANTIZATION_UNIT_OFFSETS[band + 1] - QUANTIZATION_UNIT_OFFSETS[band]
    thresholds[band] = Math.fround(
      0.24 * (transformedScaleFactors[band] - averageScaleFactor) -
        0.3 * Math.log2(Math.max(1, width))
    )
  }
  if (!attack) {
    if (!(thresholds[0] > 6)) thresholds[0] = 6
    for (let band = 1; band <= 3 && band < bandCount; band++) {
      if (!(thresholds[band] > 3)) thresholds[band] = 3
    }
  } else {
    for (let band = 0; band <= 7 && band < bandCount; band++) {
      thresholds[band] = float32Add(thresholds[band], 0.7)
    }
    for (let band = 8; band <= 17 && band < bandCount; band++) {
      thresholds[band] = float32Add(thresholds[band], 0.5)
    }
    if (!(thresholds[0] > 6)) thresholds[0] = 6
  }
  return thresholds
}

/** Quantize thresholds and suppress bands below the reference gate. */
function translateWordLengths(source, references, bandCount, output) {
  for (let band = 0; band < bandCount; band++) {
    output[band] = Math.max(
      1,
      Math.min(WORD_LENGTH_LIMIT, Math.trunc(source[band] + 0.5))
    )
  }
  let maximumReference = 0
  for (let band = 1; band < bandCount; band++) {
    maximumReference = Math.max(maximumReference, references[band])
  }
  const threshold =
    maximumReference <= 29 ? Math.max(1, Math.trunc(maximumReference / 6)) : 6
  for (let band = 0; band < bandCount; band++) {
    if (references[band] < threshold) output[band] = 0
    for (let distance = 1; distance <= 8 && band - distance >= 0; distance++) {
      if (references[band] < references[band - distance] - 30) output[band] = 0
    }
  }
  return { output, threshold }
}

/** Normalize each active band by its selected spectral scale factor. */
function normalizeSpectrum(scaleFactors, bandCount, output) {
  for (let band = 0; band < bandCount; band++) {
    const scale = Math.fround(1 / spectralScaleForIndex(scaleFactors[band]))
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    for (let coefficient = start; coefficient < end; coefficient++) {
      output[coefficient] = float32Multiply(output[coefficient], scale)
    }
  }
}

/** Quantize and exactly Huffman-price every active band in a candidate state. */
function priceState(state, spectrum, bandCount, tables) {
  state.sumBits = 0
  for (let band = 0; band < bandCount; band++) {
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    const wordLength = state.wordLengths[band]
    const symbols = state.quantizedSpectrum.subarray(start, end)
    const count = quantizeNontoneSymbols(
      wordLength,
      quantZeroThreshold(state.timeFactors[band], wordLength),
      spectrum.subarray(start, end),
      symbols
    )
    const bits =
      count === 0 ? 0 : measureNontoneBits(0, wordLength, symbols, tables)
    state.bitsByBand[band] = bits
    state.sumBits += bits
  }
  return state.sumBits
}

/**
 * Quantize and exactly price one detached band option.
 * @param {number} wordLength Candidate spectral word length.
 * @param {number} timeFactor Candidate dead-zone time factor.
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {number} band Quantization-band index.
 * @param {object[][]} tables Canonical Huffman table families.
 * @param {Int32Array} output Detached symbol destination for the band.
 * @returns {number} Exact Huffman syntax cost for the candidate band.
 */
function priceBandOption(
  wordLength,
  timeFactor,
  spectrum,
  band,
  tables,
  output
) {
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  const symbols = output.subarray(0, end - start)
  const count = quantizeNontoneSymbols(
    wordLength,
    quantZeroThreshold(timeFactor, wordLength),
    spectrum.subarray(start, end),
    symbols
  )
  return count === 0 ? 0 : measureNontoneBits(0, wordLength, symbols, tables)
}

/**
 * Commit one selected band option without repricing unaffected bands.
 * @param {object} state Mutable sound-unit allocation state.
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {number} band Quantization-band index.
 * @param {number} wordLength Selected spectral word length.
 * @param {number} timeFactor Selected dead-zone time factor.
 * @param {object[][]} tables Canonical Huffman table families.
 * @param {Int32Array} scratch Detached symbol storage for the selected band.
 * @returns {number} Exact change in the allocation's residual bit cost.
 */
function commitBandOption(
  state,
  spectrum,
  band,
  wordLength,
  timeFactor,
  tables,
  scratch
) {
  const previousBits = state.bitsByBand[band]
  const bits = priceBandOption(
    wordLength,
    timeFactor,
    spectrum,
    band,
    tables,
    scratch
  )
  const start = QUANTIZATION_UNIT_OFFSETS[band]
  const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
  state.wordLengths[band] = wordLength
  state.timeFactors[band] = timeFactor
  state.bitsByBand[band] = bits
  state.quantizedSpectrum
    .subarray(start, end)
    .set(scratch.subarray(0, end - start))
  state.sumBits += bits - previousBits
  return bits - previousBits
}

/** Weight a global tuning offset by the band's perceptual position. */
function tuneWeight(tune, band) {
  return tune > 0 ? 1 : Math.min(1, 0.2 + band * (0.8 / 18))
}

/** Rebuild and exactly price a candidate at one global tuning offset. */
function retunedState(
  seed,
  state,
  thresholds,
  gate,
  tune,
  runningBitSum,
  spectrum,
  bandCount,
  tables,
  candidateSymbols
) {
  seed.copyTo(state)
  for (let band = 0; band < bandCount; band++) {
    const adjusted = Math.fround(
      thresholds[band] + float32Multiply(tune, tuneWeight(tune, band))
    )
    let wordLength = Math.max(1, Math.min(7, Math.trunc(adjusted + 0.5)))
    if (gate[band] === 0) wordLength = 0
    if (band === 0 && runningBitSum < 10 && wordLength < 6) wordLength = 6
    if (seed.initialWordLengths[band] === 0) wordLength = 0
    if (wordLength !== seed.wordLengths[band]) {
      commitBandOption(
        state,
        spectrum,
        band,
        wordLength,
        seed.timeFactors[band],
        tables,
        candidateSymbols
      )
    }
  }
  return state
}

/** Bracket and refine the global threshold offset that fits the residual budget. */
function tuneToBudget(
  seed,
  thresholds,
  gate,
  budget,
  spectrum,
  bandCount,
  tables,
  scratch
) {
  let current = seed
  let best = seed.sumBits <= budget ? { probe: 0, state: seed } : null
  let low
  let high
  if (best) {
    let delta = TUNE_INITIAL_STEP
    for (;;) {
      const probe = delta
      if (probe >= TUNE_MAX_EXCLUSIVE) {
        low = best.probe
        high = TUNE_MAX_EXCLUSIVE
        break
      }
      current = retunedState(
        seed,
        scratch.tuningCandidate,
        thresholds,
        gate,
        probe / TUNE_SCALE,
        current.sumBits,
        spectrum,
        bandCount,
        tables,
        scratch.candidateSymbols
      )
      if (current.sumBits <= budget) {
        best = { probe, state: current.copyTo(scratch.bestTuningCandidate) }
        delta *= 2
      } else {
        low = best.probe
        high = probe
        break
      }
    }
  } else {
    let delta = TUNE_INITIAL_STEP
    let previousOver = 0
    for (;;) {
      const probe = -delta
      if (probe <= TUNE_MIN_EXCLUSIVE) {
        low = TUNE_MIN_EXCLUSIVE
        high = previousOver
        break
      }
      current = retunedState(
        seed,
        scratch.tuningCandidate,
        thresholds,
        gate,
        probe / TUNE_SCALE,
        current.sumBits,
        spectrum,
        bandCount,
        tables,
        scratch.candidateSymbols
      )
      if (current.sumBits <= budget) {
        best = { probe, state: current.copyTo(scratch.bestTuningCandidate) }
        low = probe
        high = previousOver
        break
      }
      previousOver = probe
      delta *= 2
    }
  }
  if (best) {
    for (let step = 0; step < TUNE_REFINEMENT_STEPS; step++) {
      const mid = low + Math.trunc((high - low) / 2)
      if (mid === low || mid === high) break
      current = retunedState(
        seed,
        scratch.tuningCandidate,
        thresholds,
        gate,
        mid / TUNE_SCALE,
        current.sumBits,
        spectrum,
        bandCount,
        tables,
        scratch.candidateSymbols
      )
      if (current.sumBits <= budget) {
        low = mid
        best = {
          probe: mid,
          state: current.copyTo(scratch.bestTuningCandidate),
        }
      } else high = mid
    }
  }
  return best?.state ?? current
}

/** Enumerate active bands eligible for syntax-cost reduction. */
function trimTargets(transformedScaleFactors, bandCount) {
  return Array.from({ length: bandCount }, (_, band) => ({
    band,
    priority: transformedScaleFactors[band] - Math.trunc(band / 2),
  })).sort(
    (left, right) => left.priority - right.priority || right.band - left.band
  )
}

/** Measure one lower-rate neighboring candidate for a selected band. */
function trimCandidate(state, target, operation) {
  const { spectrum, tables, kind, candidateSymbols, mask } = operation
  const band = target.band
  if (state.wordLengths[band] <= 0) return null
  let wordLength = state.wordLengths[band]
  let timeFactor = state.timeFactors[band]
  let candidateBits
  if (kind === 'time') {
    for (
      timeFactor = state.timeFactors[band] + 1;
      timeFactor <= state.timeFactorLimit;
      timeFactor++
    ) {
      candidateBits = priceBandOption(
        wordLength,
        timeFactor,
        spectrum,
        band,
        tables,
        candidateSymbols
      )
      if (candidateBits < state.bitsByBand[band]) break
    }
    if (timeFactor > state.timeFactorLimit) return null
  } else {
    wordLength--
    candidateBits = priceBandOption(
      wordLength,
      timeFactor,
      spectrum,
      band,
      tables,
      candidateSymbols
    )
  }
  const saving = state.bitsByBand[band] - candidateBits
  if (saving <= 0) return null
  const incumbentNoise = measureBandReconstructionNoise(state, spectrum, band)
  const candidateNoise = measureBandOptionReconstructionNoise(
    wordLength,
    state.scaleFactorIndices[band],
    candidateSymbols,
    spectrum,
    band
  )
  return {
    kind,
    target,
    wordLength,
    timeFactor,
    saving,
    damagePerBit: (candidateNoise - incumbentNoise) / mask[band] / saving,
  }
}

/** Rank feasible trim moves by masked distortion per saved bit. */
function rankTrimCandidates(candidates) {
  return candidates.sort(
    (left, right) =>
      left.damagePerBit - right.damagePerBit ||
      left.target.priority - right.target.priority
  )
}

/** Publish one selected trim move into the current candidate state. */
function acceptTrimChoice(state, choice, operation) {
  const { spectrum, tables, candidateSymbols } = operation
  const band = choice.target.band
  commitBandOption(
    state,
    spectrum,
    band,
    choice.wordLength,
    choice.timeFactor,
    tables,
    candidateSymbols
  )
  return state
}

/** Select the least-saving candidate that crosses the remaining overage. */
function bestCrossingCandidate(candidates, start, overage) {
  let selected = null
  for (let position = start; position < candidates.length; position++) {
    const candidate = candidates[position]
    if (candidate.saving < overage) continue
    if (
      !selected ||
      candidate.saving < selected.saving ||
      (candidate.saving === selected.saving &&
        candidate.target.priority < selected.target.priority)
    ) {
      selected = candidate
    }
  }
  return selected
}

/** Apply one ordered trim phase until its target budget is met or exhausted. */
function trimPhase(state, budget, operation) {
  const { targets, targetLimit, kind } = operation
  for (;;) {
    const candidates = rankTrimCandidates(
      targets
        .filter((target) => target.band < targetLimit)
        .map((target) => trimCandidate(state, target, operation))
        .filter(Boolean)
    )
    if (candidates.length === 0 || state.sumBits <= budget) return state
    if (kind === 'word') {
      const overage = state.sumBits - budget
      const crossing = bestCrossingCandidate(candidates, 0, overage)
      if (crossing) {
        return acceptTrimChoice(state, crossing, operation)
      }
      for (const candidate of candidates) {
        if (state.sumBits <= budget) return state
        acceptTrimChoice(state, candidate, operation)
      }
      continue
    }
    let progress = false
    for (let position = 0; position < candidates.length; position++) {
      if (state.sumBits <= budget) return state
      const overage = state.sumBits - budget
      const crossing = bestCrossingCandidate(candidates, position, overage)
      if (crossing) {
        acceptTrimChoice(state, crossing, operation)
        return state
      }
      const candidate = candidates[position]
      acceptTrimChoice(state, candidate, operation)
      progress = true
    }
    if (!progress) return state
  }
}

/** Run ordered trim phases until the complete candidate fits its budget. */
function trimToBudget(
  state,
  budget,
  spectrum,
  bandCount,
  componentCount,
  transformedScaleFactors,
  tables,
  candidateSymbols
) {
  if (state.sumBits <= budget) return state
  const targets = trimTargets(transformedScaleFactors, bandCount)
  const mask = buildReconstructionMask(
    spectrum,
    state.scaleFactorIndices,
    bandCount
  )
  const operation = {
    spectrum,
    tables,
    targets,
    kind: 'time',
    targetLimit: componentCount,
    mask,
    candidateSymbols,
  }
  state = trimPhase(state, budget, operation)
  if (state.sumBits > budget) {
    operation.kind = 'word'
    operation.targetLimit = bandCount
    state = trimPhase(state, budget, operation)
  }
  return state
}

/**
 * Measure and retain one band-local water-fill transition.
 * @param {object} state Current mutable sound-unit allocation.
 * @param {Int32Array} transformedScaleFactors Reference scale-factor profile.
 * @param {Float32Array} spectrum Normalized source spectrum.
 * @param {Float64Array} mask Reconstruction masking threshold by band.
 * @param {number} band Quantization-band index.
 * @param {number} slot Candidate-frontier destination slot.
 * @param {number} wordLength Candidate spectral word length.
 * @param {number} timeFactor Candidate dead-zone time factor.
 * @param {number} incumbentNoise Current reconstructed noise for the band.
 * @param {object} operation Shared fill-search evidence and scratch.
 * @returns {void}
 */
function measureFillCandidate(
  state,
  band,
  slot,
  wordLength,
  timeFactor,
  incumbentNoise,
  operation
) {
  const { spectrum, tables, candidateSymbols, candidates, mask } = operation
  const candidateBits = priceBandOption(
    wordLength,
    timeFactor,
    spectrum,
    band,
    tables,
    candidateSymbols
  )
  const delta = candidateBits - state.bitsByBand[band]
  if (delta <= 0) return
  const candidateNoise = measureBandOptionReconstructionNoise(
    wordLength,
    state.scaleFactorIndices[band],
    candidateSymbols,
    spectrum,
    band
  )
  const distortionDelta = (candidateNoise - incumbentNoise) / mask[band]
  if (distortionDelta >= 0) return
  const priority = (operation.transformedScaleFactors[band] + 1) * 32 - band
  candidates.valid[slot] = 1
  candidates.wordLengths[slot] = wordLength
  candidates.timeFactors[slot] = timeFactor
  candidates.bitDeltas[slot] = delta
  candidates.benefitsPerBit[slot] = -distortionDelta / delta
  candidates.waterfillScores[slot] = priority / Math.sqrt(delta)
}

/**
 * Refresh the two transitions affected by one band's committed state.
 * @param {object} state Current mutable sound-unit allocation.
 * @param {number} band Quantization-band index.
 * @param {boolean} allowLowerTimeFactors Whether reverse trim moves are legal.
 * @param {object} operation Shared fill-search evidence and scratch.
 * @returns {void}
 */
function refreshFillBand(state, band, allowLowerTimeFactors, operation) {
  const { spectrum, candidates } = operation
  const firstSlot = band * SOUND_UNIT_FILL_MOVES_PER_BAND
  candidates.valid[firstSlot + SOUND_UNIT_FILL_RAISE_WORD_LENGTH] = 0
  candidates.valid[firstSlot + SOUND_UNIT_FILL_LOWER_TIME_FACTOR] = 0
  const wordLength = state.wordLengths[band]
  const timeFactor = state.timeFactors[band]
  if (wordLength <= 0) return
  const incumbentNoise = measureBandReconstructionNoise(state, spectrum, band)
  if (wordLength < WORD_LENGTH_LIMIT) {
    measureFillCandidate(
      state,
      band,
      firstSlot + SOUND_UNIT_FILL_RAISE_WORD_LENGTH,
      wordLength + 1,
      timeFactor,
      incumbentNoise,
      operation
    )
  }
  if (allowLowerTimeFactors && timeFactor > 0) {
    measureFillCandidate(
      state,
      band,
      firstSlot + SOUND_UNIT_FILL_LOWER_TIME_FACTOR,
      wordLength,
      timeFactor - 1,
      incumbentNoise,
      operation
    )
  }
}

/**
 * Spend remaining bits on the lowest masked-noise candidate improvements.
 * @param {object} state Current mutable sound-unit allocation.
 * @param {number} unitBits Complete sound-unit bit capacity.
 * @param {number} syntaxBits Bits already occupied by complete unit syntax.
 * @param {object} operation Shared fill-search evidence and scratch.
 * @returns {object} The incrementally improved `state` allocation.
 */
function spendSlack(state, unitBits, syntaxBits, operation) {
  const { spectrum, bandCount, candidates, tables, candidateSymbols } =
    operation
  const allowLowerTimeFactors = state.timeFactors
    .subarray(0, bandCount)
    .some((value) => value > 0)
  let used = syntaxBits
  operation.mask = buildReconstructionMask(
    spectrum,
    state.scaleFactorIndices,
    bandCount
  )
  candidates.valid.fill(0)
  for (let band = 0; band < bandCount; band++) {
    refreshFillBand(state, band, allowLowerTimeFactors, operation)
  }
  for (;;) {
    let selected = -1
    const candidateCount = bandCount * SOUND_UNIT_FILL_MOVES_PER_BAND
    for (let slot = 0; slot < candidateCount; slot++) {
      if (
        !candidates.valid[slot] ||
        used + candidates.bitDeltas[slot] > unitBits - 2
      ) {
        continue
      }
      if (
        selected < 0 ||
        candidates.benefitsPerBit[slot] > candidates.benefitsPerBit[selected] ||
        (candidates.benefitsPerBit[slot] ===
          candidates.benefitsPerBit[selected] &&
          candidates.waterfillScores[slot] >
            candidates.waterfillScores[selected])
      ) {
        selected = slot
      }
    }
    if (selected < 0) break
    const band = Math.trunc(selected / SOUND_UNIT_FILL_MOVES_PER_BAND)
    const delta = commitBandOption(
      state,
      spectrum,
      band,
      candidates.wordLengths[selected],
      candidates.timeFactors[selected],
      tables,
      candidateSymbols
    )
    used += delta
    refreshFillBand(state, band, allowLowerTimeFactors, operation)
  }
  return state
}

/** Return the shortest prefix containing every nonzero word length. */
function activeBandCount(state, reservedBandCount) {
  let count = reservedBandCount
  while (count > 1 && state.wordLengths[count - 1] === 0) count--
  return count
}

/** Recenter selected scale factors around reconstructed per-band energy. */
function refineScaleFactors(state, spectrum, bandCount) {
  for (let band = 0; band < bandCount; band++) {
    const wordLength = state.wordLengths[band]
    if (wordLength === 0) continue
    const seed = state.scaleFactorIndices[band]
    const steps = WORD_LENGTH_QUANTIZER_LEVELS[wordLength]
    const inverseStep = Math.fround(1 / (steps + 0.5))
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    let referenceEnergy = 0
    let quantizedEnergy = 0
    for (let coefficient = start; coefficient < end; coefficient++) {
      const source = spectrum[coefficient]
      referenceEnergy = float32Add(
        referenceEnergy,
        float32Multiply(source, source)
      )
      const quantized = float32Multiply(
        inverseStep,
        state.quantizedSpectrum[coefficient]
      )
      quantizedEnergy = float32Add(
        quantizedEnergy,
        float32Multiply(quantized, quantized)
      )
    }
    const seedScale = spectralScaleForIndex(seed)
    /** Reconstruct quantized band energy at one candidate scale factor. */
    const energyAt = (index) => {
      const scale = Math.fround(spectralScaleForIndex(index) / seedScale)
      return float32Multiply(float32Multiply(quantizedEnergy, scale), scale)
    }
    let selected = seed
    let energy = energyAt(selected)
    if (energy > float32Multiply(referenceEnergy, 1.25)) {
      while (selected > 0 && energy > referenceEnergy) {
        selected--
        energy = energyAt(selected)
      }
      if (float32Multiply(referenceEnergy, 0.8) > energy) selected++
    } else if (energy < float32Multiply(referenceEnergy, 0.8)) {
      const maximum = Math.min(63, seed + 3)
      while (selected < maximum && referenceEnergy > energy) {
        selected++
        energy = energyAt(selected)
      }
      if (energy > float32Multiply(referenceEnergy, 1.25)) selected--
      selected = Math.max(selected, seed)
    }
    state.scaleFactorIndices[band] = selected
  }
}

/** Copy one completed candidate into detached sound-unit syntax storage. */
function commitAllocation(block, state, componentCount, bandCount) {
  block.spectrumGroupCount = bandCount
  block.componentGroupCount = componentCount
  block.componentMode = 1
  block.spectrumTableIndex = 0
  block.wordLengths.fill(0)
  block.scaleFactorIndices.fill(0)
  block.quantizedSpectrum.fill(0)
  block.wordLengths.set(state.wordLengths.subarray(0, bandCount))
  block.scaleFactorIndices.set(state.scaleFactorIndices.subarray(0, bandCount))
  const coefficientCount = QUANTIZATION_UNIT_OFFSETS[bandCount]
  block.quantizedSpectrum.set(
    state.quantizedSpectrum.subarray(0, coefficientCount)
  )
}

/**
 * Allocate and quantize one independently packed 132 kbps channel without
 * tone extraction. This is the reference allocator's non-tone baseline; tone
 * candidate selection and perceptual fill/trim are layered on it next.
 *
 * @param {Float32Array} sourceSpectrum Gain-adjusted source spectrum.
 * @param {Float32Array} transformedSpectrum Zero-gain reference spectrum.
 * @param {object} block Detached destination sound-unit state.
 * @param {GainRecord[]} previousGainRecords Prior committed gain records.
 * @param {number} unitBits Exact sound-unit bit budget.
 * @param {SoundUnitAllocationScratch} [scratch] Reusable allocation scratch.
 * @param {object} [tables] Canonical Huffman table families.
 * @param {string} [tonePolicy] Tone candidate policy identifier.
 * @returns {number} Exact selected syntax bit count.
 */
export function allocateNontoneSoundUnit(
  sourceSpectrum,
  transformedSpectrum,
  block,
  previousGainRecords,
  unitBits,
  scratch = new SoundUnitAllocationScratch(),
  tables = huffmanFamilies(),
  tonePolicy = TONE_POLICY_NONE
) {
  if (
    sourceSpectrum.length < FRAME_SAMPLES ||
    transformedSpectrum.length < FRAME_SAMPLES
  ) {
    throw new RangeError('ATRAC3 allocation requires 1024 spectral values')
  }
  const bandCount = INITIAL_132_SPECTRUM_GROUPS
  const componentCount = INITIAL_132_COMPONENT_GROUPS
  const { normalizedSpectrum, candidateSymbols, fillCandidates } = scratch
  block.spectrumGroupCount = bandCount
  block.componentGroupCount = componentCount
  block.componentMode = 1
  block.spectrumTableIndex = 0
  block.toneEntryIndex = 0
  block.toneEntries = []
  block.tonePool = []
  block.toneCount = 0

  const originalProfile = scaleFactorProfile(
    sourceSpectrum,
    bandCount,
    scratch.originalScaleProfile
  )
  const transformedProfile = scaleFactorProfile(
    transformedSpectrum,
    bandCount,
    scratch.transformedScaleProfile
  )
  normalizedSpectrum.set(sourceSpectrum.subarray(0, FRAME_SAMPLES))
  const average =
    transformedProfile.groupCount > 0
      ? transformedProfile.sum / transformedProfile.groupCount
      : 0
  const toneBudget =
    unitBits - countSoundUnitFixedBits(block) - bandCount * 3 - 13
  const toneBits = extractMultitone(
    toneBudget,
    transformedProfile.groupCount,
    componentCount,
    Math.fround(average),
    tonePolicy,
    originalProfile.values,
    transformedProfile.values,
    normalizedSpectrum,
    block,
    tables
  )
  const originalScaleFactors = bandScaleFactors(
    originalProfile,
    bandCount,
    scratch.originalScaleFactors
  )
  const transformedScaleFactors = bandScaleFactors(
    transformedProfile,
    bandCount,
    scratch.transformedScaleFactors
  )
  const thresholds = buildThresholds(
    transformedScaleFactors,
    bandCount,
    average,
    hasAttack(block.gainRecords, previousGainRecords, componentCount),
    scratch.thresholds
  )
  normalizeSpectrum(originalScaleFactors, bandCount, normalizedSpectrum)

  const translated = translateWordLengths(
    thresholds,
    transformedScaleFactors,
    bandCount,
    scratch.translatedWordLengths
  )
  for (let band = 0; band < bandCount; band++) {
    if (originalScaleFactors[band] < translated.threshold)
      translated.output[band] = 0
  }
  let state = scratch.seedCandidate.reset(
    translated.output,
    originalScaleFactors
  )
  priceState(state, normalizedSpectrum, bandCount, tables)
  const gate = translateWordLengths(
    maximumWordLengthThresholds,
    transformedScaleFactors,
    bandCount,
    scratch.gateWordLengths
  ).output
  const residualBudget =
    toneBudget - toneBits + (block.toneEntryIndex === 0 ? 2 : 0)
  const coefficientCount = QUANTIZATION_UNIT_OFFSETS[bandCount]
  state.timeFactorLimit = Math.max(
    0,
    Math.min(
      12,
      Math.round((1.15 - residualBudget / (coefficientCount + 256)) * 44)
    )
  )
  state = tuneToBudget(
    state,
    thresholds,
    gate,
    residualBudget,
    normalizedSpectrum,
    bandCount,
    tables,
    scratch
  )
  state = trimToBudget(
    state,
    residualBudget,
    normalizedSpectrum,
    bandCount,
    componentCount,
    transformedScaleFactors,
    tables,
    candidateSymbols
  )
  let activeBands = activeBandCount(state, bandCount)
  commitAllocation(block, state, componentCount, activeBands)
  // The reference water-fill keeps the original reserved spectrum-prefix
  // cost while it spends slack.  The three bits for each now-inactive tail
  // band are refunded only after fill selection, when the final syntax count
  // is published.  Starting from the already-shortened wire cost here gives
  // sparse drain frames extra budget and can select different final moves.
  const reservedSyntaxBits =
    countSoundUnitBits(block, tables) + (bandCount - activeBands) * 3
  const fillOperation = {
    transformedScaleFactors,
    spectrum: normalizedSpectrum,
    bandCount: activeBands,
    tables,
    candidateSymbols,
    candidates: fillCandidates,
    mask: null,
  }
  state = spendSlack(state, unitBits, reservedSyntaxBits, fillOperation)
  refineScaleFactors(state, normalizedSpectrum, activeBands)
  commitAllocation(block, state, componentCount, activeBands)

  while (countSoundUnitBits(block, tables) > unitBits) {
    const band = block.wordLengths.findLastIndex(
      (value, index) => index < activeBands && value > 0
    )
    if (band < 0)
      throw new SoundUnitCandidateError(
        'ATRAC3 sound unit cannot fit its fixed syntax'
      )
    state.wordLengths[band] = 0
    priceState(state, normalizedSpectrum, bandCount, tables)
    activeBands = activeBandCount(state, bandCount)
    commitAllocation(block, state, componentCount, activeBands)
  }
  return countSoundUnitBits(block, tables)
}

/** Score a completed syntax candidate by masked reconstruction error. */
function reconstructionError(block, source, scratch) {
  const reconstructed = scratch.reconstructedSpectrum
  reconstructed.fill(0)
  for (let band = 0; band < block.spectrumGroupCount; band++) {
    const wordLength = block.wordLengths[band]
    if (wordLength === 0) continue
    const steps = WORD_LENGTH_QUANTIZER_LEVELS[wordLength]
    const factor = Math.fround(
      spectralScaleForIndex(block.scaleFactorIndices[band]) /
        float32Add(steps, 0.5)
    )
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    for (let coefficient = start; coefficient < end; coefficient++) {
      reconstructed[coefficient] = Math.fround(
        float32Multiply(block.quantizedSpectrum[coefficient], factor)
      )
    }
  }
  for (let toneIndex = 0; toneIndex < block.toneCount; toneIndex++) {
    const tone = block.tonePool[toneIndex]
    const steps = WORD_LENGTH_QUANTIZER_LEVELS[tone.wordLength]
    const factor = Math.fround(
      spectralScaleForIndex(tone.scaleFactorIndex) / float32Add(steps, 0.5)
    )
    const count = tone.descriptorIndex + 1
    for (let offset = 0; offset < count; offset++) {
      const coefficient = tone.start + offset
      if (coefficient < FRAME_SAMPLES) {
        reconstructed[coefficient] = float32Add(
          reconstructed[coefficient],
          float32Multiply(tone.coefficients[offset], factor)
        )
      }
    }
  }
  const mask = buildReconstructionMask(source, scratch.unityScaleIndices, 32)
  let score = 0
  for (let band = 0; band < 32; band++) {
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    let noise = 0
    for (let coefficient = start; coefficient < end; coefficient++) {
      const difference = source[coefficient] - reconstructed[coefficient]
      noise += difference * difference
    }
    score += noise / mask[band]
  }
  return score
}

/**
 * Lower both maintained tone policies and publish the lower-error candidate.
 * @param {Float32Array} sourceSpectrum Gain-adjusted source spectrum.
 * @param {Float32Array} transformedSpectrum Zero-gain reference spectrum.
 * @param {object} selectedBlock Detached destination sound-unit state.
 * @param {object} candidateBlock Reusable alternative candidate state.
 * @param {GainRecord[]} previousGainRecords Prior committed gain records.
 * @param {number} unitBits Exact sound-unit bit budget.
 * @param {SoundUnitAllocationScratch} scratch Reusable allocation scratch.
 * @param {object} [tables] Canonical Huffman table families.
 * @returns {number} Exact bit count of the published candidate.
 */
export function allocateSoundUnitCandidates(
  sourceSpectrum,
  transformedSpectrum,
  selectedBlock,
  candidateBlock,
  previousGainRecords,
  unitBits,
  scratch,
  tables = huffmanFamilies()
) {
  selectedBlock.copyTo(candidateBlock)
  let toneBits = 0
  let toneError = Number.POSITIVE_INFINITY
  try {
    toneBits = allocateNontoneSoundUnit(
      sourceSpectrum,
      transformedSpectrum,
      selectedBlock,
      previousGainRecords,
      unitBits,
      scratch,
      tables,
      TONE_POLICY_THRESHOLD
    )
    if (selectedBlock.toneCount === 0) return toneBits
    toneError = reconstructionError(selectedBlock, sourceSpectrum, scratch)
  } catch (error) {
    if (!(error instanceof SoundUnitCandidateError)) throw error
    // The no-tone policy below remains the mandatory fallback transaction.
  }
  const nontoneBits = allocateNontoneSoundUnit(
    sourceSpectrum,
    transformedSpectrum,
    candidateBlock,
    previousGainRecords,
    unitBits,
    scratch,
    tables,
    TONE_POLICY_NONE
  )
  const nontoneError = reconstructionError(
    candidateBlock,
    sourceSpectrum,
    scratch
  )
  if (
    nontoneError < toneError ||
    (nontoneError === toneError && nontoneBits < toneBits)
  ) {
    candidateBlock.copyTo(selectedBlock)
    return nontoneBits
  }
  return toneBits
}
