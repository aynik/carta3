/** Carta3 Audio Codec - Independent sound-unit costing and emission. */

import { packGainRecords } from '../coding/gain.js'
import { HUFFMAN_FAMILIES, writeHuffman } from '../coding/entropy.js'
import {
  QUANTIZATION_UNIT_OFFSETS,
  TONE_COEFFICIENT_COUNT_BY_DESCRIPTOR,
  TONE_GROUP_BY_ENTRY,
} from '../core/tables.js'
import { BitCounter, BitWriter } from './bitstream.js'
import {
  IndependentChannelHeader,
  SpectrumAllocation,
  ToneItemHeader,
  ToneListCount,
  ToneRegionHeader,
  ToneSectionHeader,
} from './syntax.js'

/**
 * Validate the one-to-four transform-unit syntax geometry.
 *
 * @param {number} unitCount
 */
function validateUnitCount(unitCount) {
  if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > 4) {
    throw new RangeError('ATRAC3 sound unit requires 1..4 transform units')
  }
}

/**
 * Write an independent sound-unit channel header.
 *
 * @param {object} syntax
 * @param {object} sink
 */
function writeHeader(syntax, sink) {
  validateUnitCount(syntax.componentGroupCount)
  IndependentChannelHeader.fromUnitCount(syntax.componentGroupCount).pack(sink)
}

/**
 * Write admitted tone components and return their total item count.
 *
 * @param {object} syntax
 * @param {object} sink
 * @returns {number}
 */
function writeToneComponents(syntax, sink) {
  const componentCount = syntax.toneEntryIndex
  if (
    !Number.isInteger(componentCount) ||
    componentCount < 0 ||
    componentCount > 31
  ) {
    throw new RangeError('ATRAC3 tone component count must be in 0..31')
  }
  new ToneSectionHeader(componentCount, syntax.componentMode).pack(sink)
  if (componentCount === 0) return 0
  if (syntax.componentMode === 3) {
    throw new RangeError('ATRAC3 tone component mode 3 is invalid')
  }
  if (!syntax.toneEntries || syntax.toneEntries.length < componentCount) {
    throw new RangeError('ATRAC3 tone component storage is incomplete')
  }

  let toneCount = 0
  for (let entryIndex = 0; entryIndex < componentCount; entryIndex++) {
    const entry = syntax.toneEntries[entryIndex]
    let channelMask = 0
    for (let unit = 0; unit < syntax.componentGroupCount; unit++) {
      channelMask = (channelMask << 1) | entry.groupFlags[unit]
    }
    new ToneRegionHeader(
      channelMask,
      entry.descriptorIndex,
      entry.huffmanTableBaseIndex,
      syntax.componentGroupCount
    ).pack(sink)

    const table =
      HUFFMAN_FAMILIES[2 + entry.huffmanTableSetIndex]?.[
        entry.huffmanTableBaseIndex
      ]
    if (!table) throw new RangeError('ATRAC3 tone Huffman table is invalid')
    let coefficientCount =
      TONE_COEFFICIENT_COUNT_BY_DESCRIPTOR[entry.descriptorIndex]
    if (!coefficientCount) {
      throw new RangeError('ATRAC3 tone descriptor is invalid')
    }

    for (let outer = 0; outer < syntax.componentGroupCount * 4; outer++) {
      const group = TONE_GROUP_BY_ENTRY[outer]
      if (entry.groupFlags[group] === 0) continue
      const listCount = entry.listCounts[outer]
      if (!Number.isInteger(listCount) || listCount < 0 || listCount > 7) {
        throw new RangeError('ATRAC3 tone list count must be in 0..7')
      }
      new ToneListCount(listCount).pack(sink)
      for (let listIndex = 0; listIndex < listCount; listIndex++) {
        toneCount++
        const toneIndex = entry.lists[outer][listIndex]
        const tone = syntax.tonePool?.[toneIndex]
        if (toneIndex > 63 || !tone) {
          throw new RangeError('ATRAC3 tone pool index is invalid')
        }
        new ToneItemHeader(tone.scaleFactorIndex, tone.start & 0x3f).pack(sink)
        if (coefficientCount + tone.start > 1024) {
          coefficientCount = 1024 - tone.start
        }
        writeHuffman(table, tone.coefficients, sink, coefficientCount)
      }
    }
  }
  return toneCount
}

