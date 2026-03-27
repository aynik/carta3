/**
 * Stable ATRAC3 public surface.
 *
 * The package exports only the reusable decoder wrapper and the decoder-state
 * builder here. Lower-level frame decode helpers and encoder internals stay
 * under the package-private `internal.js` surface.
 */
export { Atrac3Decoder } from "./decoder.js";
export { createAtrac3DecoderState } from "./decoder-state.js";
