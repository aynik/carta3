/** Carta3 Audio Codec - Sound-unit Huffman coding. */

import {
  HUFFMAN_PAIRS_A,
  HUFFMAN_PAIRS_B,
  HUFFMAN_VALUES_PER_CODEWORD,
  SPECTRAL_RECONSTRUCTION_VALUES,
  WORD_LENGTH_QUANTIZER_LEVELS,
  WORD_LENGTH_VALUE_BITS,
} from '../core/tables.js'
import { BitCounter, BitReader, BitWriter, packBits } from './bitstream.js'

/**
 * @typedef {object} HuffmanTable
 * @property {i32} valueBits Bits per unpacked symbol.
 * @property {i32} valuesPerCodeword Symbols grouped into one codeword.
 * @property {i32} valueMask Mask for an unpacked symbol.
 * @property {Uint16Array} codes Right-aligned Huffman codewords.
 * @property {Uint8Array} bitLengths Codeword lengths by symbol.
 * @property {i32} maxCodeLength Longest codeword in the table.
 * @property {Int16Array} decodeSymbols Symbols indexed by codeword and length.
 */

/**
 * Build one immutable Huffman family from compact code/length pairs.
 *
 * @param {ArrayLike<number>} pairs
 * @returns {object[]}
 */
function buildFamily(pairs) {
  const family = new Array(8).fill(null)
  let pairIndex = 0
  for (let wordLength = 1; wordLength <= 7; wordLength++) {
    const valueBits = WORD_LENGTH_VALUE_BITS[wordLength]
    const valuesPerCodeword = HUFFMAN_VALUES_PER_CODEWORD[wordLength]
    const entryCount = (2 ** valueBits) ** valuesPerCodeword
    const codes = new Uint16Array(entryCount)
    const bitLengths = new Uint8Array(entryCount)
    let maxCodeLength = 0
    for (let entry = 0; entry < entryCount; entry++) {
      codes[entry] = pairs[pairIndex * 2]
      bitLengths[entry] = pairs[pairIndex * 2 + 1]
      maxCodeLength = Math.max(maxCodeLength, bitLengths[entry])
      pairIndex++
    }
    const decodeSymbols = new Int16Array(2 ** (maxCodeLength + 1)).fill(-1)
    for (let entry = 0; entry < entryCount; entry++) {
      decodeSymbols[2 ** bitLengths[entry] + codes[entry]] = entry
    }
    family[wordLength] = {
      valueBits,
      valuesPerCodeword,
      valueMask: 2 ** valueBits - 1,
      codes,
      bitLengths,
      maxCodeLength,
      decodeSymbols,
    }
  }
  if (pairIndex * 2 !== pairs.length) {
    throw new Error('ATRAC3 Huffman row geometry is inconsistent')
  }
  return family
}

/**
 * Eagerly expanded Huffman families used by spectrum and tone syntax.
 * The tone slots alias the corresponding spectrum families.
 */
const primaryHuffmanFamily = buildFamily(HUFFMAN_PAIRS_A)
const secondaryHuffmanFamily = buildFamily(HUFFMAN_PAIRS_B)

/**
 * Validate a symbol run and return its one- or two-value grouping stride.
 *
 * @param {HuffmanTable} table
 * @param {Int32Array} values
 * @param {number} count
 * @returns {i32} Number of values per codeword.
 */
function symbolStride(table, values, count) {
  if (!table || count > values.length) {
    throw new RangeError('ATRAC3 Huffman symbol count is invalid')
  }
  const stride = table.valuesPerCodeword
  if (stride === 1) return stride
  if (stride === 2) {
    if ((count & 1) !== 0) {
      throw new RangeError('Paired ATRAC3 Huffman runs require an even count')
    }
    return stride
  }
  throw new RangeError('Unsupported ATRAC3 Huffman grouping')
}

/**
 * Pack one or two signed values into their Huffman table index.
 *
 * @param {Int32Array} values
 * @param {i32} index
 * @param {i32} mask
 * @param {i32} valueBits
 * @param {i32} stride
 * @returns {i32} Unsigned grouped symbol.
 * @nativeUnchecked The caller validates the run length and grouping stride.
 */