/**
 * Write spectrum allocation metadata and quantized Huffman payload.
 *
 * @param {object} syntax
 * @param {object} sink
 */
function writeSpectrum(syntax, sink) {
  if (syntax.spectrumTableIndex !== 0 && syntax.spectrumTableIndex !== 1) {
    throw new RangeError('ATRAC3 spectrum table selector must be 0 or 1')
  }
  const allocation = new SpectrumAllocation(
    syntax.spectrumGroupCount,
    syntax.spectrumTableIndex,
    syntax.wordLengths,
    syntax.scaleFactorIndices
  )
  allocation.pack(sink)
  const family = HUFFMAN_FAMILIES[syntax.spectrumTableIndex]
  for (let band = 0; band < allocation.groupCount; band++) {
    const wordLength = allocation.wordLengths[band]
    if (wordLength === 0) continue
    const start = QUANTIZATION_UNIT_OFFSETS[band]
    const end = QUANTIZATION_UNIT_OFFSETS[band + 1]
    const values = syntax.quantizedSpectrum?.subarray(start, end)
    if (!values || values.length !== end - start) {
      throw new RangeError('ATRAC3 quantized spectrum storage is incomplete')
    }
    writeHuffman(family[wordLength], values, sink)
  }
}

/**
 * Traverse one complete sound unit through a writer or exact counter.
 *
 * @param {object} syntax
 * @param {object} sink
 */
function writeSoundUnit(syntax, sink) {
  if (syntax.scratchFlag === 1) {
    throw new RangeError('Scratch ATRAC3 candidates cannot be serialized')
  }
  writeHeader(syntax, sink)
  packGainRecords(syntax.gainRecords.slice(0, syntax.componentGroupCount), sink)
  writeToneComponents(syntax, sink)
  writeSpectrum(syntax, sink)
}

/**
 * Count header and raw gain bits, including scratch-candidate reservation.
 *
 * @param {object} syntax Sound-unit syntax candidate.
 * @returns {number} Fixed syntax cost in bits.
 */
export function countSoundUnitFixedBits(syntax) {
  const sink = new BitCounter()
  validateUnitCount(syntax.componentGroupCount)
  if (syntax.scratchFlag === 1) sink.write(0, 16)
  else writeHeader(syntax, sink)
  packGainRecords(syntax.gainRecords.slice(0, syntax.componentGroupCount), sink)
  return sink.bitPosition
}

/**
 * Count one complete sound unit without writing an output image.
 *
 * @param {object} syntax Completed sound-unit syntax.
 * @returns {number} Exact sound-unit length in bits.
 */
export function countSoundUnitBits(syntax) {
  const sink = new BitCounter()
  writeSoundUnit(syntax, sink)
  return sink.bitPosition
}

/**
 * Write one allocation-ledger-sized unit in a single transactional pass.
 * The caller keeps the destination detached until this verification succeeds.
 *
 * @param {object} syntax
 * @param {number} exactBits
 * @param {Uint8Array} output
 * @param {number} [outputOffset]
 * @returns {number}
 */
export function packSoundUnit(syntax, exactBits, output, outputOffset = 0) {
  if (!Number.isInteger(exactBits) || exactBits < 0) {
    throw new RangeError('ATRAC3 sound-unit bit ledger is invalid')
  }
  if (outputOffset < 0 || outputOffset * 8 + exactBits > output.length * 8) {
    throw new RangeError('ATRAC3 sound unit exceeds destination buffer')
  }
  const start = outputOffset * 8
  const sink = new BitWriter(output, start)
  writeSoundUnit(syntax, sink)
  const actualBits = sink.bitPosition - start
  if (actualBits !== exactBits) {
    throw new RangeError(
      `ATRAC3 sound-unit bit ledger expected ${exactBits}, wrote ${actualBits}`
    )
  }
  return actualBits
}
