import { CodecError } from "../common/errors.js";

import { AT3ENC_PROC_ACTIVE_BANDS_WORD } from "./proc-layout.js";
import {
  LOW_BUDGET_BAND_HEADER_BITS,
  pruneAndMeasureLowBudgetBands,
} from "./proc-low-budget-scan.js";
import { runLowBudgetTonePath } from "./proc-low-budget-tone.js";
import { finalizeLowBudgetBandPayload } from "./proc-payload-fit.js";
import { planLowBudgetBandPayloads } from "./proc-payload-plan.js";
import {
  beginLowBudgetProcWordPass,
  saveProcWordsCorrectionDebug,
  saveProcWordsEntryDebug,
  saveProcWordsPlanDebug,
  trimUnusedTrailingProcUnits,
} from "./proc-words-pass.js";

/**
 * Fills the ATRAC3 low-budget proc-word scratch layout for one encoded layer.
 *
 * Neighboring proc modules own scratch layout, coarse band metrics, tone
 * extraction, and concrete payload fitting. This owner allocates the shared
 * scratch state, runs the four-stage pass in order, and leaves `frame.js`
 * with one filled proc-word buffer per channel layer.
 */
export function fillAt3ProcWordsLowBudget(layer, state, procWords, debug = null) {
  if (!layer || !(layer.spectrum instanceof Float32Array) || layer.spectrum.length < 1024) {
    throw new CodecError("layer.spectrum must be a Float32Array with at least 1024 values");
  }
  if (!(procWords instanceof Uint32Array)) {
    throw new CodecError("procWords must be a Uint32Array");
  }

  const spectrumU32 = new Uint32Array(
    layer.spectrum.buffer,
    layer.spectrum.byteOffset,
    layer.spectrum.length
  );
  const {
    scratch,
    toneState,
    toneBlocks,
    bandModes,
    bandSelectors,
    bandLimit,
    bitBudget,
    usesIndependentCoding,
    modeShift,
    availableBits: initialAvailableBits,
    sumTotal,
    over7TotalWithinLimit,
  } = beginLowBudgetProcWordPass(layer, procWords);
  let availableBits = initialAvailableBits;
  availableBits = runLowBudgetTonePath(layer, procWords, {
    bandLimit,
    availableBits,
    bitBudget,
    modeShift,
    usesIndependentCoding,
    sumTotal,
    over7TotalWithinLimit,
    bandSum: scratch.bandSum,
    bandModes,
    bandSelectors,
    bandMetrics: scratch.bandMetrics,
    groupIdsf: scratch.groupIdsf,
    spectrumU32,
    toneClaimSelectors: scratch.toneClaimSelectors,
    toneClaimWidths: scratch.toneClaimWidths,
    debug,
  });

  saveProcWordsEntryDebug(debug, bandModes, bandSelectors, scratch.bandMetrics, {
    bandLimit,
    bitBudget,
    modeShift,
    availableBits,
  });

  // Phase 2: suppress bands that lost their local competition, reclaim any
  // now-unused tail headers, and estimate the remaining non-tone payload.
  let estimatedBits;
  let activeWidth;
  let mode7Width;
  let activeBands;
  ({ estimatedBits, activeWidth, mode7Width, activeBands, availableBits } =
    pruneAndMeasureLowBudgetBands(
      procWords,
      bandModes,
      bandSelectors,
      scratch.bandMetrics,
      scratch.groupIdsf,
      bandLimit,
      availableBits
    ));

  const previousOutput = state.channelConversion?.mixCode?.previous ?? 0;
  availableBits = trimUnusedTrailingProcUnits(
    procWords,
    toneBlocks,
    availableBits,
    usesIndependentCoding || (previousOutput & 7) === 7
  );

  let totalAvailable = availableBits;
  // Phase 3: rebuild the coarse correction trail and turn the surviving bands
  // into concrete payload plans for the final fitter.
  const shouldCaptureDebug = debug && typeof debug === "object";
  const payloadPlan = planLowBudgetBandPayloads({
    bandModes,
    bandSelectors,
    bandMetrics: scratch.bandMetrics,
    groupIdsf: scratch.groupIdsf,
    estimatedBits,
    activeWidth,
    mode7Width,
    activeBands,
    totalAvailable,
    modeShift,
    spectrum: layer.spectrum,
    captureDebug: shouldCaptureDebug,
  });
  const {
    remaining10,
    bandBudgetTrail,
    bandModesAfterCorrection,
    bandSelectorsAfterCorrection,
    plannedBits,
    bandPlans,
    plannedActiveBands,
    bitCountSnapshot,
    prioritySnapshot,
  } = payloadPlan;
  saveProcWordsCorrectionDebug(
    debug,
    bandModesAfterCorrection,
    bandSelectorsAfterCorrection,
    bandBudgetTrail,
    remaining10
  );

  saveProcWordsPlanDebug(debug, bandModes, bandSelectors, bitCountSnapshot, {
    bitsUsed: plannedBits,
    totalAvailable,
    bandPriority: prioritySnapshot,
  });

  // Keep the trailing header reclaim as an explicit pre-fit step. Moving it
  // into the final fitter perturbs the signal-perfect ATRAC3 stereo matrix
  // paths even though the local low-budget helper tests still pass.
  totalAvailable += (activeBands - plannedActiveBands) * LOW_BUDGET_BAND_HEADER_BITS;
  activeBands = plannedActiveBands;
  procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = activeBands >>> 0;

  return finalizeLowBudgetBandPayload({
    procWords,
    bandModes,
    bandSelectors,
    bandPlans,
    plannedBits,
    activeBands,
    totalAvailable,
    spectrum: layer.spectrum,
    usesIndependentCoding,
    previousBlock0ToneCount: toneState?.previousBlock0EntryCount ?? 0,
    block0ToneCount: toneBlocks?.[0]?.entryCount ?? 0,
    bitBudget,
  });
}
