import { calcNbitsForIdctAt5 } from "../bitstream/internal.js";
import { AT5_HC_SPEC_LIMIT_BY_TBL } from "../tables/encode-bitalloc.js";
import { AT5_ISPS, AT5_NSPS } from "../tables/unpack.js";
import { at5RecomputeCtxCosts, at5RecomputeTotalBits, getChannelWorkId } from "./core.js";
import { at5S16, at5U16 } from "./primitives.js";
import { quantNontoneNspecsAt5 } from "./quant-cost.js";

const AT5_HCSPEC_COSTS_PER_BAND = 8;
const AT5_LOW_BAND_COUNT = 8;
const AT5_SIMPLE_REBITALLOC_COREMODE_LIMIT = 9;
const AT5_LOW_BAND_EXTENDED_OFFSET_LIMIT = 3;
const AT5_MAX_QUANT_OFFSET = 0x0f;
const MAX_REFINE_PASSES = 15;
const MAX_REBITALLOC_OFFSET = 15;
const LOW_BAND_GUARD_LIMIT = 8;
const LOW_BAND_GUARD_CORE_MODE = 9;
const GUARDED_LOW_BAND_OFFSET = 3;

function rebitallocProbeScratch(hdr) {
  if (!hdr || typeof hdr !== "object") {
    return null;
  }

  const existing = hdr.rebitallocProbeScratch;
  if (existing && typeof existing === "object") {
    return existing;
  }

  const created = {};
  hdr.rebitallocProbeScratch = created;
  return created;
}

function nextRebitallocQuantOffset(currentOffset, isLowBand, coreMode) {
  if (isLowBand) {
    if (coreMode < AT5_SIMPLE_REBITALLOC_COREMODE_LIMIT) {
      return Math.min((currentOffset + 1) | 0, AT5_MAX_QUANT_OFFSET);
    }
    return currentOffset < AT5_LOW_BAND_EXTENDED_OFFSET_LIMIT
      ? (currentOffset + 1) | 0
      : currentOffset;
  }

  if (currentOffset < AT5_MAX_QUANT_OFFSET) {
    return (currentOffset + 1) | 0;
  }

  // Saturated high-band offsets fall back to the trimmed value without
  // reopening the context-cost search.
  return AT5_MAX_QUANT_OFFSET;
}

function rebitallocChoiceScore(idctBitCount, bandCost) {
  return at5S16((idctBitCount | 0) + at5S16(bandCost ?? 0));
}

export function snapshotRebitallocState(blocks, channels, channelCount, outSnapshot = null) {
  const count = Math.max(0, channelCount | 0);
  const out = Array.isArray(outSnapshot) ? outSnapshot : [];
  out.length = count;
  for (let ch = 0; ch < count; ch += 1) {
    const rebitallocBytes = blocks?.[ch]?.rebitallocScratch?.bytes;
    const channel = channels?.[ch] ?? null;
    const idctState = channel?.idct ?? null;
    let snapshot = out[ch];
    if (!snapshot || typeof snapshot !== "object") {
      snapshot = {};
      out[ch] = snapshot;
    }

    if (rebitallocBytes instanceof Uint8Array) {
      let bytesCopy = snapshot.rebitallocBytes;
      if (!(bytesCopy instanceof Uint8Array) || bytesCopy.length !== rebitallocBytes.length) {
        bytesCopy = new Uint8Array(rebitallocBytes.length);
        snapshot.rebitallocBytes = bytesCopy;
      }
      bytesCopy.set(rebitallocBytes);
    } else {
      snapshot.rebitallocBytes = null;
    }

    snapshot.idctModeSelect = channel?.idctModeSelect ?? 0;
    snapshot.idctFlag = idctState?.flag ?? 0;
    snapshot.idctBandCount = idctState?.count ?? 0;
  }
  return out;
}

