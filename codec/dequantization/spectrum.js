/** Carta3 spectrum reconstruction. */

import { float32Add, float32Multiply } from '../utils.js'

/**
 * Apply inverse quantization to one parsed channel.
 *
 * @param {object} decoded Parsed channel syntax.
 * @param {Float32Array} spectrum Caller-owned reconstructed spectrum.
 * @returns {Float32Array} Reconstructed channel spectrum.
 */
export function dequantizeChannel(decoded, spectrum) {
  spectrum.fill(0)
  for (const run of decoded.runs) {
    for (let index = 0; index < run.values.length; index++) {
      const output = run.outputStart + index
      spectrum[output] = float32Add(
        spectrum[output],
        float32Multiply(run.values[index], run.scale)
      )
    }
  }
  return spectrum
}
