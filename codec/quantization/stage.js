/** Carta3 retained-symbol quantization stage. */

import { promoteSymbols } from './symbols/independent.js'
import { quantizeLayered } from './symbols/layered.js'

/**
 * Select final symbol materialization for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Quantization stage.
 */
export function quantize(context) {
  return context.profile.bitrateKbps === 132
    ? promoteSymbols()
    : quantizeLayered(context)
}
