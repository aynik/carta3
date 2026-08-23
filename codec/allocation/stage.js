/** Carta3 allocation stage. */

import { solve } from './solve.js'

/**
 * Select retained representation and bit distribution for one analyzed frame.
 *
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Allocation stage.
 */
export function allocate(context) {
  return solve(context)
}
