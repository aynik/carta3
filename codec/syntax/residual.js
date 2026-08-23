/** Carta3 residual codebooks and wire emission. */

import { residualBandRange } from '../core/geometry.js'
import {
  RESIDUAL_CODE_PAIRS,
  RESIDUAL_SYMBOL_MASKS,
  RESIDUAL_VALUE_BITS,
} from '../core/tables.js'
import {
  quantizeResidualCoefficient,
  residualQuantGroupScale,
} from '../quantization/residual.js'
import { float32FromBits } from '../utils.js'

/**
 * Expand one compact residual mode into its encoder and decoder descriptor.
 *
 * @param {number} mode Residual coding mode from 1 through 7.
 * @returns {object} Immutable codebook descriptor.
 */
function buildCodebook(mode) {
  const pairs = RESIDUAL_CODE_PAIRS[mode - 1]
  const count = pairs.length / 2
  const codes = new Uint16Array(count)
  const bitLengths = new Uint8Array(count)
  const firstValues = new Float32Array(count)
  const secondValues = new Float32Array(count)
  for (let index = 0; index < count; index++) {
    codes[index] = pairs[index * 2]
    bitLengths[index] = pairs[index * 2 + 1]
  }
  if (mode === 1) {
    const firstBits = new Uint32Array([
      0, 0, 0, 0, 1059760811, 1059760811, 0, 1059760811, 0, 0, 0, 0, 3207244459,
      3207244459, 0, 3207244459,
    ])
    const secondBits = new Uint32Array([
      0, 1059760811, 0, 3207244459, 0, 1059760811, 0, 3207244459, 0, 0, 0, 0, 0,
      1059760811, 0, 3207244459,
    ])
    for (let index = 0; index < count; index++) {
      firstValues[index] = float32FromBits(firstBits[index])
      secondValues[index] = float32FromBits(secondBits[index])
    }
  } else {
    const values = RESIDUAL_VALUE_BITS[mode - 2]
    for (let index = 0; index < count; index++) {
      firstValues[index] = float32FromBits(values[index])
    }
  }
  return Object.freeze({
    paired: mode === 1,
    codes,
    bitLengths,
    firstValues,
    secondValues,
  })
}

let residualCodebooks

/**
 * Lazily build and cache all seven residual codebooks.
 *
 * @returns {object[]} Immutable residual descriptors.
 */
function codebooks() {
  residualCodebooks ??= Array.from({ length: 7 }, (_, index) =>
    buildCodebook(index + 1)
  )
  return residualCodebooks
}

/**
 * Resolve one cached low-rate residual codebook.
 *
 * @param {number} mode Coded residual mode from 1 through 7.
 * @returns {object|null} Codebook, or null for an invalid mode.
 */
export function residualCodebook(mode) {
  return Number.isInteger(mode) && mode >= 1 && mode <= 7
    ? codebooks()[mode - 1]
    : null
}

/**
 * Validate one residual mode and scale-factor syntax pair.
 *
 * @param {number} mode Residual coding mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 */
export function validateResidualSyntax(mode, scaleFactor) {
  if (!Number.isInteger(mode) || mode < 1 || mode > 7) {
    throw new RangeError('Invalid ATRAC3 residual quantization mode')
  }
  if (!Number.isInteger(scaleFactor) || scaleFactor < 0 || scaleFactor > 63) {
    throw new RangeError('Invalid ATRAC3 residual scale factor')
  }
}

/**
 * Quantize and write residual symbols over a validated coefficient range.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {object} range Coefficient range.
 * @param {number} mode Residual coding mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {object} sink Bit writer or counter.
 * @returns {number} Codeword bits written.
 */
function writeSymbols(source, range, mode, scaleFactor, sink) {
  const codebook = residualCodebook(mode)
  const quantizerScale = residualQuantGroupScale(mode, scaleFactor)
  const start = sink.bitPosition
  if (codebook.paired) {
    for (let line = range.start; line + 1 < range.end; line += 2) {
      const first = quantizeResidualCoefficient(source[line], quantizerScale, 3)
      const second = quantizeResidualCoefficient(
        source[line + 1],
        quantizerScale,
        3
      )
      const symbol = second + first * 4
      sink.write(codebook.codes[symbol], codebook.bitLengths[symbol])
    }
  } else {
    const symbolMask = RESIDUAL_SYMBOL_MASKS[mode - 2]
    for (let line = range.start; line < range.end; line++) {
      const symbol = quantizeResidualCoefficient(
        source[line],
        quantizerScale,
        symbolMask
      )
      sink.write(codebook.codes[symbol], codebook.bitLengths[symbol])
    }
  }
  return sink.bitPosition - start
}

/**
 * Write one residual band's retained symbols.
 *
 * @param {Int32Array} symbols Complete retained symbol source.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {object} sink Bit writer.
 * @returns {number} Codeword bits written.
 */
export function writeQuantizedResidualSymbols(
  symbols,
  band,
  mode,
  scaleFactor,
  sink
) {
  const range = residualBandRange(symbols, band)
  validateResidualSyntax(mode, scaleFactor)
  const codebook = residualCodebook(mode)
  const start = sink.bitPosition
  if (codebook.paired) {
    for (let line = range.start; line + 1 < range.end; line += 2) {
      const symbol = symbols[line + 1] + symbols[line] * 4
      sink.write(codebook.codes[symbol], codebook.bitLengths[symbol])
    }
  } else {
    for (let line = range.start; line < range.end; line++) {
      const symbol = symbols[line]
      sink.write(codebook.codes[symbol], codebook.bitLengths[symbol])
    }
  }
  return sink.bitPosition - start
}

/**
 * Emit only residual symbols; the allocation header owns the selector.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {object} sink Bit writer or counter.
 * @returns {number} Codeword bits written.
 */
export function writeResidualSymbols(source, band, mode, scaleFactor, sink) {
  const range = residualBandRange(source, band)
  validateResidualSyntax(mode, scaleFactor)
  return writeSymbols(source, range, mode, scaleFactor, sink)
}

/**
 * Emit a residual band's six-bit scale selector and exact codewords.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {object} sink Bit writer or counter.
 * @returns {number} Total bits written.
 */
export function writeResidualBand(source, band, mode, scaleFactor, sink) {
  const range = residualBandRange(source, band)
  validateResidualSyntax(mode, scaleFactor)
  const start = sink.bitPosition
  sink.write(scaleFactor, 6)
  writeSymbols(source, range, mode, scaleFactor, sink)
  return sink.bitPosition - start
}
