/** Carta3 Audio Codec - Low-rate gain-region analysis. */

import { detectGainLogFlux } from './gain.js'
import {
  BREAKPOINT_MAGNITUDE_FLOOR_BITS,
  BREAKPOINT_SNAP_RATIO_BITS,
  FLOAT32_EXPONENT_BIAS,
  FLOAT32_EXPONENT_MASK,
  FLOAT32_EXPONENT_SHIFT,
  GAIN_BUDGET_SCALE_BITS,
  GAIN_MAGNITUDE_SENTINEL_BITS,
  FRAME_SAMPLES,
  GAIN_LEVEL_MAX,
  GAIN_STEP_COUNT,
  LAYER_GAIN_SCRATCH_WORDS,
  LAYER_GAIN_GROUP_COUNT,
  LAYER_GAIN_GROUP_SAMPLES,
  LAYER_GAIN_NEUTRAL_LEVEL,
  LAYER_GAIN_RELEASE_BUDGET,
  LAYER_GAIN_SCRATCH_HISTORY_OFFSET,
  LAYER_WORDS,
  PAIR_BLOCK_BASE_WORD,
  PAIR_BLOCK_GAIN_COUNT_WORD,
  PAIR_BLOCK_GAIN_LEVEL_OFFSET,
  PAIR_BLOCK_GAIN_SLOTS,
  PAIR_BLOCK_LAST_GROUP_MAXIMUM_WORD,
  PAIR_BLOCK_MAGNITUDE_HISTORY_OFFSET,
  PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS,
  PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD,
  PAIR_BLOCK_WORDS,
  SEED_MAGNITUDE_LIMIT,
  SQUARE_ROOT_TWO_BITS,
  SUBBAND_COUNT,
  TONE_HISTORY_WORD,
} from '../core/constants.js'
import { float32FromBits, float32Multiply, float32ToBits } from '../utils.js'

/**
 * Reproduce the port's unordered-or-less floating comparison.
 *
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
function unorderedLess(left, right) {
  return Number.isNaN(left) || Number.isNaN(right) || left < right
}

/**
 * Reproduce the port's unordered-or-less-equal floating comparison.
 *
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
function unorderedLessEqual(left, right) {
  return Number.isNaN(left) || Number.isNaN(right) || left <= right
}

const breakpointMagnitudeFloor = float32FromBits(
  BREAKPOINT_MAGNITUDE_FLOOR_BITS
)
const squareRootTwo = float32FromBits(SQUARE_ROOT_TWO_BITS)
const gainBudgetScale = float32FromBits(GAIN_BUDGET_SCALE_BITS)
const breakpointSnapRatio = float32FromBits(BREAKPOINT_SNAP_RATIO_BITS)
const seedMagnitudeLimit = Math.fround(SEED_MAGNITUDE_LIMIT)
/**
 * Measure 32 four-line maxima for each of the four interleaved units.
 *
 * @param {Uint32Array} words
 * @param {Uint32Array} output
 */
function analyzeMaximumMagnitudes(words, output) {
  let source = 0
  for (let block = 0; block < PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS; block++) {
    const maximum = [
      Math.imul(words[source], 2) >>> 0,
      Math.imul(words[source + 1], 2) >>> 0,
      Math.imul(words[source + 2], 2) >>> 0,
      Math.imul(words[source + 3], 2) >>> 0,
    ]
    source += 4
    for (let group = 1; group < LAYER_GAIN_GROUP_COUNT; group++) {
      for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
        const value = Math.imul(words[source + lane], 2) >>> 0
        if (maximum[lane] < value) maximum[lane] = value
      }
      source += SUBBAND_COUNT
    }
    for (let lane = 0; lane < SUBBAND_COUNT; lane++) {
      output[block + lane * PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS] =
        maximum[lane] >>> 1
    }
  }
}

/**
 * Read one float32 magnitude from the biased gain scratch region.
 *
 * @param {Uint32Array} gainScratchBits
 * @param {number} index
 * @returns {number}
 */
