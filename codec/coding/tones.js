/** Carta3 Audio Codec - Sound-unit tone analysis and coding. */

import { measureHuffmanBits } from './entropy.js'
import {
  scaleFactorIndexForAbs,
  spectralScaleForIndex,
  quantizeSpectralValue,
} from './quantization.js'
import {
  SPECTRAL_SCALE_FACTORS,
  TONE_SIDE_BITS_BY_MODE,
  WORD_LENGTH_QUANTIZER_LEVELS,
} from '../core/tables.js'
import {
  TONE_COMPONENT_SIDE_BITS,
  TONE_DESCRIPTOR,
  TONE_ENTRY_HEADER_BITS,
  TONE_GROUP_LIST_BITS,
  TONE_POLICY_NONE,
  TONE_POLICY_THRESHOLD,
  TONE_POOL_MAX_INDEX,
  TONE_TABLE_SET,
  TONE_WORD_LENGTH,
  FRAME_SAMPLES,
} from '../core/constants.js'
import { absoluteMaximum } from '../utils.js'

/**
 * Create one fixed-capacity tone-region syntax entry.
 * @returns {object} Empty region with group and list storage.
 */
export function createToneRegionEntry() {
  return {
    huffmanTableBaseIndex: TONE_WORD_LENGTH,
    descriptorIndex: TONE_DESCRIPTOR,
    huffmanTableSetIndex: TONE_TABLE_SET,
    groupFlags: new Int32Array(4),
    listCounts: new Int32Array(16),
    lists: Array.from({ length: 16 }, () => new Uint32Array(7)),
  }
}

/**
 * Create one fixed-capacity quantized tone component.
 * @returns {object} Empty tone syntax and coefficient storage.
 */
export function createToneSpec() {
  return {
    start: 0,
    scaleFactorIndex: 0,
    coefficients: new Int32Array(8),
    descriptorIndex: TONE_DESCRIPTOR,
    wordLength: TONE_WORD_LENGTH,
    tableIndex: TONE_TABLE_SET,
  }
}

/** Select the first tone scale factor strictly above a magnitude. */
function toneScaleFactorIndex(value) {
  const magnitude = value < 0 ? -value : value
  let index = 0
  while (index <= 62 && SPECTRAL_SCALE_FACTORS[index] <= magnitude) index++
  return index
}

/** Quantize and exactly Huffman-price one tone candidate. */
function quantizeTone(spectrum, scanIndex, tables) {
  const tone = createToneSpec()
  tone.start = scanIndex * 4
  const coefficientCount = TONE_DESCRIPTOR + 1
  const maximum = absoluteMaximum(
    spectrum,
    tone.start,
    tone.start + coefficientCount
  )
  tone.scaleFactorIndex = toneScaleFactorIndex(maximum)
  const scale = spectralScaleForIndex(tone.scaleFactorIndex)
  const steps = WORD_LENGTH_QUANTIZER_LEVELS[TONE_WORD_LENGTH]
  for (let offset = 0; offset < coefficientCount; offset++) {
    const index = tone.start + offset
    tone.coefficients[offset] =
      index >= FRAME_SAMPLES
        ? 0
        : quantizeSpectralValue(spectrum[index], scale, steps)
  }
  const table = tables[2 + TONE_TABLE_SET][TONE_WORD_LENGTH]
  return {
    tone,
    exactBits:
      measureHuffmanBits(table, tone.coefficients, coefficientCount) +
      TONE_COMPONENT_SIDE_BITS,
  }
}

/** Subtract one admitted quantized tone from the residual spectrum. */
function subtractTone(lowering, residual) {
  const tone = lowering.tone
  const steps = WORD_LENGTH_QUANTIZER_LEVELS[tone.wordLength]
  const factor = spectralScaleForIndex(tone.scaleFactorIndex) / (steps + 0.5)
  for (let offset = 0; offset < TONE_DESCRIPTOR + 1; offset++) {
    const index = tone.start + offset
    if (index < FRAME_SAMPLES) {
      residual[index] = Math.fround(
        residual[index] - factor * tone.coefficients[offset]
      )
    }
  }
}

