/** Carta3 spectral dequantization stage. */

import { dequantizeChannel } from './spectrum.js'

/**
 * Reconstruct spectra after both channels pass complete syntax checks.
 *
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Dequantization stage.
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