function gainScratchValue(gainScratchBits, index) {
  return float32FromBits(
    gainScratchBits[LAYER_GAIN_SCRATCH_HISTORY_OFFSET + index]
  )
}

/**
 * Convert one positive magnitude ratio to a whole gain-step delta.
 *
 * @param {number} ratio
 * @returns {number}
 */
function gainStepsForRatio(ratio) {
  return (
    ((float32ToBits(float32Multiply(ratio, squareRootTwo)) >>>
      FLOAT32_EXPONENT_SHIFT) &
      FLOAT32_EXPONENT_MASK) -
    FLOAT32_EXPONENT_BIAS
  )
}

/**
 * Stage old and new magnitude histories and return the prior maximum bits.
 *
 * @param {Uint32Array} words
 * @param {Uint32Array} maximumMagnitudes
 * @param {Uint32Array} gainScratchBits
 * @param {number} unit
 * @param {number} pairBase
 * @returns {number}
 */
function stagePairMagnitudeHistory(
  words,
  maximumMagnitudes,
  gainScratchBits,
  unit,
  pairBase
) {
  const historyBase = pairBase + PAIR_BLOCK_MAGNITUDE_HISTORY_OFFSET
  let oldMaximumBits = GAIN_MAGNITUDE_SENTINEL_BITS
  const magnitudeSegment = unit * PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS
  for (let index = 0; index < PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS; index++) {
    const oldBits = words[historyBase + index]
    gainScratchBits[LAYER_GAIN_SCRATCH_HISTORY_OFFSET + index] = oldBits
    if (oldMaximumBits < oldBits) oldMaximumBits = oldBits
    const newBits = maximumMagnitudes[magnitudeSegment + index]
    gainScratchBits[
      LAYER_GAIN_SCRATCH_HISTORY_OFFSET +
        PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS +
        index
    ] = newBits
    words[historyBase + index] = newBits
  }
  return oldMaximumBits
}

/**
 * Select the history scan bound implied by layer and joint-stereo modes.
 *
 * @param {number} unit
 * @param {number} layerFlag
 * @param {Int32Array} hints
 * @param {Int32Array} modes
 * @returns {number}
 */
function pairModeSelector(unit, layerFlag, hints, modes) {
  if (layerFlag === 0) return unit
  const hint = hints[unit] >>> 0
  const mode = modes[unit] >>> 0
  return hint === mode ? (hint === 3 ? -1 : 0) : 5
}

/**
 * Measure current group maxima and publish the last group history.
 *
 * @param {Uint32Array} words
 * @param {Uint32Array} gainScratchBits
 * @param {number} pairBase
 * @returns {number}
 */
function measurePairGroupMaxima(words, gainScratchBits, pairBase) {
  gainScratchBits[0] = words[pairBase + PAIR_BLOCK_LAST_GROUP_MAXIMUM_WORD]
  let lastMaximum = 0
  for (let group = 0; group < LAYER_GAIN_GROUP_COUNT; group++) {
    let current = gainScratchValue(
      gainScratchBits,
      group * LAYER_GAIN_GROUP_SAMPLES
    )
    for (let offset = 1; offset < LAYER_GAIN_GROUP_SAMPLES; offset++) {
      const candidate = gainScratchValue(
        gainScratchBits,
        group * LAYER_GAIN_GROUP_SAMPLES + offset
      )
      if (unorderedLess(current, candidate)) current = candidate
    }
    gainScratchBits[group + 1] = float32ToBits(current)
    lastMaximum = current
  }
  words[pairBase + PAIR_BLOCK_LAST_GROUP_MAXIMUM_WORD] =
    float32ToBits(lastMaximum)
  return lastMaximum
}

/**
 * Select release points and return remaining budget plus the tail cursor.
 *
 * @param {Uint32Array} words
 * @param {Uint32Array} gainScratchBits
 * @param {number} locationsBase
 * @param {number} levelsBase
 * @param {number} lastMaximum
 * @param {number} modeSelector
 * @param {Int32Array} gainSelectionScratch
 */
