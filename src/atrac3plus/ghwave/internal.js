/**
 * Internal ATRAC3plus generalized harmonic wave barrel.
 *
 * The stable subsystem surface in `index.js` exposes the major GH analysis
 * stages. Slot-state accessors, mode-selection helpers, and synthesis details
 * stay here for local maintenance and focused tests.
 */
export { analysisGeneralAt5 } from "./general.js";
export {
  analysisGeneralAt5Sub,
  applyBand0FrequencyLimitAt5,
  computeGeneralMaxEntryCountsAt5,
  finalizeGeneralEntriesAt5,
} from "./general.js";
export { analysisSineAt5Sub } from "./sine.js";
export { analysisCtxForSlot, analysisCtxForSlotConst } from "./ctx.js";
export {
  at5GhwaveClassifyEnergy,
  at5GhwaveRefineModeCandidatesFromPeaks,
  computeSineExtractAllocationsAt5,
  extractGhwaveAt5,
  refineGhwaveModeCandidatesAt5,
  resolveGhwaveModeConfigAt5,
  runSineModeExtractionAt5,
} from "./extract.js";
export { at5GhwaveApplySynthesisResidual } from "./synth.js";
export { fineAnalysisAt5 } from "./component.js";
