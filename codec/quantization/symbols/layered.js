/** Carta3 layered retained-symbol materialization. */

import { quantizeLayeredResidual } from '../../allocation/layered.js'

/**
 * Materialize both layers' retained residual symbols.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Quantization operation.
 */
export function quantizeLayered(context) {
  const symbols = context.bufferPool.encoder.frame.layeredSymbols
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      quantizeLayeredResidual(
        frame.layers[layer],
        frame.layeredAllocationWork[layer],
        symbols[layer]
      )
    }
    frame.layeredSymbols = symbols
    return frame
  }
}
