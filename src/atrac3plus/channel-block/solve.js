import { solveBitallocOffset } from "./bitalloc-offset.js";
import { at5InitQuantOffsets } from "./quant-bootstrap.js";
import { getSolveScratchState } from "./spc-levels.js";
import { validateOrResetAt5MainData } from "./packed-state.js";
import {
  repairOvershootAndRequantize,
  runLateBudgetSolve,
  runPostSpcRefinement,
  runSpcAnalysisPhase,
  stabilizeBitallocSolution,
} from "./solve-phases.js";

/**
 * Solves one ATRAC3plus channel block from the seeded bitalloc-offset stage
 * through the late budget, scalefactor, pruning, and validation phases.
 *
 * Like the earlier lifecycle stages, this consumes a named block context and
 * falls back to the staged channels already attached to `runtimeBlock`.
 */
export function solveChannelBlock(args) {
  const {
    runtimeBlock,
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels,
    channelCount,
    coreMode,
    bitLimit,
    trace = null,
  } = args ?? {};
  const blockChannels = channels ?? runtimeBlock?.channelEntries ?? runtimeBlock?.channels ?? [];
  const blockChannelCount =
    (channelCount ?? runtimeBlock?.channelsInBlock ?? blockChannels.length) | 0;
  if (blockChannelCount <= 0 || !hdr) {
    return 0;
  }

  const primaryChannel = blockChannels[0] ?? null;
  const shared = primaryChannel?.shared ?? runtimeBlock?.shared ?? null;
  if (!shared) {
    return 0;
  }

  const codedBandCount = (shared.codedBandLimit ?? 0) | 0;
  const primaryBlockState = primaryChannel?.blockState ?? runtimeBlock?.blockState ?? null;
  const idsfCountRaw = shared.idsfCount ?? 0;
  const idsfCount = (idsfCountRaw & 0x3fffffff) | 0;
  const encodeFlagMask = ((shared.encodeFlags ?? 0) >>> 0) & 0x7c;
  const sampleRateHz = shared.sampleRateHz >>> 0;
  const bitBudget = bitLimit | 0;
  const coreModeValue = coreMode | 0;
  const shouldAnalyzeSpcLevels = encodeFlagMask === 0;
  const isMode4Block = ((primaryBlockState?.isMode4Block ?? 0) | 0) !== 0;
  const shouldRetryLateBudgetAfterPrune = ((primaryBlockState?.encodeMode ?? 0) | 0) !== 2;
  const firstMirrorChannelCount = isMode4Block ? 1 : blockChannelCount;
  const { latePriority, spcLevelEnabledByChannel } = getSolveScratchState(hdr);
  const solveContext = {
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels: blockChannels,
    shared,
    channelCount: blockChannelCount,
    bandCount: codedBandCount,
    coreMode: coreModeValue,
    bitLimit: bitBudget,
    idsfCount,
    idsfCountRaw,
    latePriority,
    shouldAnalyzeSpcLevels,
    shouldRetryLateBudgetAfterPrune,
    spcLevelEnabledByChannel,
  };

  // Clear per-channel IDWL pack selectors before the solve repacks the block.
  if (encodeFlagMask !== 0) {
    hdr.idwlEnabled = 0;
  }
  for (let ch = 0; ch < blockChannelCount; ch += 1) {
    const channel = blockChannels[ch];
    if (channel) {
      channel.idwlPackMode = 0;
    }
  }

  // Seed the exact bitalloc-offset solve before the later stages reorder
  // priorities around the live HCSPEC choices.
  at5InitQuantOffsets(
    blocks,
    solveContext.channels,
    hdr,
    solveContext.channelCount,
    solveContext.bandCount,
    solveContext.coreMode,
    sampleRateHz
  );
  solveBitallocOffset(
    hdr,
    blocks,
    solveContext.channels,
    solveContext.channelCount,
    solveContext.bandCount,
    solveContext.bitLimit,
    solveContext.coreMode
  );
  if (typeof trace === "function") {
    trace({
      stage: "sba2",
      runtimeBlock,
      hdr,
      blocks,
      quantizedSpectraByChannel,
      channels: blockChannels,
      channelCount: blockChannelCount,
      bandCount: codedBandCount,
      coreMode: coreModeValue,
      bitLimit: bitBudget,
    });
  }

  stabilizeBitallocSolution(solveContext);
  runLateBudgetSolve(solveContext);
  runSpcAnalysisPhase(solveContext, firstMirrorChannelCount);

  if (!isMode4Block) {
    runPostSpcRefinement(solveContext);
  }

  // If the human-facing late stages still overshoot, fall back to the hard-fit
  // repair path and requantize once more from the final packed state.
  repairOvershootAndRequantize(solveContext);

  validateOrResetAt5MainData(shared, blockChannels, blockChannelCount, hdr);
  const usedBits = (hdr.bitsTotal ?? 0) | 0;
  shared.usedBitCount = usedBits >>> 0;
  return usedBits;
}
