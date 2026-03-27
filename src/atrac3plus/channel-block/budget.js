import { CodecError } from "../../common/errors.js";
import { readNodeEnvFlag } from "../../common/env.js";

import {
  createBitallocHeader,
  createChannelBlock,
  resetBitallocHeader,
  resetChannelBlockEncodeState,
} from "./construction.js";
import { bootstrapChannelBlock } from "./initial-bitalloc.js";
import { solveChannelBlock } from "./solve.js";

const ATX_ENC_ERR_BITS_OVERFLOW = 0x102;

function getOrCreateBlockSolveState(runtimeBlock) {
  const channelCount = runtimeBlock?.channelsInBlock | 0;
  if (channelCount <= 0 || channelCount > 2) {
    throw new CodecError(
      `invalid ATRAC3plus channel count for channel block encode: ${channelCount}`
    );
  }

  let solveState = runtimeBlock?.channelBlockEncodeState ?? null;
  if (!solveState || (solveState.channelCount | 0) !== channelCount) {
    solveState = {
      channelCount,
      hdr: createBitallocHeader(channelCount),
      blocks: Array.from({ length: channelCount }, () => createChannelBlock()),
    };
    runtimeBlock.channelBlockEncodeState = solveState;
  }

  resetBitallocHeader(solveState.hdr, channelCount);
  for (let ch = 0; ch < channelCount; ch += 1) {
    resetChannelBlockEncodeState(solveState.blocks[ch]);
  }
  return solveState;
}

function solveBudgetUnitBits(budgetUnit, bitLimit, trace) {
  return (
    solveChannelBlock({
      runtimeBlock: budgetUnit.runtimeBlock,
      hdr: budgetUnit.hdr,
      blocks: budgetUnit.blocks,
      quantizedSpectraByChannel: budgetUnit.runtimeBlock.quantizedSpectraByChannel,
      coreMode: budgetUnit.coreMode | 0,
      bitLimit: bitLimit | 0,
      trace,
    }) | 0
  );
}

function collectBudgetHeaderTrace(hdr) {
  return {
    idwlEnabled: hdr.idwlEnabled ?? null,
    idwlInitialized: hdr.idwlInitialized ?? null,
    idsfModeWord: hdr.idsfModeWord ?? null,
    baseBitsField: hdr.baseBits ?? null,
    bitsFixed: hdr.bitsFixed ?? null,
    bitsTotalBase: hdr.bitsTotalBase ?? null,
    bitsTotal: hdr.bitsTotal ?? null,
    bitsIdwl: hdr.bitsIdwl ?? null,
    bitsIdsf: hdr.bitsIdsf ?? null,
    bitsIdct: hdr.bitsIdct ?? null,
    bitsGain: hdr.bitsGain ?? null,
    bitsGha: hdr.bitsGha ?? null,
    bitsMisc: hdr.bitsMisc ?? null,
    bitsStereoMaps: hdr.bitsStereoMaps ?? null,
    bitsChannelMaps: hdr.bitsChannelMaps ?? null,
  };
}

function roundSharedAllocationBits(value) {
  return (Math.trunc((value || 0) * 0.125) | 0) << 3;
}

function buildBudgetUnit(runtimeBlock, maxBits, traceSharedBudgetAllocation) {
  const shared = runtimeBlock?.shared ?? null;
  const channelCount = runtimeBlock?.channelsInBlock | 0;
  if (!shared || channelCount <= 0 || channelCount > 2) {
    return null;
  }

  const { hdr, blocks } = getOrCreateBlockSolveState(runtimeBlock);
  const coreMode = (shared.coreMode ?? 0) | 0;
  const idsfCount = (shared.idsfCount ?? 0) | 0;
  const initialBitallocBits =
    bootstrapChannelBlock({
      runtimeBlock,
      hdr,
      blocks,
      quantizedSpectraByChannel: runtimeBlock.quantizedSpectraByChannel,
      bitallocSpectraByChannel: runtimeBlock.bitallocSpectraByChannel,
      blockMode: (runtimeBlock.blockMode ?? 1) | 0,
      coreMode,
      maxBits: maxBits | 0,
    }) | 0;
  const baseBudgetBits = (hdr.bitsTotalBase ?? 0) | 0;

  return {
    runtimeBlock,
    channelCount,
    coreMode,
    idsfCount,
    isMode4Block: (runtimeBlock.isMode4Block | 0) >>> 0,
    hdr,
    blocks,
    initialBitallocBits,
    baseBudgetBits,
    variableBudgetBits: (initialBitallocBits - baseBudgetBits) | 0,
    targetBits: 0,
    sharedBudgetShare: 0.0,
    usedBits: 0,
    carryBits: 0,
    initialBitallocHeaderBits: traceSharedBudgetAllocation ? collectBudgetHeaderTrace(hdr) : null,
  };
}

