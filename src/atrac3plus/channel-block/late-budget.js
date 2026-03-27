import { calcNbitsForIdctAt5, copyWlcinfoAt5 } from "../bitstream/internal.js";
import { AT5_ISPS, AT5_NSPS } from "../tables/unpack.js";
import { AT5_Y } from "./constants.js";
import { createAt5IdwlScratch } from "./construction.js";
import { getChannelWorkId } from "./core.js";
import { computeIdwlBitsAt5 } from "./packed-state.js";
import { at5AbsI32, at5S16, at5U16 } from "./primitives.js";
import {
  applyRebitallocChoice,
  planRebitallocChoice,
  restoreRebitallocState,
  snapshotRebitallocState,
  tryApplyRebitallocChoice,
} from "./rebitalloc.js";
import { getSolveScratchState } from "./spc-levels.js";

const PRUNING_STEP_COUNT_BY_MODE = new Uint8Array([0x0, 0x1, 0x2, 0x3, 0x5, 0x7, 0x0f, 0x1f]);
const PRUNED_COEFFICIENT = 0.0;
const PRUNING_EXPONENT_SLOPE = 0.03010299988090992;
const PRUNING_EXPONENT_OFFSET = 0.05000000074505806;
const PRUNING_EXPONENT_BASE = 10.0;
const PRUNING_STEP_BIAS = 0.5;
const MAX_PROBE_OFFSET = 0x3d;
const SKIP_PROBE_OFFSET = 0x3c;
const AT5_CODEC_BAND_COUNT = 32;
const AT5_PRIORITY_RAMP_START_BAND = 12;
const MAX_STEREO_REBALANCE_IDSF_GAP = 10;
const MAX_STEREO_REBALANCE_MODE = 6;
const MAX_IDWL_RAISE_OFFSET = 14;
const MAX_IDWL_RAISE_PASSES = 7;
const EMPTY_LATE_PRIORITY_ORDER = new Int32Array(0);

function isIndexArray(values) {
  return values instanceof Int32Array || values instanceof Uint32Array;
}

// Keep the in-place shell sort here: replacing it with Array#sort changed
// ATRAC3plus output enough to fail the signal-perfect regression matrix.
export function at5ShellSortDesc(values, indices, count) {
  const n = count | 0;
  if (n <= 1) {
    return;
  }

  const sortIntegers = isIndexArray(values);
  let gap = 1;
  while (gap < n) {
    gap = gap * 3 + 1;
  }
  while (gap > 1) {
    gap = (gap / 3) | 0;
    for (let i = gap; i < n; i += 1) {
      const v = sortIntegers ? values[i] | 0 : values[i];
      const idx = indices[i] | 0;

      let j = i;
      while (j >= gap && (sortIntegers ? values[j - gap] | 0 : values[j - gap]) < v) {
        values[j] = values[j - gap];
        indices[j] = indices[j - gap] | 0;
        j -= gap;
      }
      values[j] = v;
      indices[j] = idx;
    }
  }
}

function syncLatePriorityHcspecState(hdr, block, channel, channelIndex, bandCount, hasStereoPair) {
  const activeCtxId = getChannelWorkId(channel);
  const activeHcspecWork = block.hcspecWorkByCtx?.[activeCtxId] ?? null;
  const standbyHcspecWork = block.hcspecWorkByCtx?.[activeCtxId ^ 1] ?? null;
  const activeHcspecIndexByBand = activeHcspecWork?.bestIndexByBand ?? null;
  if (!isIndexArray(activeHcspecIndexByBand)) {
    return;
  }

  channel.idctTableCtx = activeCtxId;
  if (hdr.hcspecTblA) {
    hdr.hcspecTblA[channelIndex] = activeHcspecWork;
  }
  if (hdr.hcspecTblB) {
    hdr.hcspecTblB[channelIndex] = standbyHcspecWork;
  }

  const committedHcspecIndexByBand = channel?.idct?.values ?? null;
  const rebitallocMirrorIndexByBand = block?.rebitallocScratch?.specIndexByBand ?? null;
  for (const targetIndexByBand of [committedHcspecIndexByBand, rebitallocMirrorIndexByBand]) {
    const mirroredBandCount = Math.min(
      AT5_CODEC_BAND_COUNT,
      activeHcspecIndexByBand.length | 0,
      targetIndexByBand?.length | 0
    );
    if (isIndexArray(targetIndexByBand) && mirroredBandCount > 0) {
      targetIndexByBand.set(activeHcspecIndexByBand.subarray(0, mirroredBandCount), 0);
    }
  }

  if (hasStereoPair || !isIndexArray(committedHcspecIndexByBand)) {
    return;
  }

  const idwlModes = channel?.idwl?.values ?? null;
  if (!isIndexArray(idwlModes)) {
    return;
  }

  for (let band = 0; band < (bandCount | 0); band += 1) {
    if ((idwlModes[band] | 0) === 0) {
      committedHcspecIndexByBand[band] = 0;
    }
  }
}

