/**
 * Internal ATRAC3plus gain-control barrel.
 *
 * The stable subsystem surface in `index.js` exposes only the high-level
 * analysis, planning, and window application stages. Lower-level curve and
 * pass helpers stay here for local maintenance and focused tests.
 */
export { gaincWindowEncAt5 } from "./window.js";

export {
  at5GaincPow2FromCurveVal,
  at5GaincMapToGainSel,
  at5GaincBuildNormalizedCurve,
  at5GaincSpikeCount,
  attackPassAt5,
  createGainPassOutput,
  evaluateCurveRaiseCandidateAt5,
  releasePassAt5,
} from "./passes.js";

export { setGaincAt5 } from "./set.js";

export { detectGaincDataNewAt5 } from "./detect.js";