function selectPairReleasePoints(
  words,
  gainScratchBits,
  locationsBase,
  levelsBase,
  lastMaximum,
  modeSelector,
  gainSelectionScratch
) {
  let remainingBudget = LAYER_GAIN_RELEASE_BUDGET
  let tailCursor = PAIR_BLOCK_GAIN_SLOTS
  let runningCeiling = lastMaximum
  const bound =
    modeSelector > 0
      ? (LAYER_GAIN_GROUP_COUNT - modeSelector) * LAYER_GAIN_GROUP_COUNT
      : GAIN_STEP_COUNT
  for (let index = PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS; index < bound; index++) {
    const magnitude = gainScratchValue(gainScratchBits, index)
    if (unorderedLess(runningCeiling, magnitude)) runningCeiling = magnitude
  }
  const sentinel = float32FromBits(GAIN_MAGNITUDE_SENTINEL_BITS)
  if (unorderedLess(runningCeiling, sentinel)) runningCeiling = sentinel
  let snapThreshold = runningCeiling * breakpointSnapRatio
  const releaseState = { smoothedRise: 0 }
  for (
    let group = LAYER_GAIN_GROUP_COUNT - 1;
    group >= 0 && remainingBudget > 0 && tailCursor !== 5;
    group--
  ) {
    const groupPeak = float32FromBits(gainScratchBits[group])
    if (unorderedLess(groupPeak, runningCeiling)) continue
    const fired = detectGainLogFlux(groupPeak, runningCeiling, releaseState)
    if (unorderedLessEqual(groupPeak, breakpointMagnitudeFloor) || !fired) {
      runningCeiling = groupPeak
      snapThreshold = runningCeiling * breakpointSnapRatio
      continue
    }
    let index = group * LAYER_GAIN_GROUP_SAMPLES
    if (
      group !== 0 &&
      unorderedLess(gainScratchValue(gainScratchBits, index), snapThreshold) &&
      unorderedLess(gainScratchValue(gainScratchBits, index - 1), snapThreshold)
    ) {
      index--
      if (
        unorderedLess(
          gainScratchValue(gainScratchBits, index - 1),
          snapThreshold
        )
      ) {
        index--
      }
    }
    tailCursor--
    words[locationsBase + tailCursor] = index >>> 0
    let gainSteps = gainStepsForRatio(groupPeak / runningCeiling)
    if (gainSteps > remainingBudget) gainSteps = remainingBudget
    words[levelsBase + tailCursor] = -gainSteps >>> 0
    remainingBudget -= gainSteps
    runningCeiling = groupPeak
    snapThreshold = runningCeiling * breakpointSnapRatio
  }
  gainSelectionScratch[0] = remainingBudget
  gainSelectionScratch[1] = tailCursor
}

/**
 * Select attack points, merge release points, and lower cumulative levels.
 *
 * @param {Uint32Array} words
 * @param {Uint32Array} gainScratchBits
 * @param {number} locationsBase
 * @param {number} levelsBase
 * @param {number} previousMaximumBits
 * @param {number} remainingBudget
 * @param {number} tailCursor
 * @returns {number}
 */
