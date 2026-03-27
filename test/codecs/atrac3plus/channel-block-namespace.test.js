import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3plus from "../../../src/atrac3plus/subsystems.js";
import * as ChannelBlock from "../../../src/atrac3plus/channel-block/index.js";
import * as ChannelBlockInternal from "../../../src/atrac3plus/channel-block/internal.js";

test("ATRAC3plus channel-block public barrel exposes the encode-facing lifecycle only", () => {
  assert.equal(Atrac3plus.ChannelBlock, ChannelBlock);

  assert.equal(typeof ChannelBlock.createBitallocHeader, "function");
  assert.equal(typeof ChannelBlock.createChannelBlock, "function");
  assert.equal(typeof ChannelBlock.seedInitialBitalloc, "function");
  assert.equal(typeof ChannelBlock.solveChannelBlock, "function");
  assert.equal(typeof ChannelBlock.buildBasicAt5RegularBlockFromRuntime, "function");

  assert.equal("initializeChannelBlock" in ChannelBlock, false);
  assert.equal("normalizeChannelBlock" in ChannelBlock, false);
  assert.equal("shouldScaleSpectrumFromEncodeFlags" in ChannelBlock, false);
  assert.equal("scaleSpectrumPairInPlace" in ChannelBlock, false);
  assert.equal("swapSpectrumSegmentInPlace" in ChannelBlock, false);
  assert.equal("prepareLatePriorityOrder" in ChannelBlock, false);
  assert.equal("at5ShellSortDesc" in ChannelBlock, false);
  assert.equal("quantAt5" in ChannelBlock, false);
  assert.equal("shouldScaleSpectrumFromEncodeFlags" in Atrac3plus.ChannelBlock, false);
  assert.equal("prepareLatePriorityOrder" in Atrac3plus.ChannelBlock, false);
});

test("ATRAC3plus channel-block internal barrel retains helper exports", () => {
  assert.equal(typeof ChannelBlockInternal.initializeChannelBlock, "function");
  assert.equal(typeof ChannelBlockInternal.normalizeChannelBlock, "function");
  assert.equal(typeof ChannelBlockInternal.shouldScaleSpectrumFromEncodeFlags, "function");
  assert.equal(typeof ChannelBlockInternal.scaleSpectrumPairInPlace, "function");
  assert.equal(typeof ChannelBlockInternal.swapSpectrumSegmentInPlace, "function");
  assert.equal(typeof ChannelBlockInternal.encodeChannelBlocksWithinBudget, "function");
  assert.equal(typeof ChannelBlockInternal.createBasicBlockPlan, "function");
  assert.equal(typeof ChannelBlockInternal.encodeBasicBlockPlanChannel, "function");
  assert.equal(typeof ChannelBlockInternal.computeInitialModeAnalysis, "function");
  assert.equal(typeof ChannelBlockInternal.estimateBitallocOffset, "function");
  assert.equal(typeof ChannelBlockInternal.initializeQuantModes, "function");
  assert.equal(typeof ChannelBlockInternal.normalizeBandLimit, "function");
  assert.equal(typeof ChannelBlockInternal.at5CopyIdwlState, "function");
  assert.equal(typeof ChannelBlockInternal.prepareLatePriorityOrder, "function");
  assert.equal(typeof ChannelBlockInternal.at5ShellSortDesc, "function");
  assert.equal(typeof ChannelBlockInternal.quantAt5, "function");
  assert.equal(typeof ChannelBlockInternal.at5AdjustQuantOffsetsRebitalloc, "function");
  assert.equal(typeof ChannelBlockInternal.selectGainCodingMode, "function");
  assert.equal(typeof ChannelBlockInternal.bitallocOffsetTargetMode, "function");
  assert.equal(typeof ChannelBlockInternal.createBitallocOffsetState, "function");
  assert.equal(typeof ChannelBlockInternal.solveBitallocOffset, "function");
  assert.equal(typeof ChannelBlockInternal.stabilizeBitallocSolution, "function");
  assert.equal(typeof ChannelBlockInternal.runLateBudgetSolve, "function");
  assert.equal(typeof ChannelBlockInternal.runSpcAnalysisPhase, "function");
  assert.equal(typeof ChannelBlockInternal.runPostSpcRefinement, "function");
  assert.equal(typeof ChannelBlockInternal.repairOvershootAndRequantize, "function");
  assert.equal(typeof ChannelBlockInternal.syncSolvedChannelBlockState, "function");
});
