/** Carta3 layered retained-symbol materialization. */

import { AllocationWorkView } from '../../state/allocation.js'
import { quantizeResidualSymbols } from './residual.js'

/**
 * Materialize one layer's retained residual symbols.
 *
 * @param {object} layer Transaction-local transformed layer state.
 * @param {Int32Array} work Completed allocation word image.
 * @param {Int32Array} output Caller-owned retained symbol storage.
 * @returns {Int32Array} `output` after quantization.
 */
function quantizeResidual(layer, work, output) {
  const allocation = new AllocationWorkView(work)
  output.fill(0)
  for (let band = 0; band < allocation.activeBandCount; band++) {
    const mode = allocation.mode(band)
    if (mode !== 0) {
      quantizeResidualSymbols(
        layer.spectrum,
        band,
        mode,
        allocation.scaleFactor(band),
        output
      )
    }
  }
  return output
}

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
      quantizeResidual(
        frame.layers[layer],
        frame.layeredAllocationWork[layer],
        symbols[layer]
      )
    }
    frame.layeredSymbols = symbols
    return frame
  }
}
