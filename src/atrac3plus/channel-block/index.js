/**
 * Stable ATRAC3plus channel-block encode surface.
 *
 * These exports describe the stable block-building and solve steps that callers
 * outside the package can study and reuse directly. Runtime staging helpers and
 * lower-level work-table utilities stay behind `internal.js`.
 */
export { createBitallocHeader, createChannelBlock } from "./construction.js";
export { buildBasicAt5RegularBlockFromRuntime } from "./basic-block.js";
export { bootstrapChannelBlock, seedInitialBitalloc } from "./initial-bitalloc.js";
export { solveChannelBlock } from "./solve.js";
