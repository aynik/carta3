/** Carta3 spectral dequantization stage. */

import { dequantizeChannel } from './spectrum.js'

/** @import { SyntaxFrame } from '../unpacking.js' */

/**
 * Continuous coded spectra reconstructed from parsed symbols.
 *
 * @typedef {SyntaxFrame} SpectrumFrame
 */

/**
 * Reconstruct spectra after both channels pass complete syntax checks.
 *
 * @returns {function(SyntaxFrame): SpectrumFrame} Dequantization stage.
 */
export function dequantize() {
  return (frame) => {
    for (const decoded of frame.decodedChannels) {
      dequantizeChannel(decoded)
    }
    return frame
  }
}
