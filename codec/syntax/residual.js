/** Carta3 residual wire emission. */

/** Carta3 Audio Codec - Residual codebooks, quantization, and pricing. */

import { RESIDUAL_SYMBOL_MASKS } from '../core/tables.js'
import {
  quantizeResidualCoefficient,
  residualBandRange,
  residualCodebook,
  residualQuantGroupScale,
  validateResidualSyntax,
} from '../quantization/symbols/residual.js'
/**
 * Expand one compact residual mode into encoder and decoder tables.
 *
 * @param {number} mode
 * @returns {object}
 */

/**
 * Quantize and write residual symbols over a validated coefficient range.
 *
 * @param {Float32Array} source
 * @param {object} range
 * @param {number} mode
 * @param {number} scaleFactor
 * @param {object} sink
 * @returns {number}
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
 * Materialize one residual band's selected symbols.
 *
 * @param {ArrayLike<number>} source Complete residual spectrum.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {Int32Array} output Complete retained symbol destination.
 * @returns {Int32Array} `output` after quantization.
 */

/**
 * Write one residual band's retained symbols.
 *
 * @param {Int32Array} symbols Complete retained symbol source.
 * @param {number} band Quantization-unit index.
 * @param {number} mode Residual quantization mode.
 * @param {number} scaleFactor Six-bit scale-factor index.
 * @param {{bitPosition: number, write: Function}} sink Bit writer.
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
 * @param {{bitPosition: number, write: Function}} sink Bit writer or counter.
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
 * @param {{bitPosition: number, write: Function}} sink Bit writer or counter.
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
