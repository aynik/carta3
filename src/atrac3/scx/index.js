/**
 * ATRAC3 SCX encoder subsystem.
 *
 * This barrel exposes the SCX encoder context and frame entrypoints. Lower
 * level Huffman, time2freq, tone, and packing helpers stay under the parent
 * ATRAC3 package-private namespace in `../internal.js`.
 */
export { at3ScxEncodeFrameFromPcm, at3ScxEncodeFrameFromSpectra } from "./frame.js";
export { createAtrac3ScxEncoderContext } from "./context.js";