export function restoreRebitallocState(blocks, channels, snapshot) {
  const channelStates = Array.isArray(snapshot) ? snapshot : [];

  for (let ch = 0; ch < channelStates.length; ch += 1) {
    const savedState = channelStates[ch];
    const rebitallocBytes = blocks?.[ch]?.rebitallocScratch?.bytes;
    if (
      savedState?.rebitallocBytes instanceof Uint8Array &&
      rebitallocBytes instanceof Uint8Array
    ) {
      rebitallocBytes.set(savedState.rebitallocBytes);
    }

    const channel = channels?.[ch] ?? null;
    if (!channel || !savedState) {
      continue;
    }

    channel.idctModeSelect = (savedState.idctModeSelect | 0) >>> 0;
    if (channel.idct) {
      channel.idct.modeSelect = channel.idctModeSelect;
      channel.idct.flag = savedState.idctFlag | 0;
      channel.idct.count = (savedState.idctBandCount | 0) >>> 0;
    }
  }
}

/**
 * Commits one chosen rebitalloc HCSPEC index and updates the corresponding
 * IDCT totals, per-context delta budget, and optional committed-index mirror.
 */
export function applyRebitallocChoice(
  hdr,
  block,
  channel,
  channelIndex,
  band,
  choice,
  committedHcspecIndexByBand = null
) {
  const bandIndex = band | 0;
  const idctValues = channel?.idct?.values ?? null;
  const targetHcspecIndex = choice.hcspecIndex | 0;
  const activeCosts = hdr?.hcspecTblA?.[channelIndex | 0]?.costsByBand ?? null;
  const candidateCosts = hdr?.hcspecTblB?.[channelIndex | 0]?.costsByBand ?? null;
  if (activeCosts && candidateCosts) {
    const bandCostOffset = bandIndex * AT5_HCSPEC_COSTS_PER_BAND;
    activeCosts.set(
      candidateCosts.subarray(bandCostOffset, bandCostOffset + AT5_HCSPEC_COSTS_PER_BAND),
      bandCostOffset
    );
  }

  if (committedHcspecIndexByBand && bandIndex < (committedHcspecIndexByBand.length | 0)) {
    committedHcspecIndexByBand[bandIndex] = targetHcspecIndex;
  }
  if (idctValues && bandIndex < (idctValues.length | 0)) idctValues[bandIndex] = targetHcspecIndex;

  const prevIdctBits = at5S16(hdr.bitsIdct ?? 0);
  const nextIdctBits = at5S16(choice.idctBitCount);
  const deltaIdctBits = at5S16(nextIdctBits - prevIdctBits);

  hdr.bitsTotalBase = at5U16((hdr.bitsTotalBase ?? 0) + deltaIdctBits);
  hdr.bitsIdct = at5U16(nextIdctBits);

  const ctxId = getChannelWorkId(channel);
  const bitDelta = at5S16(choice.bitDelta);
  const deltaVarBits = at5S16(bitDelta - deltaIdctBits);
  if (block?.bitDeltaByCtx instanceof Uint16Array)
    block.bitDeltaByCtx[ctxId] = at5U16(block.bitDeltaByCtx[ctxId] + deltaVarBits);

  const totalBits = at5S16((hdr.bitsTotal ?? 0) + bitDelta);
  hdr.bitsTotal = at5U16(totalBits);
  return totalBits;
}

/**
 * Probes one rebitalloc change and applies it only if it fits the requested
 * budget and, unless explicitly disabled, improves the total bit count. The
 * caller must roll back any extra probe-only state it changed before calling.
 */
