import { AT5_HC_SPEC_LIMIT_BY_TBL } from "../tables/encode-bitalloc.js";
import { AT5_ISPS, AT5_NSPS } from "../tables/unpack.js";
import { quantNontoneNspecsAt5 } from "./quant-cost.js";

const AT5_HCSPEC_CANDIDATE_STRIDE = 8;
const AT5_TRIMMED_QUANT_OFFSET = 0x0f;

export function setChannelWorkId(channel, id) {
  channel.rebitallocCtxId = id & 1;
}

export function getChannelWorkId(channel) {
  return (channel?.rebitallocCtxId ?? 0) & 1;
}

/**
 * Chooses the cheapest HCSPEC candidate already written into one band's work
 * table row and records that winner back into the work scratch.
 */
export function selectBestHcspecCostForBand(work, band, hcspecLimit) {
  const candidateBase = (band * AT5_HCSPEC_CANDIDATE_STRIDE) | 0;
  let bestCandidateIndex = 0;
  let bestCandidateCost = work.costsByBand[candidateBase] >>> 0;
  for (let candidateIndex = 1; candidateIndex < hcspecLimit; candidateIndex += 1) {
    const candidateCost = work.costsByBand[candidateBase + candidateIndex] >>> 0;
    if (candidateCost < bestCandidateCost) {
      bestCandidateCost = candidateCost;
      bestCandidateIndex = candidateIndex;
    }
  }
  work.bestIndexByBand[band] = bestCandidateIndex | 0;
  return bestCandidateCost;
}

/**
 * Recomputes one HCSPEC context from the current quant decisions and writes the
 * resulting per-context bit delta back into the block scratch.
 */
export function at5RecomputeCtxCosts(
  block,
  channel,
  ctxId,
  bandCount,
  quantizedSpectrumIn = block?.quantizedSpectrum ?? null
) {
  const ctx = ctxId & 1;
  const quantOffsetByBand = block?.quantOffsetByBand ?? null;
  const normalizedBandPeaks = block?.normalizedBandPeaks ?? null;
  if (!block || !quantOffsetByBand || !normalizedBandPeaks) {
    throw new TypeError("invalid AT5 channel block scratch");
  }

  const quantModes = channel?.idwl?.values ?? null;
  if (!channel || !quantModes || !channel.scratchSpectra) {
    throw new TypeError("invalid AT5 channel state");
  }

  const hdr = block.bitallocHeader ?? null;
  if (!hdr) {
    throw new TypeError("at5RecomputeCtxCosts: missing bitalloc header");
  }

  const tblIndex = hdr.tblIndex ?? 0;
  const hcspecLimit = AT5_HC_SPEC_LIMIT_BY_TBL[tblIndex | 0] | 0;
  if (hcspecLimit <= 0) {
    block.bitDeltaByCtx[ctx] = 0;
    return 0;
  }

  const work = block.hcspecWorkByCtx?.[ctx] ?? null;
  if (
    !(work?.costsByBand instanceof Uint16Array) ||
    !(work?.bestIndexByBand instanceof Int32Array)
  ) {
    throw new TypeError("at5RecomputeCtxCosts: missing hcspec work tables");
  }

  if (!(quantizedSpectrumIn instanceof Float32Array)) {
    throw new TypeError("at5RecomputeCtxCosts: missing quantized spectrum");
  }

  let totalBitDelta = 0;
  const activeBandCount = Math.max(0, Math.min(bandCount | 0, 32));
  for (let band = 0; band < activeBandCount; band += 1) {
    const quantMode = quantModes[band] | 0;
    if (quantMode < 1) {
      continue;
    }

    const coeffStart = AT5_ISPS[band] >>> 0;
    const coeffCount = AT5_NSPS[band] >>> 0;
    const quantOffset = quantOffsetByBand[band] >>> 0;
    const scaledBandLevel = normalizedBandPeaks[band] ?? 0;

    quantNontoneNspecsAt5(
      ctx,
      band | 0,
      quantMode,
      quantOffset,
      scaledBandLevel,
      coeffCount,
      quantizedSpectrumIn.subarray(coeffStart),
      work,
      block
    );

    totalBitDelta = (totalBitDelta + selectBestHcspecCostForBand(work, band, hcspecLimit)) & 0xffff;
  }

  block.bitDeltaByCtx[ctx] = totalBitDelta & 0xffff;
  return totalBitDelta & 0xffff;
}

