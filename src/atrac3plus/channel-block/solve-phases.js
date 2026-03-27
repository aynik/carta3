import { copyAt5RebitallocMirror } from "../rebitalloc-layout.js";
import { at5AdjustQuantOffsetsRebitalloc, refineRebitallocOffsets } from "./rebitalloc.js";
import {
  at5RecomputeMissingCtxCostsAndSelect,
  at5RecomputeTotalBits,
  at5TrimHighBandsToFit,
} from "./core.js";
import { adjustScalefactorsAt5, computeSpcLevelSlotsAt5 } from "./spc-levels.js";
import { at5CopyIdwlState } from "./packed-state.js";
import {
  prepareLatePriorityOrder,
  pruneCoefficientsWithinBudget,
  raiseIdwlModesWithinBudget,
  relaxQuantOffsetsWithinBudget,
} from "./late-budget.js";
import { at5QuantizeActiveBands } from "./quantize.js";

/**
 * Shared solve context passed through the ATRAC3plus channel-block solve phases.
 *
 * @typedef {object} At5SolveContext
 * @property {object} hdr
 * @property {object[]} blocks
 * @property {Float32Array[]} quantizedSpectraByChannel
 * @property {object[]} channels
 * @property {object | null} [shared]
 * @property {number} channelCount
 * @property {number} bandCount
 * @property {number} coreMode
 * @property {number} bitLimit
 * @property {number} [idsfCount]
 * @property {number} [idsfCountRaw]
 * @property {object | null} [latePriority]
 * @property {Uint8Array | Int32Array | Uint32Array | null} [spcLevelEnabledByChannel]
 * @property {boolean} [shouldAnalyzeSpcLevels]
 * @property {boolean} [shouldRetryLateBudgetAfterPrune]
 */

/**
 * Re-stabilizes the exact bitalloc-offset solution before the late-budget
 * phases start reordering priorities around the live HCSPEC choices.
 *
 * @param {At5SolveContext} solveContext
 */
export function stabilizeBitallocSolution(solveContext) {
  const {
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels,
    channelCount,
    bandCount,
    bitLimit,
    coreMode,
  } = solveContext ?? {};
  const totalChannels = channelCount | 0;
  const bands = bandCount | 0;
  const bitBudget = bitLimit | 0;
  const coreModeValue = coreMode | 0;

  if ((hdr?.bitsTotal ?? 0) > bitBudget) {
    at5AdjustQuantOffsetsRebitalloc(
      blocks,
      channels,
      hdr,
      totalChannels,
      bands,
      coreModeValue,
      bitBudget
    );
  }
  at5RecomputeMissingCtxCostsAndSelect(blocks, channels, totalChannels, bands);
  at5RecomputeTotalBits(hdr, blocks, channels, totalChannels);
  if ((hdr?.bitsTotal ?? 0) > bitBudget) {
    at5TrimHighBandsToFit(
      blocks,
      quantizedSpectraByChannel,
      channels,
      hdr,
      totalChannels,
      bands,
      bitBudget
    );
  }
}

function runLateBudgetPass(solveContext) {
  const { hdr, blocks, channels, channelCount, bandCount, bitLimit, latePriority } =
    solveContext ?? {};
  raiseIdwlModesWithinBudget(
    hdr,
    blocks,
    channels,
    channelCount,
    bandCount,
    bitLimit,
    latePriority
  );
  relaxQuantOffsetsWithinBudget(
    hdr,
    blocks,
    channels,
    channelCount,
    bandCount,
    bitLimit,
    latePriority
  );
}

/**
 * Rebuilds the late-budget priority order from the live HCSPEC state, then
 * spends the remaining slack on the ordered IDWL-raise and offset-relax passes.
 *
 * @param {At5SolveContext} solveContext
 */
export function runLateBudgetSolve(solveContext) {
  const { hdr, blocks, channels, channelCount, bandCount, latePriority } = solveContext ?? {};
  prepareLatePriorityOrder(hdr, blocks, channels, channelCount, bandCount, latePriority);
  runLateBudgetPass(solveContext);
}

/**
 * Copies the current packed IDWL and rebitalloc state back into the runtime
 * channels, then requantizes the active bands from the live packed solution.
 *
 * @param {At5SolveContext} solveContext
 * @param {number} [mirrorChannelCount]
 */