export function tryApplyRebitallocChoice(
  hdr,
  blocks,
  channels,
  channelCount,
  channelIndex,
  band,
  quantMode,
  committedHcspecIndex,
  {
    requireImprovement = true,
    maxTotalBits = Number.POSITIVE_INFINITY,
    committedHcspecIndexByBand = null,
  } = {}
) {
  const totalChannels = Math.max(0, channelCount | 0);
  const targetChannelIndex = channelIndex | 0;
  const bandIndex = band | 0;
  const scratch = rebitallocProbeScratch(hdr);
  const probeSnapshot = snapshotRebitallocState(
    blocks,
    channels,
    totalChannels,
    scratch?.probeSnapshot ?? null
  );
  if (scratch) {
    scratch.probeSnapshot = probeSnapshot;
  }
  const probeChoice = planRebitallocChoice(
    hdr,
    blocks,
    channels,
    totalChannels,
    targetChannelIndex,
    bandIndex,
    quantMode | 0,
    committedHcspecIndex | 0
  );
  const bitDelta = at5S16(probeChoice.bitDelta ?? 0);
  const probedTotalBits = at5S16((hdr?.bitsTotal ?? 0) + bitDelta);
  const wouldOverflowBudget = probedTotalBits > maxTotalBits;
  const wouldMissImprovementGate = requireImprovement && bitDelta >= 0;
  if (wouldOverflowBudget || wouldMissImprovementGate) {
    restoreRebitallocState(blocks, channels, probeSnapshot);
    return null;
  }

  return applyRebitallocChoice(
    hdr,
    blocks?.[targetChannelIndex] ?? null,
    channels?.[targetChannelIndex] ?? null,
    targetChannelIndex,
    bandIndex,
    probeChoice,
    committedHcspecIndexByBand
  );
}

/**
 * Refreshes the probe work table for one band, then plans the cheapest
 * HCSPEC choice worth committing. The winning scratch index stays primed in
 * the rebitalloc mirror so a later apply step can commit it directly.
 */
export function planRebitallocChoice(
  hdr,
  blocks,
  channels,
  channelCount,
  channelIndex,
  band,
  quantMode,
  committedHcspecIndex
) {
  const bandIndex = band | 0;
  const totalChannels = Math.max(0, channelCount | 0);
  const committedHcspecIndexValue = committedHcspecIndex | 0;
  const targetChannelIndex = channelIndex | 0;
  const channel = channels?.[targetChannelIndex] ?? null;
  const activeCtxId = getChannelWorkId(channel);
  const block = blocks?.[targetChannelIndex] ?? null;
  const committedWork = hdr?.hcspecTblA?.[targetChannelIndex] ?? null;
  const probeWork = hdr?.hcspecTblB?.[targetChannelIndex] ?? null;
  const committedBandCosts = committedWork?.costsByBand;
  const probeBandCosts = probeWork?.costsByBand;
  if (
    !block ||
    !hdr ||
    !(committedBandCosts instanceof Uint16Array) ||
    !(probeBandCosts instanceof Uint16Array)
  ) {
    return { bitDelta: 0, hcspecIndex: committedHcspecIndexValue, idctBitCount: 0 };
  }

  const tableSearchLimit = AT5_HC_SPEC_LIMIT_BY_TBL[(hdr.tblIndex ?? 0) | 0] | 0;
  const committedIdctBitCount = (hdr.bitsIdct ?? 0) & 0xffff;
  const bandCostOffset = bandIndex * AT5_HCSPEC_COSTS_PER_BAND;
  const committedBandCostIndex = (bandCostOffset + committedHcspecIndexValue) | 0;
  const committedScore = rebitallocChoiceScore(
    committedIdctBitCount,
    committedBandCosts[committedBandCostIndex]
  );

  // Refresh the probe work table around the band's current quant offset before
  // deciding whether an alternate HCSPEC index is worth repacking IDCT for.
  const coeffStart = AT5_ISPS[bandIndex] >>> 0;
  const coeffCount = AT5_NSPS[bandIndex] >>> 0;
  const bandSpectrum =
    block?.quantizedSpectrum instanceof Float32Array
      ? block.quantizedSpectrum.subarray(coeffStart)
      : null;
  quantNontoneNspecsAt5(
    activeCtxId,
    bandIndex,
    quantMode | 0,
    block.quantOffsetByBand?.[bandIndex] ?? 0,
    block.normalizedBandPeaks?.[bandIndex] ?? 0,
    coeffCount,
    bandSpectrum,
    probeWork,
    block
  );
  const refreshedCommittedScore = rebitallocChoiceScore(
    committedIdctBitCount,
    probeBandCosts[committedBandCostIndex]
  );
  const refreshedCommittedChoice = {
    bitDelta: at5S16(refreshedCommittedScore - committedScore),
    hcspecIndex: committedHcspecIndexValue,
    idctBitCount: committedIdctBitCount | 0,
  };

  if (tableSearchLimit <= 0) {
    return refreshedCommittedChoice;
  }

  let candidateBandCost = at5S16(probeBandCosts[bandCostOffset] ?? 0);
  let candidateHcspecIndex = 0;
  for (let candidateIndex = 1; candidateIndex < tableSearchLimit; candidateIndex += 1) {
    const bandCost = at5S16(probeBandCosts[(bandCostOffset + candidateIndex) | 0] ?? 0);
    if (bandCost < candidateBandCost) {
      candidateBandCost = bandCost;
      candidateHcspecIndex = candidateIndex;
    }
  }
  if (candidateHcspecIndex === committedHcspecIndexValue) {
    return refreshedCommittedChoice;
  }

  // Probing an alternate HCSPEC index repacks IDCT state, so losing probes
  // must restore both the scratch mirror and the computed pack metadata.
  const scratch = rebitallocProbeScratch(hdr);
  const alternateProbeSnapshot = snapshotRebitallocState(
    blocks,
    channels,
    totalChannels,
    scratch?.alternateProbeSnapshot ?? null
  );
  if (scratch) {
    scratch.alternateProbeSnapshot = alternateProbeSnapshot;
  }
  block.rebitallocScratch.specIndexByBand[bandIndex] = candidateHcspecIndex;

  const alternateIdctBitCount = calcNbitsForIdctAt5(channels, blocks, totalChannels, 1) | 0;
  const candidateScore = rebitallocChoiceScore(alternateIdctBitCount, candidateBandCost);
  if (candidateScore >= refreshedCommittedScore) {
    restoreRebitallocState(blocks, channels, alternateProbeSnapshot);
    return refreshedCommittedChoice;
  }

  return {
    bitDelta: at5S16(candidateScore - committedScore),
    hcspecIndex: candidateHcspecIndex,
    idctBitCount: alternateIdctBitCount | 0,
  };
}