/** Count structurally admissible tone candidates without mutation. */
function preflight(scaleFactors, count, threshold, existingToneCount) {
  const blockCounts = new Int32Array(16)
  let candidates = 0
  for (let scan = 0; scan < count; scan++) {
    const block = scan >> 4
    if (scaleFactors[scan] <= threshold + 32) continue
    if (blockCounts[block] > 6) continue
    if (candidates + existingToneCount > TONE_POOL_MAX_INDEX) continue
    blockCounts[block]++
    candidates++
  }
  return candidates
}

/**
 * Mutate one candidate residual and its group scale-factor profiles. Returns
 * the exact tone-section bits reserved beyond the common empty header.
 * @param {number} budget Remaining tone-section bit budget.
 * @param {number} scaleFactorCount Number of candidate four-line groups.
 * @param {number} entrySideBits Region-level syntax reservation.
 * @param {number} threshold Admission threshold relative to scale factors.
 * @param {string} policy Explicit tone acceptance policy.
 * @param {Int32Array} originalScaleFactors Original residual profile.
 * @param {Int32Array} transformedScaleFactors Candidate residual profile.
 * @param {Float32Array} residual Residual spectrum, lowered in place.
 * @param {object} block Sound-unit syntax candidate receiving tones.
 * @param {object[][]} tables Runtime Huffman families.
 * @returns {number} Exact admitted tone-section bits.
 */
export function extractMultitone(
  budget,
  scaleFactorCount,
  entrySideBits,
  threshold,
  policy,
  originalScaleFactors,
  transformedScaleFactors,
  residual,
  block,
  tables
) {
  if (policy === TONE_POLICY_NONE) return 0
  if (policy !== TONE_POLICY_THRESHOLD) {
    throw new RangeError('Unknown ATRAC3 tone acceptance policy')
  }
  const candidates = preflight(
    transformedScaleFactors,
    scaleFactorCount,
    threshold,
    block.toneCount
  )
  if (candidates <= 0) return 0
  let bits = entrySideBits + TONE_ENTRY_HEADER_BITS
  if (bits > budget || block.toneEntryIndex < 0 || block.toneEntryIndex >= 31) {
    return 0
  }
  const entrySlot = block.toneEntryIndex++
  const entry = createToneRegionEntry()

  for (let scan = 0; scan < scaleFactorCount; scan++) {
    const listBlock = scan >> 4
    const group = listBlock >> 2
    if (transformedScaleFactors[scan] <= threshold + 32) continue
    if (
      entry.listCounts[listBlock] > 6 ||
      block.toneCount > TONE_POOL_MAX_INDEX
    ) {
      continue
    }
    const activatesGroup = entry.groupFlags[group] !== 1
    const bitsAfterGroup = bits + (activatesGroup ? TONE_GROUP_LIST_BITS : 0)
    if (bitsAfterGroup > budget) continue
    if (activatesGroup) entry.groupFlags[group] = 1
    bits = bitsAfterGroup

    const tableIndex =
      entry.huffmanTableBaseIndex + entry.huffmanTableSetIndex * 8
    const componentReserve =
      TONE_SIDE_BITS_BY_MODE[tableIndex] * 4 + TONE_COMPONENT_SIDE_BITS
    if (bits + componentReserve > budget) continue

    const lowering = quantizeTone(residual, scan, tables)
    const toneIndex = block.toneCount++
    const listIndex = entry.listCounts[listBlock]++
    entry.lists[listBlock][listIndex] = toneIndex
    block.tonePool[toneIndex] = lowering.tone
    bits += lowering.exactBits
    subtractTone(lowering, residual)

    const coefficientStart = scan * 4
    const residualIndex = scaleFactorIndexForAbs(
      absoluteMaximum(residual, coefficientStart, coefficientStart + 4)
    )
    const originalIndex = originalScaleFactors[scan]
    transformedScaleFactors[scan] += residualIndex - originalIndex
    originalScaleFactors[scan] = residualIndex
  }
  block.toneEntries[entrySlot] = entry
  return bits
}
