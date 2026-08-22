/** Carta3 retained-symbol quantization stage. */

import { promoteSymbols } from './symbols/independent.js'
import { quantizeLayered } from './symbols/layered.js'
import { selectEncoderMode } from '../core/profiles.js'

/** @import { AllocationFrame } from '../allocation/stage.js' */
/** @import { EncoderContext } from '../pipeline/encoder.js' */

/**
 * Final discrete symbols retained for packing.
 *
 * @typedef {AllocationFrame & object} SymbolFrame
 * @property {Int32Array[]} layeredSymbols Quantized layered coefficients.
 */

/**
 * Select final symbol materialization for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AllocationFrame): SymbolFrame} Quantization stage.
 */
export function quantize(context) {
  const quantizeMode = selectEncoderMode(
    context.profile,
    promoteSymbols,
    quantizeLayered,
    quantizeLayered
  )
  return quantizeMode(context)
}