/**
 * Walks overflow recovery from the highest active bands downward, raising
 * quant offsets until the block fits or the header's rebitalloc step budget is
 * exhausted.
 */
export function at5AdjustQuantOffsetsRebitalloc(
  blocks,
  channels,
  hdr,
  channelCount,
  bandCount,
  coreMode,
  bitLimit
) {
  const totalBands = bandCount | 0;
  const maxOffsetRaiseSteps = (hdr?.cbIterLimit ?? 0) | 0;
  const firstRaisedBand = (hdr?.cbStartBand ?? 0) | 0;
  if (maxOffsetRaiseSteps <= 0 || firstRaisedBand >= totalBands) {
    return;
  }

  const totalChannels = channelCount | 0;
  const coreModeValue = coreMode | 0;
  const bitBudget = bitLimit | 0;
  let totalBits = (hdr?.bitsTotal ?? 0) | 0;
  if (totalBits <= bitBudget) {
    return;
  }

  totalBits = at5RecomputeTotalBits(hdr, blocks, channels, totalChannels) | 0;
  if (totalBits <= bitBudget) {
    return;
  }

  for (let sweep = 0; sweep < maxOffsetRaiseSteps && totalBits > bitBudget; sweep += 1) {
    for (let band = totalBands - 1; band >= firstRaisedBand; band -= 1) {
      const isLowBand = band < AT5_LOW_BAND_COUNT;
      for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
        const block = blocks[channelIndex] ?? null;
        const channel = channels[channelIndex] ?? null;
        const quantMode = channel?.idwl?.values?.[band] | 0;
        if (!block || quantMode < 1) {
          continue;
        }

        const committedOffset = block.quantOffsetByBand[band] | 0;
        if (committedOffset >= maxOffsetRaiseSteps) {
          continue;
        }

        const nextOffset = nextRebitallocQuantOffset(committedOffset, isLowBand, coreModeValue);
        if (nextOffset === committedOffset) {
          continue;
        }
        block.quantOffsetByBand[band] = nextOffset | 0;
        if (!isLowBand && committedOffset >= AT5_MAX_QUANT_OFFSET) {
          // Saturated high-band offsets clamp back into the valid range without
          // reopening the context-cost search.
          continue;
        }

        at5RecomputeCtxCosts(block, channel, getChannelWorkId(channel), totalBands);
        totalBits = at5RecomputeTotalBits(hdr, blocks, channels, totalChannels) | 0;
        if (totalBits <= bitBudget) {
          return;
        }
      }
    }
  }
}