function scoreLatePriorityBand(idsfByBand, bandLevels, band) {
  const bandIndex = band | 0;
  const baseScore = (idsfByBand[bandIndex] | 0) - ((bandIndex + 4) >> 3);
  const bandLevelBias = Math.trunc((bandLevels?.[bandIndex] ?? 0) - (bandIndex >> 4)) | 0;
  if (bandIndex < AT5_PRIORITY_RAMP_START_BAND) {
    return (baseScore + bandLevelBias) | 0;
  }

  const currentIdsf = idsfByBand[bandIndex] | 0;
  let smallestRecentRise = Infinity;
  for (let prevBand = bandIndex - 1; prevBand >= bandIndex - 4; prevBand -= 1) {
    const rise = (currentIdsf - (idsfByBand[prevBand] | 0)) | 0;
    if (rise < 0) {
      smallestRecentRise = 0;
      break;
    }
    if (rise < smallestRecentRise) {
      smallestRecentRise = rise;
    }
  }

  const priorityRampBonus = smallestRecentRise > 3 ? smallestRecentRise >> 1 : 0;
  return (baseScore + bandLevelBias + priorityRampBonus) | 0;
}

function lateMutationBitFloor(baseBits, band) {
  return Math.max(baseBits, (AT5_NSPS[band] >>> 4) | 0);
}

function syncStereoLatePriorityState(hdr, channels, bandCount) {
  const leftCommittedHcspecIndexByBand = channels?.[0]?.idct?.values ?? null;
  const rightCommittedHcspecIndexByBand = channels?.[1]?.idct?.values ?? null;
  const leftIdwlModes = channels?.[0]?.idwl?.values ?? null;
  const rightIdwlModes = channels?.[1]?.idwl?.values ?? null;
  if (
    !isIndexArray(leftCommittedHcspecIndexByBand) ||
    !isIndexArray(rightCommittedHcspecIndexByBand) ||
    !isIndexArray(leftIdwlModes) ||
    !isIndexArray(rightIdwlModes)
  ) {
    return;
  }

  const mode3DeltaFlags = hdr?.mode3DeltaFlags ?? null;
  for (let band = 0; band < (bandCount | 0); band += 1) {
    if ((leftIdwlModes[band] | 0) === 0 && (rightIdwlModes[band] | 0) === 0) {
      leftCommittedHcspecIndexByBand[band] = 0;
      rightCommittedHcspecIndexByBand[band] = 0;
      continue;
    }
    if ((mode3DeltaFlags?.[band] ?? 0) === 1) {
      rightCommittedHcspecIndexByBand[band] = 1;
    }
  }
}

function sortStereoLatePriorityBands(
  bandScores,
  bandCount,
  stereoBandCount,
  stereoScores,
  stereoBandsByPriority
) {
  if (stereoBandCount <= 0) {
    return;
  }

  const rightChannelOffset = bandCount | 0;
  // Derive stereo scores before sorting `bandScores`; later stages depend on
  // the original left/right band pairing, not the flattened order.
  for (let band = 0; band < (stereoBandCount | 0); band += 1) {
    stereoScores[band] = (bandScores[band] + bandScores[rightChannelOffset + band]) | 0;
    stereoBandsByPriority[band] = band;
  }
  at5ShellSortDesc(stereoScores, stereoBandsByPriority, stereoBandCount);
}

/**
 * Mirrors the live HCSPEC choice into the late-budget work tables, then
 * rebuilds the per-channel and stereo priority orderings.
 *
 * @param {object} latePriority
 * @param {Int32Array} latePriority.bandScores
 * @param {Int32Array} latePriority.orderedBandSlots
 * @param {Int32Array} latePriority.stereoScores
 * @param {Int32Array} latePriority.stereoBandsByPriority
 */