function selectPairAttackPoints(
  words,
  gainScratchBits,
  locationsBase,
  levelsBase,
  previousMaximumBits,
  remainingBudget,
  tailCursor
) {
  const previousMaximum = float32FromBits(previousMaximumBits)
  const scaledPrevious = Math.fround(
    previousMaximum * gainBudgetScale * squareRootTwo
  )
  let availableSteps =
    FLOAT32_EXPONENT_BIAS +
    LAYER_GAIN_NEUTRAL_LEVEL -
    ((float32ToBits(scaledPrevious) >>> FLOAT32_EXPONENT_SHIFT) &
      FLOAT32_EXPONENT_MASK)
  if (availableSteps > GAIN_LEVEL_MAX) availableSteps = GAIN_LEVEL_MAX
  let attackBudget = availableSteps - remainingBudget
  if (attackBudget <= 0) return 0

  let entryCount = 0
  let previous = previousMaximum
  if (unorderedLess(previous, gainScratchValue(gainScratchBits, 0))) {
    previous = gainScratchValue(gainScratchBits, 0)
  }
  const attackState = { smoothedRise: 0 }
  const limit = words[locationsBase + tailCursor] | 0
  for (let scan = 0; scan < limit; scan++) {
    const candidatePeak = gainScratchValue(gainScratchBits, scan + 1)
    if (unorderedLess(candidatePeak, previous)) continue
    const previousPeak = previous
    previous = candidatePeak
    const detected = detectGainLogFlux(candidatePeak, previousPeak, attackState)
    if (candidatePeak <= breakpointMagnitudeFloor || !detected) continue
    let gainSteps = gainStepsForRatio(candidatePeak / previousPeak)
    words[locationsBase + entryCount] = scan
    if (
      entryCount > 0 &&
      (words[locationsBase + entryCount - 1] | 0) === scan - 1
    ) {
      const previousSteps = words[levelsBase + entryCount - 1] | 0
      if (gainSteps >= previousSteps) {
        entryCount--
        attackBudget += previousSteps
        words[locationsBase + entryCount] = scan
        gainSteps += previousSteps
      }
    }
    if (gainSteps > attackBudget) gainSteps = attackBudget
    attackBudget -= gainSteps
    words[levelsBase + entryCount] = gainSteps >>> 0
    entryCount++
    if (entryCount === tailCursor || attackBudget <= 0) break
  }
  for (let source = tailCursor; source <= 6; source++) {
    words[locationsBase + entryCount] = words[locationsBase + source]
    words[levelsBase + entryCount] = words[levelsBase + source]
    entryCount++
  }
  let accumulator = LAYER_GAIN_NEUTRAL_LEVEL
  for (let entry = entryCount - 1; entry >= 0; entry--) {
    accumulator += words[levelsBase + entry] | 0
    words[levelsBase + entry] = accumulator >>> 0
  }
  return entryCount
}

/**
 * Optionally seed an inactive primary pair from its active paired unit.
 *
 * @param {Uint32Array} words
 * @param {Uint32Array} gainScratchBits
 * @param {number} locationsBase
 * @param {number} levelsBase
 * @param {number} selector
 * @param {number} unit
 * @param {number} layerFlag
 * @param {number} previousCount
 * @param {number} pairBase
 * @returns {number}
 */
function seedPairedGainPoint(
  words,
  gainScratchBits,
  locationsBase,
  levelsBase,
  selector,
  unit,
  layerFlag,
  previousCount,
  pairBase
) {
  if (selector !== 0 || unit !== 0 || layerFlag !== 0 || previousCount !== 0) {
    return selector
  }
  const pairedBase = PAIR_BLOCK_BASE_WORD + PAIR_BLOCK_WORDS
  const pairedLocations = pairedBase
  const pairedLevels = pairedBase + PAIR_BLOCK_GAIN_LEVEL_OFFSET
  const pairedCount = words[pairedBase + PAIR_BLOCK_GAIN_COUNT_WORD]
  if (pairedCount === 0) return selector
  const oldMaximum = float32FromBits(
    words[pairBase + PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD]
  )
  if (!unorderedLessEqual(oldMaximum, seedMagnitudeLimit)) return selector
  let minimum = LAYER_GAIN_NEUTRAL_LEVEL
  let maximum = LAYER_GAIN_NEUTRAL_LEVEL
  for (let entry = 0; entry < pairedCount; entry++) {
    const gain = words[pairedLevels + entry] | 0
    if (gain < minimum) minimum = gain
    if (gain > maximum) maximum = gain
  }
  if (maximum - minimum <= 1) return selector
  const checkCount = (words[pairedLocations] | 0) + 1
  for (let entry = 0; entry < checkCount; entry++) {
    if (gainScratchValue(gainScratchBits, entry + 1) > seedMagnitudeLimit) {
      return selector
    }
  }
  words[locationsBase] = words[pairedLocations]
  words[levelsBase] = LAYER_GAIN_NEUTRAL_LEVEL + 1
  return 1
}