function groupedSymbol(values, index, mask, valueBits, stride) {
  const first = values[index] & mask
  return stride === 1
    ? first
    : (first << valueBits) | (values[index + 1] & mask)
}

/**
 * Decode one symbol by walking the canonical prefix table.
 *
 * @param {HuffmanTable} table
 * @param {object} reader
 * @returns {number}
 */
function readHuffmanSymbol(table, reader) {
  const decodeSymbols = table.decodeSymbols
  const maxCodeLength = table.maxCodeLength
  if (reader.read === BitReader.prototype.read) {
    /** @type {Uint8Array} */
    const buffer = reader.buffer
    /** @type {i32} */
    let position = reader.bitPosition
    let code = 0
    for (let width = 1; width <= maxCodeLength; width++) {
      code =
        (code << 1) | ((buffer[position >> 3] >>> (7 - (position & 7))) & 1)
      position++
      const symbol = decodeSymbols[2 ** width + code]
      if (symbol >= 0) {
        reader.bitPosition = position
        return symbol
      }
    }
    reader.bitPosition = position
    throw new RangeError('Invalid ATRAC3 Huffman codeword')
  }
  let code = 0
  for (let width = 1; width <= maxCodeLength; width++) {
    code = code * 2 + reader.read(1)
    const symbol = decodeSymbols[2 ** width + code]
    if (symbol >= 0) return symbol
  }
  throw new RangeError('Invalid ATRAC3 Huffman codeword')
}

/**
 * Map a codebook symbol to its signed spectral reconstruction rank.
 *
 * @param {number} symbol
 * @param {number} wordLength
 * @returns {number}
 */
function reconstructionRank(symbol, wordLength) {
  // Three ATRAC3 decoder codebooks place their zero reconstruction entry at
  // a non-zero encoder symbol.  The prefix tables exchange those two ranks;
  // preserve that format-defined permutation before compacting the signed
  // encoder symbol space.
  const zeroSymbol =
    wordLength === 3 ? 3 : wordLength === 4 ? 4 : wordLength === 7 ? 5 : 0
  if (zeroSymbol !== 0) {
    if (symbol === 0) return zeroSymbol
    if (symbol === zeroSymbol) return 0
  }
  const stepCount = WORD_LENGTH_QUANTIZER_LEVELS[wordLength]
  const mask = 2 ** WORD_LENGTH_VALUE_BITS[wordLength] - 1
  if (symbol <= stepCount) return symbol
  const negativeStart = mask - stepCount + 1
  if (symbol >= negativeStart) return symbol - (mask - stepCount * 2)
  throw new RangeError('Invalid ATRAC3 spectral symbol')
}

export const HUFFMAN_FAMILIES = Object.freeze([
  primaryHuffmanFamily,
  secondaryHuffmanFamily,
  primaryHuffmanFamily,
  secondaryHuffmanFamily,
])

/**
 * Measure the exact Huffman cost of a symbol run.
 *
 * @param {HuffmanTable} table One word-length table from {@link HUFFMAN_FAMILIES}.
 * @param {Int32Array} values Signed symbols in encoder representation.
 * @param {number} [count] Number of values to traverse.
 * @param {i32} [start=0] First symbol in the source row.
 * @returns {i32} Required codeword bits.
 * @nativeUnchecked The symbol run and codebook indices are validated before access.
 */
export function measureHuffmanBits(
  table,
  values,
  count = values.length,
  start = 0
) {
  /** @type {number} */
  const symbolCount = count
  const stride = symbolStride(table, values, symbolCount)
  if (start < 0 || start + symbolCount > values.length) {
    throw new RangeError('ATRAC3 Huffman symbol count is invalid')
  }
  /** @type {i32} */
  const end = start + symbolCount
  const bitLengths = table.bitLengths
  const symbolLimit = bitLengths.length
  const mask = table.valueMask
  const valueBits = table.valueBits
  let bits = 0
  for (let index = start; index < end; index += stride) {
    const symbol = groupedSymbol(values, index, mask, valueBits, stride)
    if (symbol >= symbolLimit) {
      throw new RangeError('Missing ATRAC3 Huffman codeword')
    }
    bits += bitLengths[symbol]
  }
  return bits
}