export function prepareLatePriorityOrder(
  hdr,
  blocks,
  channels,
  channelCount,
  bandCount,
  latePriority
) {
  const channelTotal = channelCount | 0;
  const bands = bandCount | 0;
  const hasStereoPair = channelTotal === 2;
  const bandSlotCount = channelTotal * bands;
  const stereoIntensityBandIndex = channels?.[0]?.sharedAux?.intensityBand?.[0] ?? 0;
  const stereoBandCount = hasStereoPair
    ? Math.min((AT5_Y[stereoIntensityBandIndex >>> 0] ?? 0) >>> 0, bands)
    : 0;
  const bandScores = latePriority?.bandScores ?? null;
  const orderedBandSlots = latePriority?.orderedBandSlots ?? null;
  const stereoScores = latePriority?.stereoScores ?? null;
  const stereoBandsByPriority = latePriority?.stereoBandsByPriority ?? null;

  if (!(bandScores instanceof Int32Array) && !Array.isArray(bandScores)) {
    throw new TypeError("prepareLatePriorityOrder: bandScores must be an Int32Array or array");
  }
  bandScores.fill(0, 0, bandSlotCount);
  for (let bandSlot = 0; bandSlot < bandSlotCount; bandSlot += 1) {
    orderedBandSlots[bandSlot] = bandSlot;
  }

  for (let ch = 0; ch < channelTotal; ch += 1) {
    const channel = channels[ch];
    const block = blocks[ch];
    if (!channel || !block) {
      continue;
    }

    syncLatePriorityHcspecState(hdr, block, channel, ch, bands, hasStereoPair);

    const idsfByBand = channel?.idsf?.values ?? null;
    if (!isIndexArray(idsfByBand)) {
      continue;
    }

    const bandLevels = block?.bandLevels ?? null;
    const channelOffset = ch * bands;
    for (let band = 0; band < bands; band += 1) {
      bandScores[channelOffset + band] = scoreLatePriorityBand(idsfByBand, bandLevels, band);
    }
  }

  if (hasStereoPair) {
    syncStereoLatePriorityState(hdr, channels, bands);
    sortStereoLatePriorityBands(
      bandScores,
      bands,
      stereoBandCount,
      stereoScores,
      stereoBandsByPriority
    );
  }

  at5ShellSortDesc(bandScores, orderedBandSlots, bandSlotCount);
  latePriority.stereoBandCount = stereoBandCount;
  return latePriority;
}

/**
 * Tries a single one-step IDWL raise for one band and channel. The raised
 * candidate repacks both rebitalloc and IDWL state, and the function rolls the
 * whole probe back unless the combined result still fits the remaining budget.
 */
