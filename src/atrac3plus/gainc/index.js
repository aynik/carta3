/**
 * Gain-control analysis, curve planning, and window synthesis for ATRAC3plus.
 *
 * This public barrel exposes the high-level subsystem stages used by other
 * encode paths: detection, curve planning, and window application.
 * Lower-level passes stay in `internal.js`.
 */
export { gaincWindowEncAt5 } from "./window.js";
export { setGaincAt5 } from "./set.js";
export { detectGaincDataNewAt5 } from "./detect.js";
