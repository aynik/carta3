/** Carta3 Audio Codec - Sound-unit Huffman coding. */

import {
  HUFFMAN_PAIRS_A,
  HUFFMAN_PAIRS_B,
  HUFFMAN_VALUES_PER_CODEWORD,
  SPECTRAL_RECONSTRUCTION_VALUES,
  WORD_LENGTH_QUANTIZER_LEVELS,
  WORD_LENGTH_VALUE_BITS,
} from '../core/tables.js'

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
    family[wordLength] = {
      valueBits,
      valuesPerCodeword,
      valueMask: 2 ** valueBits - 1,
      codes,
      bitLengths,
      maxCodeLength,
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
export const HUFFMAN_FAMILIES = Object.freeze([
  primaryHuffmanFamily,
  secondaryHuffmanFamily,
  primaryHuffmanFamily,
  secondaryHuffmanFamily,
])

/**
 * Traverse symbols using the table's one- or two-value grouping rule.
 *
 * @param {object} table
 * @param {ArrayLike<number>} values
 * @param {number} count
 * @param {function(number): void} visitor
 */
function visitSymbols(table, values, count, visitor) {
  if (!table || count > values.length) {
    throw new RangeError('ATRAC3 Huffman symbol count is invalid')
  }
  const mask = table.valueMask
  if (table.valuesPerCodeword === 1) {
    for (let index = 0; index < count; index++) {
      visitor((values[index] >>> 0) & mask)
    }
    return
  }
  if (table.valuesPerCodeword === 2) {
    if ((count & 1) !== 0) {
      throw new RangeError('Paired ATRAC3 Huffman runs require an even count')
    }
    for (let index = 0; index < count; index += 2) {
      visitor(
        (((values[index] >>> 0) & mask) << table.valueBits) |
          ((values[index + 1] >>> 0) & mask)
      )
    }
    return
  }
  throw new RangeError('Unsupported ATRAC3 Huffman grouping')
}

/**
 * Measure the exact Huffman cost of a symbol run.
 *
 * @param {object} table One word-length table from {@link HUFFMAN_FAMILIES}.
 * @param {ArrayLike<number>} values Signed symbols in encoder representation.
 * @param {number} [count] Number of values to traverse.
 * @returns {number} Required codeword bits.
 */
export function measureHuffmanBits(table, values, count = values.length) {
  let bits = 0
  visitSymbols(table, values, count, (symbol) => {
    if (symbol >= table.bitLengths.length) {
      throw new RangeError('Missing ATRAC3 Huffman codeword')
    }
    bits += table.bitLengths[symbol]
  })
  return bits
}

/**
 * Write a Huffman symbol run using the table's grouping rule.
 *
 * @param {object} table One word-length Huffman table.
 * @param {ArrayLike<number>} values Signed symbols in encoder representation.
 * @param {{bitPosition: number, write: Function}} sink Bit writer or counter.
 * @param {number} [count] Number of values to write.
 * @returns {number} Number of bits written.
 */
export function writeHuffman(table, values, sink, count = values.length) {
  const start = sink.bitPosition
  visitSymbols(table, values, count, (symbol) => {
    if (symbol >= table.codes.length) {
      throw new RangeError('Missing ATRAC3 Huffman codeword')
    }
    sink.write(table.codes[symbol], table.bitLengths[symbol])
  })
  return sink.bitPosition - start
}

/**
 * Decode one symbol by walking the canonical prefix table.
 *
 * @param {object} table
 * @param {object} reader
 * @returns {number}
 */
function readHuffmanSymbol(table, reader) {
  let code = 0
  for (let width = 1; width <= table.maxCodeLength; width++) {
    code = code * 2 + reader.read(1)
    for (let symbol = 0; symbol < table.codes.length; symbol++) {
      if (table.bitLengths[symbol] === width && table.codes[symbol] === code) {
        return symbol
      }
    }
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

/**
 * Decode one complete sound-unit Huffman run to reconstruction values.
 *
 * @param {{read: Function}} reader Bit reader positioned at the first codeword.
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