export function tryRaiseIdwlModeWithinBudget(lateIdwlRaise, band, channelIndex) {
  const {
    hdr = null,
    blocks = null,
    channels = null,
    channelCount: totalChannels = 0,
    bitBudget = 0,
    rebasedIdctBitCount = 0,
    encodeMode = 0,
    activeIdwlScratchByChannel = null,
    rollbackIdwlScratchByChannel = null,
  } = lateIdwlRaise ?? {};
  const bandIndex = band | 0;
  const targetChannelIndex = channelIndex | 0;
  const block = blocks?.[targetChannelIndex] ?? null;
  const channel = channels?.[targetChannelIndex] ?? null;
  const idwlModes = channel?.idwl?.values ?? null;
  if (!hdr || !block || !channel || !idwlModes) {
    return false;
  }

  const committedIdwlMode = idwlModes[bandIndex] | 0;
  const committedIdwlBitCount = at5U16(hdr.bitsIdwl ?? 0);
  const committedHcspecIndex = (channel.idct?.values?.[bandIndex] ?? 0) | 0;
  const rebitallocScratch =
    hdr.rebitallocProbeScratch && typeof hdr.rebitallocProbeScratch === "object"
      ? hdr.rebitallocProbeScratch
      : (hdr.rebitallocProbeScratch = {});
  const probeSnapshot = snapshotRebitallocState(
    blocks,
    channels,
    totalChannels,
    rebitallocScratch.probeSnapshot ?? null
  );
  rebitallocScratch.probeSnapshot = probeSnapshot;

  // Probe the one-step IDWL raise before touching any committed bit totals.
  const raisedIdwlMode = committedIdwlMode + 1;
  idwlModes[bandIndex] = raisedIdwlMode;
  const probeChoice = planRebitallocChoice(
    hdr,
    blocks,
    channels,
    totalChannels,
    targetChannelIndex,
    bandIndex,
    raisedIdwlMode,
    committedHcspecIndex
  );

  copyWlcinfoAt5(
    activeIdwlScratchByChannel,
    rollbackIdwlScratchByChannel,
    totalChannels,
    encodeMode,
    targetChannelIndex
  );

  const raisedIdwlBitCount = at5U16(
    computeIdwlBitsAt5(hdr, channels, blocks, totalChannels, targetChannelIndex, bandIndex) | 0
  );
  const raisedIdwlBitDelta = at5S16(raisedIdwlBitCount - committedIdwlBitCount);
  const raisedTotalBits = at5S16(
    at5S16(hdr.bitsTotal ?? 0) + at5S16((probeChoice.bitDelta | 0) + raisedIdwlBitDelta)
  );

  // Rejecting the probe must restore both IDWL work tables and the shared
  // rebitalloc scratch that `planRebitallocChoice` touched.
  if (raisedTotalBits > (bitBudget | 0)) {
    copyWlcinfoAt5(
      rollbackIdwlScratchByChannel,
      activeIdwlScratchByChannel,
      totalChannels,
      encodeMode,
      targetChannelIndex
    );
    idwlModes[bandIndex] = committedIdwlMode;
    restoreRebitallocState(blocks, channels, probeSnapshot);
    return false;
  }

  const totalBitsAfterRebitallocCommit = applyRebitallocChoice(
    hdr,
    block,
    channel,
    targetChannelIndex,
    bandIndex,
    probeChoice
  );

  // Keep the rebased IDCT total as the fixed anchor for late-budget raises;
  // after the shared rebitalloc commit, move the base/ctx split back to that
  // anchor and add the IDWL delta on top.
  const idctDeltaFromRebasedAnchor = (probeChoice.idctBitCount | 0) - (rebasedIdctBitCount | 0);
  const activeCtxId = getChannelWorkId(channel);
  hdr.bitsTotalBase = at5U16(
    (hdr.bitsTotalBase ?? 0) + at5S16(raisedIdwlBitDelta - idctDeltaFromRebasedAnchor)
  );
  if (block.bitDeltaByCtx instanceof Uint16Array) {
    block.bitDeltaByCtx[activeCtxId] = at5U16(
      block.bitDeltaByCtx[activeCtxId] + idctDeltaFromRebasedAnchor
    );
  }
  hdr.bitsIdwl = raisedIdwlBitCount;
  hdr.bitsTotal = at5U16(totalBitsAfterRebitallocCommit + raisedIdwlBitDelta);
  return true;
}

/**
 * Primes the late IDWL raise scratch from the currently committed IDCT state,
 * then rebases the live totals onto that IDCT anchor before any raises begin.
 */
function createLateIdwlRaiseContext(hdr, blocks, channels, totalChannels, totalBands, bitBudget) {
  const raiseAllowedByChannel = getSolveScratchState(hdr).raiseAllowedByChannel;
  for (const allowedBands of raiseAllowedByChannel) {
    allowedBands.fill(1, 0, totalBands);
  }

  const rollbackScratchBytes = new Uint8Array(blocks?.[0]?.idwlWork?.length ?? 0x290);
  const activeIdwlScratchByChannel = new Array(totalChannels);
  const rollbackIdwlScratchByChannel = new Array(totalChannels);
  for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
    const block = blocks?.[channelIndex] ?? null;
    const channel = channels?.[channelIndex] ?? null;
    const committedIdctModes = channel?.idct?.values ?? null;
    const rebitallocMirrorModes = block?.rebitallocScratch?.specIndexByBand ?? null;
    if (
      rebitallocMirrorModes instanceof Int32Array &&
      (committedIdctModes instanceof Int32Array || committedIdctModes instanceof Uint32Array)
    ) {
      rebitallocMirrorModes.set(committedIdctModes.subarray(0, rebitallocMirrorModes.length));
    }

    activeIdwlScratchByChannel[channelIndex] = block?.idwlScratch ?? null;
    rollbackIdwlScratchByChannel[channelIndex] =
      channel && block ? createAt5IdwlScratch(rollbackScratchBytes) : null;
  }

  const rebasedIdctBitCount = calcNbitsForIdctAt5(channels, blocks, totalChannels, 1) | 0;
  const idctRebaseDelta = at5S16(at5S16(hdr.bitsIdct ?? 0) - at5S16(rebasedIdctBitCount));
  hdr.bitsTotalBase = at5U16(at5S16(hdr.bitsTotalBase ?? 0) - idctRebaseDelta);
  hdr.bitsIdct = at5U16(rebasedIdctBitCount);
  hdr.bitsTotal = at5U16(at5S16(hdr.bitsTotal ?? 0) - idctRebaseDelta);

  return {
    hdr,
    blocks,
    channels,
    channelCount: totalChannels,
    bitBudget,
    rebasedIdctBitCount,
    encodeMode: (channels?.[0]?.blockState?.encodeMode ?? 0) | 0,
    activeIdwlScratchByChannel,
    rollbackIdwlScratchByChannel,
    raiseAllowedByChannel,
  };
}

