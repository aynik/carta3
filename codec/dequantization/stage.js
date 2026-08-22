/** Carta3 spectral dequantization stage. */

import { reconstructChannelSpectrum } from '../syntax/unit/reader.js'

/**
 * Reconstruct spectra after both channels pass complete syntax checks.
 *
 * @returns {function(DecoderFrame): DecoderFrame} Dequantization stage.
 */
export function dequantize() {
  return (frame) => {
    for (const decoded of frame.decodedChannels) {
      reconstructChannelSpectrum(decoded)
    }
    return frame
  }
}
