/** Carta3 allocation stage. */

import { solve } from './solve.js'

/**
 * Select retained representation and bit distribution for one analyzed frame.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation stage.
 */
export function allocate(context) {
  return solve(context)
}