/**
 * Retries rejected rebitalloc probes with progressively larger quant-offset
 * jumps until one probe brings the block back under the bit budget. Accepted
 * probes become the new committed offset baseline; rejected probes only age a
 * per-band retry raise counter that the next refine pass adds on top of the
 * current committed offset.
 */
export function refineRebitallocOffsets(
  hdr,
  blocks,
  channels,
  channelCount,
  coreMode,
  bitLimit,
  bandCount
) {
  const totalChannels = channelCount | 0;
  const totalBands = Math.max(0, bandCount | 0);
  const coreModeValue = coreMode | 0;
  const bitBudget = bitLimit | 0;
  let totalBits = (hdr?.bitsTotal ?? 0) | 0;
  if (totalChannels <= 0 || !hdr || totalBits <= bitBudget) {
    return;
  }
  const cbStartBand = at5S16(hdr.cbStartBand ?? 0) | 0;
  const firstRefineBand =
    cbStartBand < totalBands ? cbStartBand : Math.max(0, (cbStartBand - 2) | 0);
  const guardLowBandOffsetCeiling = coreModeValue >= LOW_BAND_GUARD_CORE_MODE;

  const scratch = rebitallocProbeScratch(hdr);
  /** @type {Int32Array[]} */
  let retryRaiseByChannel = Array.isArray(scratch?.retryRaiseByChannel)
    ? scratch.retryRaiseByChannel
    : [];
  if (retryRaiseByChannel.length !== totalChannels) {
    retryRaiseByChannel = Array.from({ length: totalChannels }, () => new Int32Array(totalBands));
    if (scratch) {
      scratch.retryRaiseByChannel = retryRaiseByChannel;
    }
  }
  for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
    let bandRaises = retryRaiseByChannel[channelIndex];
    if (!(bandRaises instanceof Int32Array) || bandRaises.length !== totalBands) {
      bandRaises = new Int32Array(totalBands);
      retryRaiseByChannel[channelIndex] = bandRaises;
    } else {
      bandRaises.fill(0);
    }
  }

  for (let pass = 0; pass < MAX_REFINE_PASSES && totalBits > bitBudget; pass += 1) {
    for (let band = totalBands - 1; band >= firstRefineBand; band -= 1) {
      const guardLowBandRaise = guardLowBandOffsetCeiling && band < LOW_BAND_GUARD_LIMIT;

      for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
        const block = blocks?.[channelIndex] ?? null;
        const channel = channels?.[channelIndex] ?? null;
        const quantMode = channel?.idwl?.values?.[band] | 0;
        if (!block || quantMode < 1) {
          continue;
        }

        const committedOffset = (block.quantOffsetByBand?.[band] ?? 0) | 0;
        if (guardLowBandRaise && committedOffset >= GUARDED_LOW_BAND_OFFSET) {
          continue;
        }

        const retryRaiseByBand = retryRaiseByChannel[channelIndex];
        const nextRetryRaise = (retryRaiseByBand[band] + 1) | 0;
        retryRaiseByBand[band] = nextRetryRaise;

        // Even an over-limit probe still ages the retry raise, which
        // effectively retires that band once it has exhausted offset room.
        const probeOffset = (committedOffset + nextRetryRaise) | 0;
        if (probeOffset > MAX_REBITALLOC_OFFSET) {
          continue;
        }

        block.quantOffsetByBand[band] = probeOffset;
        const acceptedTotalBits = tryApplyRebitallocChoice(
          hdr,
          blocks,
          channels,
          totalChannels,
          channelIndex,
          band,
          quantMode,
          (channel.idct?.values?.[band] ?? 0) | 0
        );

        if (acceptedTotalBits === null) {
          block.quantOffsetByBand[band] = committedOffset;
          continue;
        }

        totalBits = acceptedTotalBits | 0;
        retryRaiseByBand[band] = 0;
        if (totalBits <= bitBudget) {
          return;
        }
      }
    }
  }
}