/**
 * Refreshes the inactive HCSPEC context for each channel and switches to it
 * only when that alternate context is now cheaper than the active one.
 */
export function at5RecomputeMissingCtxCostsAndSelect(blocks, channels, channelCount, bandCount) {
  const chCount = channelCount | 0;
  for (let ch = 0; ch < chCount; ch += 1) {
    const block = blocks[ch];
    const channel = channels[ch];
    if (!block || !channel) {
      continue;
    }

    const activeCtxId = getChannelWorkId(channel) & 1;
    const alternateCtxId = activeCtxId ^ 1;
    at5RecomputeCtxCosts(block, channel, alternateCtxId, bandCount | 0);

    const activeCost = block.bitDeltaByCtx?.[activeCtxId] ?? 0xffff;
    const alternateCost = block.bitDeltaByCtx?.[alternateCtxId] ?? 0xffff;
    setChannelWorkId(channel, alternateCost < activeCost ? alternateCtxId : activeCtxId);
  }
}

/**
 * Rebuilds the block total from the fixed header/base bucket plus each
 * channel's currently selected HCSPEC context delta.
 */
export function at5RecomputeTotalBits(hdr, blocks, channels, channelCount) {
  if (!hdr) {
    throw new TypeError("at5RecomputeTotalBits: missing bitalloc header");
  }

  let total = (hdr.bitsTotalBase ?? 0) & 0xffff;
  const chCount = channelCount | 0;
  for (let ch = 0; ch < chCount; ch += 1) {
    const channel = channels[ch];
    const block = blocks[ch];
    if (!channel || !block) {
      continue;
    }

    const activeCtxId = getChannelWorkId(channel) & 1;
    total = (total + (block.bitDeltaByCtx?.[activeCtxId] ?? 0)) & 0xffff;
  }
  hdr.bitsTotal = total;
  return total & 0xffff;
}

/**
 * Walks high bands downward until the block fits, saturating the trimmed
 * band's quant offset and clearing either the active channels or the whole
 * stereo pair when mode-3 masking requires it.
 */
export function at5TrimHighBandsToFit(
  blocks,
  quantizedSpectraByChannel,
  channels,
  hdr,
  channelCount,
  bandCount,
  bitLimit
) {
  const bitBudget = bitLimit | 0;
  const activeBandCount = Math.max(0, Math.min(bandCount | 0, 32));
  const chCount = channelCount | 0;

  for (
    let band = activeBandCount - 1;
    band >= 0 && ((hdr?.bitsTotal ?? 0) | 0) > bitBudget;
    band -= 1
  ) {
    const activeChannelsInBand = [];
    for (let ch = 0; ch < chCount; ch += 1) {
      const channel = channels?.[ch];
      const block = blocks?.[ch];
      if (!block || !channel || (channel.idwl?.values?.[band] | 0) < 1) {
        continue;
      }

      block.quantOffsetByBand[band] = AT5_TRIMMED_QUANT_OFFSET;
      activeChannelsInBand.push(ch);
    }
    if (activeChannelsInBand.length === 0) {
      continue;
    }

    const coeffStart = AT5_ISPS[band] >>> 0;
    const coeffEnd = coeffStart + (AT5_NSPS[band] >>> 0);
    const clearMaskedStereoPair = chCount === 2 && (hdr?.mode3BandMask?.[band] ?? 0) === 1;
    if (clearMaskedStereoPair) {
      for (let ch = 0; ch < chCount; ch += 1) {
        const spec = quantizedSpectraByChannel?.[ch];
        if (spec instanceof Float32Array) {
          spec.fill(0, coeffStart, coeffEnd);
        }
      }
    } else {
      for (const ch of activeChannelsInBand) {
        const spec = quantizedSpectraByChannel?.[ch];
        if (spec instanceof Float32Array) {
          spec.fill(0, coeffStart, coeffEnd);
        }
      }
    }

    for (const ch of activeChannelsInBand) {
      const channel = channels[ch];
      const block = blocks[ch];
      const activeCtxId = getChannelWorkId(channel) & 1;
      at5RecomputeCtxCosts(block, channel, activeCtxId, activeBandCount);
    }
    at5RecomputeTotalBits(hdr, blocks, channels, chCount);
  }
}
