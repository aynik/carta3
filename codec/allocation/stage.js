/** Carta3 allocation stage. */

import { solve } from './solve.js'

/** @import { AnalysisFrame } from '../analysis/stage.js' */
/** @import { EncoderContext } from '../pipeline/encoder.js' */

/**
 * Retained representation and exact bit-budget decisions.
 *
 * @typedef {AnalysisFrame & object} AllocationFrame
 * @property {object[]} soundUnits Selected independent-channel syntax.
 * @property {Int32Array[]} layeredAllocationWork Selected layered decisions.
 */

/**
 * Select retained representation and bit distribution for one analyzed frame.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(AnalysisFrame): AllocationFrame} Allocation stage.
 */
export function allocate(context) {
  return solve(context)
}
