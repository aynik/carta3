/** Carta3 spectrum reconstruction. */

import { float32Add, float32Multiply } from '../utils.js'

/**
 * Apply inverse quantization to one parsed channel.
 *
 * @param {object} decoded Parsed channel syntax.
 * @returns {Float32Array} Reconstructed channel spectrum.
 */
export function dequantizeChannel(decoded) {
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