function classifyBudgetUnits(budgetUnits, calcTrace) {
  let fixedUnitsBits = 0;
  let sharedVarBits = 0;
  let sharedBaseBits = 0;

  for (const budgetUnit of budgetUnits) {
    if (budgetUnit.isMode4Block !== 0) {
      budgetUnit.usedBits = solveBudgetUnitBits(
        budgetUnit,
        budgetUnit.initialBitallocBits,
        calcTrace
      );
      budgetUnit.targetBits = budgetUnit.usedBits | 0;
      fixedUnitsBits = (fixedUnitsBits + budgetUnit.usedBits) | 0;
      continue;
    }

    if (budgetUnit.idsfCount <= 1) {
      budgetUnit.targetBits = budgetUnit.initialBitallocBits | 0;
      fixedUnitsBits = (fixedUnitsBits + budgetUnit.initialBitallocBits) | 0;
      continue;
    }

    sharedVarBits = (sharedVarBits + budgetUnit.variableBudgetBits) | 0;
    sharedBaseBits = (sharedBaseBits + budgetUnit.baseBudgetBits) | 0;
  }

  return { fixedUnitsBits, sharedVarBits, sharedBaseBits };
}

function assignSharedBudgetBits(budgetUnits, sharedVarBits, sharedBudgetBits, extraBudgetBits) {
  // Preserve the current NaN-share behavior when sharedVarBits is zero; the
  // multiblock regression tests pin that edge case.
  for (const budgetUnit of budgetUnits) {
    if (budgetUnit.idsfCount <= 1) {
      budgetUnit.sharedBudgetShare = 0.0;
      continue;
    }

    budgetUnit.sharedBudgetShare = Math.fround(budgetUnit.variableBudgetBits / (sharedVarBits | 0)); // Required rounding
    budgetUnit.targetBits =
      (extraBudgetBits | 0) > 0
        ? (budgetUnit.initialBitallocBits +
            roundSharedAllocationBits(extraBudgetBits * budgetUnit.sharedBudgetShare)) |
          0
        : (budgetUnit.baseBudgetBits +
            roundSharedAllocationBits(
              Math.fround(sharedBudgetBits * budgetUnit.sharedBudgetShare)
            )) |
          0;
  }
}

function solveBudgetUnitsWithCarry(budgetUnits, maxBits, calcTrace) {
  let totalUsedBits = 0;
  let carryBits = 0;

  for (let unitIndex = budgetUnits.length - 1; unitIndex >= 0; unitIndex -= 1) {
    const budgetUnit = budgetUnits[unitIndex];
    const { runtimeBlock } = budgetUnit;

    if ((carryBits | 0) > 0) {
      budgetUnit.targetBits =
        unitIndex === 0
          ? ((maxBits | 0) - (totalUsedBits | 0)) | 0
          : (budgetUnit.targetBits +
              roundSharedAllocationBits(carryBits * budgetUnit.sharedBudgetShare)) |
            0;
    }

    budgetUnit.usedBits =
      budgetUnit.isMode4Block !== 0
        ? budgetUnit.targetBits | 0
        : solveBudgetUnitBits(budgetUnit, budgetUnit.targetBits, calcTrace);
    carryBits =
      budgetUnit.isMode4Block !== 0 ? 0 : (budgetUnit.targetBits - budgetUnit.usedBits) | 0;
    budgetUnit.carryBits = carryBits | 0;

    totalUsedBits = (totalUsedBits + budgetUnit.usedBits) | 0;
    if ((carryBits | 0) < 0 || (totalUsedBits | 0) > (maxBits | 0)) {
      runtimeBlock.blockErrorCode = ATX_ENC_ERR_BITS_OVERFLOW;
    }

    if (runtimeBlock.blockErrorCode >>> 0 > 0xff) {
      return { ok: false, usedBits: totalUsedBits | 0 };
    }
  }

  return { ok: true, usedBits: totalUsedBits | 0 };
}