/**
 * Select pair-block gain points and advance magnitude history without scaling.
 *
 * @param {Uint32Array} words
 * @param {Uint32Array} maximumMagnitudes
 * @param {Uint32Array} gainScratchBits
 * @param {Int32Array} gainSelectionScratch
 * @param {number} layerFlag
 * @param {Int32Array} hints
 * @param {Int32Array} modes
 */
function analyzePairBlocks(
  words,
  maximumMagnitudes,
  gainScratchBits,
  gainSelectionScratch,
  layerFlag,
  hints,
  modes
) {
  for (let unit = SUBBAND_COUNT - 1; unit >= 0; unit--) {
    const pairBase = PAIR_BLOCK_BASE_WORD + unit * PAIR_BLOCK_WORDS
    const locationsBase = pairBase
    const levelsBase = pairBase + PAIR_BLOCK_GAIN_LEVEL_OFFSET
    const previousCount = words[pairBase + PAIR_BLOCK_GAIN_COUNT_WORD]
    words[locationsBase + PAIR_BLOCK_GAIN_SLOTS] =
      PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS
    const previousMaximumBits =
      words[pairBase + PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD]
    const oldMaximumBits = stagePairMagnitudeHistory(
      words,
      maximumMagnitudes,
      gainScratchBits,
      unit,
      pairBase
    )
    const modeSelector = pairModeSelector(unit, layerFlag, hints, modes)
    const lastMaximum = measurePairGroupMaxima(words, gainScratchBits, pairBase)
    if (unit === 0) words[TONE_HISTORY_WORD] = previousCount
    selectPairReleasePoints(
      words,
      gainScratchBits,
      locationsBase,
      levelsBase,
      lastMaximum,
      modeSelector,
      gainSelectionScratch
    )
    const entryCount = selectPairAttackPoints(
      words,
      gainScratchBits,
      locationsBase,
      levelsBase,
      previousMaximumBits,
      gainSelectionScratch[0],
      gainSelectionScratch[1]
    )
    words[pairBase + PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD] = oldMaximumBits
    const selector = seedPairedGainPoint(
      words,
      gainScratchBits,
      locationsBase,
      levelsBase,
      entryCount,
      unit,
      layerFlag,
      previousCount,
      pairBase
    )
    words[pairBase + PAIR_BLOCK_GAIN_COUNT_WORD] = selector
    words[levelsBase + selector] = LAYER_GAIN_NEUTRAL_LEVEL
  }
}

/**
 * Analyze gain regions into a detached word image for one layer.
 *
 * This phase chooses and records gain regions but deliberately leaves the
 * transform matrix untouched. Call {@link prepareLayeredGain} before MDCT.
 *
 * @param {object} layer Transaction-local layer state.
 * @param {Int32Array} absoluteModeHints Joint-stereo gain hints.
 * @param {Int32Array} slotModes Joint-stereo slot modes.
 * @param {LayeredTransformState} transformState Cross-stage frame state.
 * @returns {LayeredTransformState} State containing the selected gain plan.
 */
export function analyzeLayeredGain(
  layer,
  absoluteModeHints,
  slotModes,
  transformState
) {
  if (
    !layer ||
    absoluteModeHints.length < 4 ||
    slotModes.length < 4 ||
    transformState.words?.length < LAYER_WORDS ||
    transformState.maximumMagnitudes?.length < FRAME_SAMPLES / 8 ||
    transformState.gainScratchBits?.length < LAYER_GAIN_SCRATCH_WORDS ||
    transformState.gainSelectionScratch?.length < 2 ||
    transformState.transformValues?.length < FRAME_SAMPLES ||
    transformState.initialGainScales?.length < SUBBAND_COUNT
  ) {
    throw new RangeError('ATRAC3 layered transform has invalid state geometry')
  }
  const words = layer.storeTo(transformState.words)
  analyzeMaximumMagnitudes(words, transformState.maximumMagnitudes)
  analyzePairBlocks(
    words,
    transformState.maximumMagnitudes,
    transformState.gainScratchBits,
    transformState.gainSelectionScratch,
    layer.stereoFlag,
    absoluteModeHints,
    slotModes
  )
  return transformState
}
