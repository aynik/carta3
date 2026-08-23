/** Carta3 spectral dequantization stage. */

import { dequantizeChannel } from './spectrum.js'

/** @import { SyntaxFrame } from '../unpacking.js' */
/** @import { DecoderContext } from '../pipeline/decoder.js' */

/**
 * Continuous coded spectra reconstructed from parsed symbols.
 *
 * @typedef {SyntaxFrame & object} SpectrumFrame
 * @property {Float32Array[]} spectra Reconstructed channel spectra.
 */

/**
 * Reconstruct spectra after both channels pass complete syntax checks.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(SyntaxFrame): SpectrumFrame} Dequantization stage.
 */
export function dequantize(context) {
  const spectra = context.bufferPool.decoder.frame.spectra
  return (frame) => {
    for (let channel = 0; channel < frame.decodedChannels.length; channel++) {
      dequantizeChannel(frame.decodedChannels[channel], spectra[channel])
    }
    frame.spectra = spectra
    return frame
  }
}
