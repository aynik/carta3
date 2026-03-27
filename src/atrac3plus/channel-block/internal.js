/**
 * Internal channel-block helper barrel for ATRAC3plus encode.
 *
 * This file intentionally re-exports lower-level helpers for local study and
 * maintenance, while the stable encode-facing surface lives in `index.js`.
 */
export { AT5_Y } from "./constants.js";

export {
  at5BaseMaxQuantModeForCoreMode,
  at5GainCountsEqualToBase,
  at5GainIdlevLevelsEqualToBase,
  at5GainIdlocPrefixEqualToBase,
  computeGainRecordRangeFlag,
  countNonEmptyGainRecords,
  countPackedGainRecords,
  deriveScalefactorsFromSpectrumAt5,
  normalizeSpectrumAt5,
} from "./metadata.js";

export {
  at5AbsI32,
  at5MeasurePackBits,
  at5RoundHalfUp,
  at5S16,
  at5U16,
  toggleF32SignInPlace,
} from "./primitives.js";

export {
  getChannelWorkId,
  setChannelWorkId,
  selectBestHcspecCostForBand,
  at5RecomputeMissingCtxCostsAndSelect,
  at5RecomputeCtxCosts,
  at5RecomputeTotalBits,
  at5TrimHighBandsToFit,
} from "./core.js";

export {
  createBitallocHeader,
  createChannelBlock,
  resetBitallocHeader,
  resetChannelBlockEncodeState,
} from "./construction.js";

export { encodeChannelBlocksWithinBudget } from "./budget.js";

export {
  bitallocOffsetTargetMode,
  clampBitallocOffset,
  computeBandScale,
  createBitallocOffsetState,
  computeBitallocMode,
  firstGainRecordHasWideLevels,
  gainRecordRangeFlag,
  hasAllGainRecordsInPrefix,
  quantModeForBitallocOffset,
  searchBitallocOffset,
  selectWcfxTable,
  selectNegativeBitallocOffsetWeights,
  sfAdjustConfigForCoreMode,
  usesDirectBitallocScaling,
} from "./bitalloc-heuristics.js";
export { at5InitQuantOffsets, initQuantOffsets, prepareQuantOffsets } from "./quant-bootstrap.js";
export {
  buildBasicAt5RegularBlockFromRuntime,
  computeInitialModeAnalysis,
  createBasicBlockPlan,
  encodeBasicBlockPlanChannel,
  estimateBitallocOffset,
  maxAbsInBand,
} from "./basic-block.js";

export {
  applySwapMapToSpectraInPlace,
  applyRuntimeStereoSwapPresence,
  buildSwapAdjustedSpectra,
  clearBandTail,
  copyGainRecordsFromRuntime,
  copyPresenceFromRuntime,
  swapSpectrumSegmentInPlace,
} from "./runtime.js";

export {
  adjustScalefactorsAt5,
  computeSpcLevelSlotsAt5,
  getSolveScratchState,
  getSpcLevelScratchState,
  pwcQuAt5,
  updateSpcLevelIndicesFromQuantizedData,
} from "./spc-levels.js";

export {
  at5ApplyMode3BandMaskAndFlipHintsAt5,
  bootstrapChannelBlock,
  initializeChannelBlock,
  initializeQuantModes,
  normalizeBandLimit,
  normalizeChannelBlock,
  scaleSpectrumPairInPlace,
  seedInitialBitalloc,
  selectGainCodingMode,
  shouldScaleSpectrumFromEncodeFlags,
} from "./initial-bitalloc.js";

export {
  meanAbsInBand,
  at5QuantizeActiveBands,
  quantAt5,
  quantizeBandAt5,
  quantizeBandScalar,
  quantizeBandScalarWithIdsfRefine,
} from "./quantize.js";

export {
  at5AdjustQuantOffsetsRebitalloc,
  applyRebitallocChoice,
  planRebitallocChoice,
  refineRebitallocOffsets,
  restoreRebitallocState,
  snapshotRebitallocState,
  tryApplyRebitallocChoice,
} from "./rebitalloc.js";

export { solveBitallocOffset } from "./bitalloc-offset.js";

export {
  at5ShellSortDesc,
  prepareLatePriorityOrder,
  pruneCoefficientsWithinBudget,
  raiseIdwlModesWithinBudget,
  relaxQuantOffsetsWithinBudget,
  tryRaiseIdwlModeWithinBudget,
} from "./late-budget.js";

export {
  at5CopyIdwlState,
  computeIdwlBitsAt5,
  resetAt5MainData,
  validateOrResetAt5MainData,
} from "./packed-state.js";

export {
  repairOvershootAndRequantize,
  runLateBudgetSolve,
  runPostSpcRefinement,
  runSpcAnalysisPhase,
  stabilizeBitallocSolution,
  syncSolvedChannelBlockState,
} from "./solve-phases.js";

export { solveChannelBlock } from "./solve.js";
export { copyAt5RebitallocMirror } from "../rebitalloc-layout.js";

export { quantNontoneNspecsAt5 } from "./quant-cost.js";
