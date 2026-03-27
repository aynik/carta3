/**
 * Generalized harmonic wave analysis for ATRAC3plus encode.
 *
 * This stable surface exposes the major GH analysis stages that callers can
 * study directly: general-band analysis and the full extraction pass.
 * Slot-state accessors and mode-selection helpers stay in `internal.js`.
 */
export { analysisGeneralAt5 } from "./general.js";
export { extractGhwaveAt5 } from "./extract.js";