/**
 * Probes a one-step late-budget quant-offset relaxation for one band. The
 * stored offset only changes when the matching rebitalloc choice still fits
 * the live bit budget.
 */
function tryRelaxQuantOffsetWithinBudget(
  hdr,
  blocks,
  channels,
  totalChannels,
  bitBudget,
  channelIndex,
  band
) {
  const block = blocks?.[channelIndex] ?? null;
  const channel = channels?.[channelIndex] ?? null;
  const committedOffset = block?.quantOffsetByBand?.[band] ?? 0;
  const committedIdwlMode = channel?.idwl?.values?.[band] ?? 0;
  if (!block || !channel || committedOffset <= 0 || committedIdwlMode <= 0) {
    return null;
  }

  block.quantOffsetByBand[band] = committedOffset - 1;
  const acceptedTotalBits = tryApplyRebitallocChoice(
    hdr,
    blocks,
    channels,
    totalChannels,
    channelIndex,
    band,
    committedIdwlMode,
    (channel.idct?.values?.[band] ?? 0) | 0,
    {
      requireImprovement: false,
      maxTotalBits: bitBudget,
      committedHcspecIndexByBand: channel.idct?.values ?? null,
    }
  );
  if (acceptedTotalBits !== null) {
    return acceptedTotalBits;
  }

  block.quantOffsetByBand[band] = committedOffset;
  return null;
}

/**
 * Runs the late-budget IDWL raise sweep. It first rebalances safe stereo
 * pairs toward the weaker side, then spends any remaining bit headroom on the
 * globally ordered per-band raises.
 */