/**
 * Write a Huffman symbol run using the table's grouping rule.
 *
 * @param {HuffmanTable} table One word-length Huffman table.
 * @param {Int32Array} values Signed symbols in encoder representation.
 * @param {object} sink Bit writer or counter.
 * @param {number} [count] Number of values to write.
 * @returns {number} Number of bits written.
 */
export function writeHuffman(table, values, sink, count = values.length) {
  if (sink instanceof BitCounter) {
    const bits = measureHuffmanBits(table, values, count)
    const position = sink.bitPosition
    sink.bitPosition = position + bits
    return bits
  }
  /** @type {number} */
  const symbolCount = count
  const stride = symbolStride(table, values, symbolCount)
  const codes = table.codes
  const bitLengths = table.bitLengths
  const mask = table.valueMask
  const valueBits = table.valueBits
  const start = sink.bitPosition
  const output = sink.write === BitWriter.prototype.write ? sink.buffer : null
  const bitLimit = output ? output.length * 8 : 0
  let position = start
  for (let index = 0; index < symbolCount; index += stride) {
    const symbol = groupedSymbol(values, index, mask, valueBits, stride)
    if (symbol >= codes.length) {
      if (output) sink.bitPosition = position
      throw new RangeError('Missing ATRAC3 Huffman codeword')
    }
    const width = bitLengths[symbol]
    if (output) {
      if (position < 0 || position + width > bitLimit) {
        sink.bitPosition = position
        throw new RangeError('Bit write exceeds destination buffer')
      }
      packBits(output, position, codes[symbol], width)
      position += width
    } else {
      sink.write(codes[symbol], width)
    }
  }
  if (output) sink.bitPosition = position
  return sink.bitPosition - start
}

/**
 * Decode one complete sound-unit Huffman run to reconstruction values.
 *
 * @param {object} reader Bit reader positioned at the first codeword.
 * @param {number} tableSelector A/B table selector; only its low bit is used.
 * @param {number} codeIndex Zero-based coded word-length index.
 * @param {number} sampleCount Number of spectral values to decode.
 * @returns {Float32Array} Unscaled reconstruction values.
 */
export function readHuffmanRun(reader, tableSelector, codeIndex, sampleCount) {
  const wordLength = codeIndex + 1
  const table = HUFFMAN_FAMILIES[tableSelector & 1]?.[wordLength]
  if (!table || !Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new RangeError('Invalid ATRAC3 Huffman run geometry')
  }
  const output = new Float32Array(sampleCount)
  if (codeIndex === 0) {
    if ((sampleCount & 1) !== 0) {
      throw new RangeError('Paired ATRAC3 Huffman run must be even')
    }
    const pairScales = new Float32Array([
      -3255, -3255, 0, -3255, 3255, 0, 0, 3255, 3255, -3255,
    ])
    const pairRanks = new Int8Array([
      5, 6, -1, 2, 4, 7, -1, 8, -1, -1, -1, -1, 1, 3, -1, 0,
    ])
    for (let index = 0; index < sampleCount; index += 2) {
      const symbol = readHuffmanSymbol(table, reader)
      const rank = pairRanks[symbol]
      if (rank < 0) {
        throw new RangeError('Invalid paired ATRAC3 spectral symbol')
      }
      output[index] = pairScales[rank]
      output[index + 1] = pairScales[rank + 1]
    }
    return output
  }

  const values = SPECTRAL_RECONSTRUCTION_VALUES[codeIndex]
  for (let index = 0; index < sampleCount; index++) {
    const symbol = readHuffmanSymbol(table, reader)
    const rank = reconstructionRank(symbol, wordLength)
    output[index] = values[rank]
  }
  return output
}
