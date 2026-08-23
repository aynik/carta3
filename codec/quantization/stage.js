/** Carta3 retained-symbol quantization stage. */

import { promoteSymbols } from './symbols/independent.js'
import { quantizeLayered } from './symbols/layered.js'
import { selectEncoderMode } from '../core/profiles.js'

/**
 * Select final symbol materialization for the configured profile.
 *
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Quantization stage.
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