export function syncSolvedChannelBlockState(solveContext, mirrorChannelCount = null) {
  const {
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels,
    channelCount,
    bandCount,
    idsfCountRaw,
  } = solveContext ?? {};
  const mirroredChannels = mirrorChannelCount ?? channelCount;
  if ((hdr?.idwlInitialized ?? 0) === 1) {
    at5CopyIdwlState(blocks, channels, channelCount);
  }
  for (let ch = 0; ch < (mirroredChannels | 0); ch += 1) {
    copyAt5RebitallocMirror(channels[ch], blocks?.[ch]?.rebitallocScratch ?? null, idsfCountRaw);
  }
  at5QuantizeActiveBands(blocks, quantizedSpectraByChannel, channels, channelCount, bandCount);
}

/**
 * Runs SPC-level analysis on the requantized late-budget spectrum when the
 * current encode flags leave that analysis path enabled.
 *
 * @param {At5SolveContext} solveContext
 * @param {number} mirrorChannelCount
 */
export function runSpcAnalysisPhase(solveContext, mirrorChannelCount) {
  const {
    hdr,
    blocks,
    channels,
    shared,
    channelCount,
    coreMode,
    shouldAnalyzeSpcLevels,
    spcLevelEnabledByChannel,
  } = solveContext ?? {};
  spcLevelEnabledByChannel.fill(shouldAnalyzeSpcLevels ? 1 : 0);
  syncSolvedChannelBlockState(solveContext, mirrorChannelCount);
  computeSpcLevelSlotsAt5(
    blocks,
    channels,
    hdr,
    shared,
    channelCount,
    coreMode | 0,
    spcLevelEnabledByChannel
  );
}

/**
 * Runs the post-SPC refinement path: scalefactor adjustment, optional
 * rebitalloc repair, coefficient pruning, a late-budget retry when enabled,
 * and finally a state sync back into the packed runtime views.
 *
 * @param {At5SolveContext} solveContext
 */
export function runPostSpcRefinement(solveContext) {
  const {
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels,
    channelCount,
    bandCount,
    coreMode,
    bitLimit,
    idsfCount,
    shouldRetryLateBudgetAfterPrune,
  } = solveContext ?? {};
  const totalChannels = channelCount | 0;
  const bands = bandCount | 0;
  const coreModeValue = coreMode | 0;
  const bitBudget = bitLimit | 0;

  adjustScalefactorsAt5(
    blocks,
    quantizedSpectraByChannel,
    channels,
    totalChannels,
    bands,
    coreModeValue
  );

  if ((hdr?.bitsTotal ?? 0) > bitBudget) {
    refineRebitallocOffsets(
      hdr,
      blocks,
      channels,
      totalChannels,
      coreModeValue,
      bitBudget,
      idsfCount | 0
    );
  }

  pruneCoefficientsWithinBudget(
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels,
    totalChannels,
    idsfCount | 0,
    bitBudget
  );

  if (shouldRetryLateBudgetAfterPrune) {
    runLateBudgetPass(solveContext);
  }

  syncSolvedChannelBlockState(solveContext, totalChannels);
}

/**
 * Falls back to the hard-fit repair path when the human-facing late solve
 * still overshoots, then requantizes once more from the final packed state.
 *
 * @param {At5SolveContext} solveContext
 */
export function repairOvershootAndRequantize(solveContext) {
  const {
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels,
    channelCount,
    bandCount,
    coreMode,
    bitLimit,
    idsfCount,
  } = solveContext ?? {};
  const totalChannels = channelCount | 0;
  const bands = bandCount | 0;
  const coreModeValue = coreMode | 0;
  const bitBudget = bitLimit | 0;

  if ((hdr?.bitsTotal ?? 0) <= bitBudget) {
    return;
  }

  refineRebitallocOffsets(
    hdr,
    blocks,
    channels,
    totalChannels,
    coreModeValue,
    bitBudget,
    idsfCount | 0
  );
  if ((hdr?.bitsTotal ?? 0) > bitBudget) {
    at5TrimHighBandsToFit(
      blocks,
      quantizedSpectraByChannel,
      channels,
      hdr,
      totalChannels,
      bands,
      bitBudget
    );
  }
  at5QuantizeActiveBands(blocks, quantizedSpectraByChannel, channels, totalChannels, bands);
}