export function raiseIdwlModesWithinBudget(
  hdr,
  blocks,
  channels,
  channelCount,
  bandCount,
  bitLimit,
  latePriority
) {
  const totalChannels = channelCount | 0;
  if (totalChannels <= 0) {
    return 0;
  }

  const totalBands = bandCount | 0;
  const bitBudget = bitLimit | 0;
  const baseBits = (hdr.baseBits ?? 0) | 0;
  const maxLateBudgetTotalBits = bitBudget - baseBits;
  const bandSlotCount = (totalBands * totalChannels) | 0;
  const stereoBandsByPriority =
    latePriority?.stereoBandsByPriority?.subarray(0, latePriority?.stereoBandCount | 0) ??
    EMPTY_LATE_PRIORITY_ORDER;
  const orderedBandSlots =
    latePriority?.orderedBandSlots?.subarray(0, bandSlotCount) ?? EMPTY_LATE_PRIORITY_ORDER;
  const lateIdwlRaise = createLateIdwlRaiseContext(
    hdr,
    blocks,
    channels,
    totalChannels,
    totalBands,
    bitBudget
  );
  const { raiseAllowedByChannel } = lateIdwlRaise;
  let totalBits = at5S16(hdr.bitsTotal ?? 0);
  if (totalBits > maxLateBudgetTotalBits) {
    return totalBits;
  }

  // Phase 1: stereo pair rebalancing nudges the weaker side upward before the
  // global priority sweep spends the remaining headroom.
  const leftModes = channels?.[0]?.idwl?.values ?? null;
  const rightModes = channels?.[1]?.idwl?.values ?? null;
  const leftIdsf = channels?.[0]?.idsf?.values ?? null;
  const rightIdsf = channels?.[1]?.idsf?.values ?? null;
  if (stereoBandsByPriority.length > 0 && leftModes && rightModes && leftIdsf && rightIdsf) {
    for (const band of stereoBandsByPriority) {
      const leftMode = leftModes[band] | 0;
      const rightMode = rightModes[band] | 0;
      const weakerMode = Math.min(leftMode, rightMode);
      const mutationBitFloor = lateMutationBitFloor(baseBits, band);
      const cannotRebalanceStereoPair =
        weakerMode <= 0 ||
        leftMode === rightMode ||
        weakerMode > MAX_STEREO_REBALANCE_MODE ||
        totalBits + mutationBitFloor > bitBudget ||
        at5AbsI32((leftIdsf[band] | 0) - (rightIdsf[band] | 0)) > MAX_STEREO_REBALANCE_IDSF_GAP;
      if (cannotRebalanceStereoPair) {
        continue;
      }

      const weakerChannelIndex = leftMode > rightMode ? 1 : 0;
      if (tryRaiseIdwlModeWithinBudget(lateIdwlRaise, band, weakerChannelIndex)) {
        totalBits = at5S16(hdr.bitsTotal ?? 0);
      }
    }
  }

  if (totalBits > maxLateBudgetTotalBits) {
    return totalBits;
  }

  // Phase 2: walk the late priority order until one full pass fails to buy any
  // more legal raises.
  for (let passIndex = 0; passIndex < MAX_IDWL_RAISE_PASSES; passIndex += 1) {
    let raisedAnyBand = false;
    for (const bandSlot of orderedBandSlots) {
      const channelIndex = (bandSlot / totalBands) | 0;
      const band = bandSlot % totalBands;
      const block = blocks?.[channelIndex] ?? null;
      const currentIdwlMode = channels?.[channelIndex]?.idwl?.values?.[band] ?? 0;
      const allowedBands = raiseAllowedByChannel[channelIndex] ?? null;
      const maxIdwlMode = block?.maxQuantModeByBand?.[band] ?? 0;
      const mutationBitFloor = lateMutationBitFloor(baseBits, band);
      const cannotRaiseBand =
        !allowedBands ||
        allowedBands[band] !== 1 ||
        !block ||
        currentIdwlMode <= 0 ||
        currentIdwlMode >= maxIdwlMode ||
        (block.quantOffsetByBand?.[band] ?? 0) > MAX_IDWL_RAISE_OFFSET ||
        totalBits + mutationBitFloor > bitBudget;
      if (cannotRaiseBand) {
        continue;
      }

      if (!tryRaiseIdwlModeWithinBudget(lateIdwlRaise, band, channelIndex)) {
        allowedBands[band] = 0;
        continue;
      }

      totalBits = at5S16(hdr.bitsTotal ?? 0);
      raisedAnyBand = true;
    }

    if (!raisedAnyBand) {
      break;
    }
  }

  return totalBits;
}

/**
 * Runs the late-budget offset-relaxation sweep. Each accepted change lowers
 * one band's quant offset and commits the matching rebitalloc delta
 * immediately.
 */
export function relaxQuantOffsetsWithinBudget(
  hdr,
  blocks,
  channels,
  channelCount,
  bandCount,
  bitLimit,
  latePriority
) {
  const totalChannels = channelCount | 0;
  const totalBands = bandCount | 0;
  const bitBudget = bitLimit | 0;
  const baseBits = (hdr.baseBits ?? 0) | 0;
  const maxLateBudgetTotalBits = bitBudget - baseBits;
  const orderedBandSlots =
    latePriority?.orderedBandSlots?.subarray(0, (totalBands * totalChannels) | 0) ??
    EMPTY_LATE_PRIORITY_ORDER;
  let totalBits = at5S16(hdr.bitsTotal ?? 0);
  if (totalBits > maxLateBudgetTotalBits) {
    return totalBits;
  }

  for (const bandSlot of orderedBandSlots) {
    const channelIndex = (bandSlot / totalBands) | 0;
    const band = bandSlot % totalBands;
    if (totalBits + lateMutationBitFloor(baseBits, band) > bitBudget) {
      continue;
    }

    const acceptedTotalBits = tryRelaxQuantOffsetWithinBudget(
      hdr,
      blocks,
      channels,
      totalChannels,
      bitBudget,
      channelIndex,
      band
    );
    if (acceptedTotalBits === null) {
      continue;
    }

    totalBits = acceptedTotalBits;
  }

  return totalBits;
}

/**
 * Runs the late coefficient-pruning sweep, progressively zeroing the weakest
 * coefficients in higher bands until a matching rebitalloc probe buys enough
 * bits to fit the block budget. This stage uses stronger quant offsets only
 * as virtual pruning thresholds: it commits the surviving spectrum and chosen
 * rebitalloc state, but it does not rewrite the band's stored quant offset.
 */