function buildSharedBudgetDebug(budgetUnits, maxBits, budget, preCarryTargetBits, totalUsedBits) {
  return {
    unitCount: budgetUnits.length | 0,
    maxBits: maxBits | 0,
    channelsInUnit: budgetUnits.map((budgetUnit) => budgetUnit.channelCount | 0),
    mode4BlockFlags: budgetUnits.map((budgetUnit) => budgetUnit.isMode4Block | 0),
    coreModes: budgetUnits.map((budgetUnit) => budgetUnit.coreMode | 0),
    idsfCountByUnit: budgetUnits.map((budgetUnit) => budgetUnit.idsfCount | 0),
    initialBitallocBits: budgetUnits.map((budgetUnit) => budgetUnit.initialBitallocBits | 0),
    baseBudgetBits: budgetUnits.map((budgetUnit) => budgetUnit.baseBudgetBits | 0),
    variableBudgetBits: budgetUnits.map((budgetUnit) => budgetUnit.variableBudgetBits | 0),
    fixedUnitBits: budget.fixedUnitsBits | 0,
    sharedVariableBits: budget.sharedVarBits | 0,
    sharedBaseBits: budget.sharedBaseBits | 0,
    remainingBudgetBits: budget.remainingBudgetBits | 0,
    sharedBudgetSurplusBits: budget.extraBudgetBits | 0,
    sharedVariableBudgetBits: budget.sharedBudgetBits | 0,
    sharedBudgetShares: budgetUnits.map((budgetUnit) => budgetUnit.sharedBudgetShare),
    targetBitsPreCarry: preCarryTargetBits,
    targetBitsFinal: budgetUnits.map((budgetUnit) => budgetUnit.targetBits | 0),
    usedBitsByUnit: budgetUnits.map((budgetUnit) => budgetUnit.usedBits | 0),
    carryBitsByUnit: budgetUnits.map((budgetUnit) => budgetUnit.carryBits | 0),
    initialBitallocHeaderBitsByUnit: budgetUnits.map(
      (budgetUnit) => budgetUnit.initialBitallocHeaderBits
    ),
    totalUsedBits: totalUsedBits | 0,
  };
}

/**
 * Solve the shared ATRAC3plus frame budget across one or more regular channel
 * blocks. Mode-4 and trivial blocks keep fixed targets; the rest share the
 * remaining variable pool and reclaim any underspend through backward carry.
 */
export function encodeChannelBlocksWithinBudget(
  runtimeBlocks,
  maxBits,
  traceChannelBlockSolve = null
) {
  if (!Array.isArray(runtimeBlocks)) {
    return { ok: false, usedBits: 0, hdrByUnit: [] };
  }

  // Preserve the existing env var name while keeping the local flow semantic.
  const traceSharedBudgetAllocation = readNodeEnvFlag("CARTA_TRACE_ATX_MC_ALLOC");
  const calcTrace = typeof traceChannelBlockSolve === "function" ? traceChannelBlockSolve : null;
  const unitCount = runtimeBlocks.length | 0;

  if (unitCount <= 0) {
    return { ok: true, usedBits: 0, hdrByUnit: [] };
  }
  if (unitCount > 5) {
    throw new CodecError(`unsupported ATRAC3plus multi-block unit count: ${unitCount}`);
  }

  const budgetUnits = [];
  for (const runtimeBlock of runtimeBlocks) {
    const budgetUnit = buildBudgetUnit(runtimeBlock, maxBits, traceSharedBudgetAllocation);
    if (!budgetUnit) {
      return { ok: false, usedBits: 0, hdrByUnit: [] };
    }
    budgetUnits.push(budgetUnit);
  }

  if (unitCount === 1) {
    const [budgetUnit] = budgetUnits;
    budgetUnit.usedBits = solveBudgetUnitBits(budgetUnit, maxBits, calcTrace);
    if ((budgetUnit.usedBits | 0) > (maxBits | 0)) {
      budgetUnit.runtimeBlock.blockErrorCode = ATX_ENC_ERR_BITS_OVERFLOW;
    }

    return {
      ok: budgetUnit.runtimeBlock.blockErrorCode >>> 0 <= 0xff,
      usedBits: budgetUnit.usedBits | 0,
      hdrByUnit: [budgetUnit.hdr],
    };
  }

  // First classify mode-4 and near-empty units: they keep a fixed target, while
  // the rest contribute base/variable bits to the shared multiblock pool.
  const budget = classifyBudgetUnits(budgetUnits, calcTrace);
  budget.remainingBudgetBits = (maxBits | 0) - (budget.fixedUnitsBits | 0);
  budget.sharedBudgetBits = (budget.remainingBudgetBits - budget.sharedBaseBits) | 0;
  budget.extraBudgetBits = (budget.sharedBudgetBits - budget.sharedVarBits) | 0;
  assignSharedBudgetBits(
    budgetUnits,
    budget.sharedVarBits,
    budget.sharedBudgetBits,
    budget.extraBudgetBits
  );

  const preCarryTargetBits = traceSharedBudgetAllocation
    ? budgetUnits.map((budgetUnit) => budgetUnit.targetBits | 0)
    : null;
  const encoded = solveBudgetUnitsWithCarry(budgetUnits, maxBits, calcTrace);
  if (!encoded.ok) {
    return {
      ok: false,
      usedBits: encoded.usedBits | 0,
      hdrByUnit: budgetUnits.map((budgetUnit) => budgetUnit.hdr),
    };
  }

  const debug = traceSharedBudgetAllocation
    ? buildSharedBudgetDebug(budgetUnits, maxBits, budget, preCarryTargetBits, encoded.usedBits)
    : null;

  return {
    ok: true,
    usedBits: encoded.usedBits | 0,
    hdrByUnit: budgetUnits.map((budgetUnit) => budgetUnit.hdr),
    debug,
  };
}
