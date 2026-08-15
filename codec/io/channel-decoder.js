/** Carta3 Audio Codec - Transactional channel syntax decoding. */

import { readHuffmanRun } from '../coding/entropy.js'
import { FRAME_SAMPLES } from '../core/constants.js'
import {
  QUANTIZATION_UNIT_OFFSETS,
  SPECTRAL_SCALE_FACTORS,
} from '../core/tables.js'
import { BitReader } from './bitstream.js'
import {
  SpectrumAllocation,
  ToneItemHeader,
  ToneListCount,
  ToneRegionHeader,
  ToneSectionHeader,
} from './syntax.js'
import { float32Add, float32Multiply } from '../utils.js'

export { GainPairTable } from '../state/decoder.js'

/** Decode pair-block gain tables for all active transform units. */
function decodePairTables(reader, unitMode, decoded) {
  let coefficientExtent = 0
  for (let unit = 0; unit <= unitMode; unit++) {
    const table = decoded.pairTables[unit]
    table.reset()
    const pairCount = reader.read(3)
    if (pairCount !== 0) coefficientExtent = (unit + 1) * 256
    for (let pair = 0; pair < pairCount; pair++) {
      const gain = reader.read(4)
      const start = reader.read(5) << 3
      if (pair !== 0 && start <= table.starts[pair - 1]) {
        throw new RangeError('ATRAC3 gain-pair locations are not ordered')
      }
      table.starts[pair] = start
      table.gains[pair] = gain
    }
    table.starts[pairCount] = 0xff
    table.gains[pairCount] = 4
  }
  for (let unit = unitMode + 1; unit < 4; unit++) {
    const table = decoded.pairTables[unit]
    table.reset()
  }
  return coefficientExtent
}

/** Decode one bounded Huffman run and retain its reconstruction scale. */
function decodeRun(reader, tableSelector, codeIndex, scale, start, count) {
  return {
    outputStart: start,
    values: readHuffmanRun(reader, tableSelector, codeIndex, count),
    scale,
  }
}

/** Decode tone regions and append their residual reconstruction runs. */
function decodeToneResiduals(reader, unitMode, decoded, coefficientExtent) {
  const header = ToneSectionHeader.read(reader)
  let remaining = header.regionCount
  if (remaining === 0) return coefficientExtent
  if (header.mode === 2) {
    throw new RangeError('Reserved ATRAC3 tone pass mode')
  }

  let maxSeen = coefficientExtent
  let segmentsSeen = 0
  tonePass: while (remaining !== 0) {
    let segmentBase = 0
    const region = ToneRegionHeader.read(unitMode + 1, reader)
    const baseLength = region.decoderBaseLength
    const codeIndex = region.codeIndex - 1
    if (codeIndex < 1) {
      throw new RangeError('Invalid ATRAC3 tone code index')
    }
    const tableSelector = header.mode < 2 ? header.mode : reader.read(1) & 1
    let shiftRegister = region.decoderShiftRegister
    for (;;) {
      if ((segmentBase & 0xff) === 0) {
        shiftRegister = (shiftRegister << 1) & 0xff
        if ((shiftRegister & 0x80) === 0) {
          if (shiftRegister !== 0) {
            segmentBase += 0x100
            continue
          }
          remaining--
          coefficientExtent = maxSeen
          break
        }
      }

      const repeat = ToneListCount.read(reader).count - 1
      if (repeat >= 0) {
        for (let itemIndex = 0; itemIndex <= repeat; itemIndex++) {
          const item = ToneItemHeader.read(reader)
          const outputStart = segmentBase + item.start
          const outputEnd = Math.min(
            (baseLength >> ((3 - unitMode) & 0x1f)) + 1 + outputStart,
            FRAME_SAMPLES
          )
          maxSeen = Math.max(maxSeen, outputEnd)
          segmentsSeen++
          if (segmentsSeen === 0x41) {
            coefficientExtent = 0
            break tonePass
          }
          decoded.runs.push(
            decodeRun(
              reader,
              tableSelector,
              codeIndex,
              SPECTRAL_SCALE_FACTORS[item.scaleFactor],
              outputStart,
              outputEnd - outputStart
            )
          )
        }
      }
      segmentBase += 0x40
    }
  }
  return coefficientExtent
}

/** Decode primary spectrum allocation and append its Huffman runs. */
function decodeMainSpectrum(reader, decoded) {
  const allocation = SpectrumAllocation.read(reader)
  for (let group = 0; group < allocation.groupCount; group++) {
    const codeIndex = allocation.wordLengths[group] - 1
    if (codeIndex < 0) continue
    const start = QUANTIZATION_UNIT_OFFSETS[group]
    const end = QUANTIZATION_UNIT_OFFSETS[group + 1]
    decoded.runs.push(
      decodeRun(
        reader,
        allocation.tableSelector,
        codeIndex,
        SPECTRAL_SCALE_FACTORS[allocation.scaleFactors[group]],
        start,
        end - start
      )
    )
  }
  return QUANTIZATION_UNIT_OFFSETS[allocation.groupCount]
}

/**
 * Parse one channel without publishing reconstructed spectrum or history.
 * @param {Uint8Array} stream Padded encoded frame bytes.
 * @param {number} bitPosition Absolute channel start bit.
 * @param {number} unitMode Highest active transform-unit index.
 * @param {object} decoded Caller-owned parsed channel frame.
 * @returns {number} Absolute bit position after the channel syntax.
 */
export function unpackChannelSyntax(stream, bitPosition, unitMode, decoded) {
  const reader = new BitReader(stream, bitPosition)
  decoded.reset()
  let coefficientExtent = decodePairTables(reader, unitMode, decoded)
  coefficientExtent = decodeToneResiduals(
    reader,
    unitMode,
    decoded,
    coefficientExtent
  )
  coefficientExtent = Math.max(
    coefficientExtent,
    decodeMainSpectrum(reader, decoded)
  )
  decoded.coefficientBlocks = (coefficientExtent + 0xff) >> 8
  return reader.bitPosition
}

/**
 * Apply staged inverse quantization after every channel passes preflight.
 * @param {object} decoded Workspace returned by {@link unpackChannelSyntax}.
 * @returns {Float32Array} Reconstructed channel spectrum.
 */
export function reconstructChannelSpectrum(decoded) {
  decoded.samples.fill(0)
  for (const run of decoded.runs) {
    for (let index = 0; index < run.values.length; index++) {
      const output = run.outputStart + index
      decoded.samples[output] = float32Add(
        decoded.samples[output],
        float32Multiply(run.values[index], run.scale)
      )
    }
  }
  return decoded.samples
}