export function pruneCoefficientsWithinBudget(
  hdr,
  blocks,
  quantizedSpectraByChannel,
  channels,
  channelCount,
  bandCount,
  bitLimit
) {
  const totalChannels = channelCount | 0;
  if (!hdr || totalChannels <= 0) {
    return 0;
  }

  const totalBands = bandCount | 0;
  const bitBudget = bitLimit | 0;
  const { sortedMagnitudes, sortedIndices, acceptedBandSnapshot } =
    getSolveScratchState(hdr).coefficientPruning;
  let totalBits = at5S16(hdr.bitsTotal ?? 0);

  if (totalBits <= bitBudget) {
    return totalBits;
  }

  for (let band = totalBands - 1; band >= 0 && totalBits > bitBudget; band -= 1) {
    for (
      let channelIndex = 0;
      channelIndex < totalChannels && totalBits > bitBudget;
      channelIndex += 1
    ) {
      const block = blocks?.[channelIndex] ?? null;
      const channel = channels?.[channelIndex] ?? null;
      const spectrum = quantizedSpectraByChannel?.[channelIndex] ?? null;
      const quantMode = channel?.idwl?.values?.[band] | 0;
      const committedQuantOffset = (block?.quantOffsetByBand?.[band] ?? 0) | 0;
      if (
        !block ||
        quantMode <= 0 ||
        !(spectrum instanceof Float32Array) ||
        committedQuantOffset > SKIP_PROBE_OFFSET
      ) {
        continue;
      }

      const bandStart = AT5_ISPS[band] >>> 0;
      const coeffCount = AT5_NSPS[band] >>> 0;
      const liveBandSpectrum = spectrum.subarray(bandStart, bandStart + coeffCount);
      const acceptedSpectrum = acceptedBandSnapshot.subarray(0, coeffCount);
      const committedHcspecIndex = (channel?.idct?.values?.[band] ?? 0) | 0;
      const pruningStepCount = PRUNING_STEP_COUNT_BY_MODE[quantMode & 7] | 0;
      const normalizedBandPeak = block.normalizedBandPeaks?.[band] ?? 0;
      let totalBitsAfterBand = totalBits;
      let acceptedFrontierNeedsResort = true;

      acceptedSpectrum.set(liveBandSpectrum, 0);
      for (
        let probeQuantOffset = committedQuantOffset + 1;
        probeQuantOffset <= MAX_PROBE_OFFSET && totalBitsAfterBand > bitBudget;
        probeQuantOffset += 1
      ) {
        if (acceptedFrontierNeedsResort) {
          for (let i = 0; i < coeffCount; i += 1) {
            sortedMagnitudes[i] = Math.abs(acceptedSpectrum[i]);
            sortedIndices[i] = i | 0;
          }
          at5ShellSortDesc(sortedMagnitudes, sortedIndices, coeffCount);
          acceptedFrontierNeedsResort = false;
        }

        const thresholdExponent =
          probeQuantOffset * PRUNING_EXPONENT_SLOPE + PRUNING_EXPONENT_OFFSET;
        const pruningThreshold =
          ((Math.pow(PRUNING_EXPONENT_BASE, thresholdExponent) * PRUNING_STEP_BIAS) /
            (pruningStepCount + PRUNING_STEP_BIAS)) *
          normalizedBandPeak;

        // Rejected probes do not advance the frontier, so stronger probes
        // always restart from the last accepted spectrum rather than
        // compounding damage.
        liveBandSpectrum.set(acceptedSpectrum, 0);
        for (let i = coeffCount - 1; i >= 0; i -= 1) {
          if (sortedMagnitudes[i] >= pruningThreshold) {
            break;
          }
          liveBandSpectrum[sortedIndices[i] | 0] = PRUNED_COEFFICIENT;
        }

        const acceptedTotalBits = tryApplyRebitallocChoice(
          hdr,
          blocks,
          channels,
          totalChannels,
          channelIndex,
          band,
          quantMode,
          committedHcspecIndex
        );
        if (acceptedTotalBits === null) {
          continue;
        }

        totalBitsAfterBand = acceptedTotalBits;
        acceptedSpectrum.set(liveBandSpectrum, 0);
        acceptedFrontierNeedsResort = true;
      }

      liveBandSpectrum.set(acceptedSpectrum, 0);
      totalBits = totalBitsAfterBand;
    }
  }

  return totalBits;
}
