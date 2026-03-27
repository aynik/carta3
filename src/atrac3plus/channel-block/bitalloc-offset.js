import {
  AT5_HC_SPEC_LIMIT_BY_TBL,
  AT5_SECOND_BIT_STEP_HALF,
  AT5_SECOND_BIT_STEP_SCALE,
} from "../tables/encode-bitalloc.js";
import { AT5_ISPS, AT5_NSPS } from "../tables/unpack.js";
import {
  createBitallocOffsetState,
  quantModeForBitallocOffset,
  searchBitallocOffset,
  usesDirectBitallocScaling,
} from "./bitalloc-heuristics.js";
import { getChannelWorkId, at5RecomputeTotalBits, selectBestHcspecCostForBand } from "./core.js";
import { computeIdwlBitsAt5 } from "./packed-state.js";
import { quantNontoneNspecsAt5 } from "./quant-cost.js";

function applyBitallocOffsetProbeToChannel(
  probeOffset,
  shouldRescoreSeededOffsetBands,
  bitallocOffsetState,
  hcspecLimit,
  block,
  channel,
  bandCount
) {
  const idwlModes = channel?.idwl?.values ?? null;
  if (!block || !channel || !idwlModes) {
    return;
  }

  const activeCtxId = getChannelWorkId(channel) & 1;
  const activeWork = block.hcspecWorkByCtx?.[activeCtxId] ?? null;
  const bestIndexByBand = activeWork?.bestIndexByBand ?? null;
  const costsByBand = activeWork?.costsByBand ?? null;
  const quantizedSpectrum =
    block.quantizedSpectrum instanceof Float32Array ? block.quantizedSpectrum : null;
  let channelCtxBits = 0;

  for (let band = 0; band < (bandCount | 0); band += 1) {
    const previousMode = idwlModes[band] | 0;
    const quantOffset = block.quantOffsetByBand[band] | 0;
    const nextMode = quantModeForBitallocOffset(
      (block.quantModeByBand[band] | 0) !== 0,
      block.maxQuantModeByBand[band] | 0,
      block.quantModeBaseByBand[band],
      band,
      probeOffset,
      bitallocOffsetState,
      true
    );
    idwlModes[band] = nextMode >>> 0;

    if (nextMode <= 0) {
      if (bestIndexByBand) {
        bestIndexByBand[band] = 0;
      }
      continue;
    }

    // The first search iteration must rescore bands with non-zero offsets,
    // because the cached costs still belong to the seeded pre-search state.
    const canReuseCachedBandCost =
      previousMode === nextMode && !(shouldRescoreSeededOffsetBands && quantOffset > 0);
    if (canReuseCachedBandCost) {
      const cachedHcspecIndex = bestIndexByBand?.[band] ?? 0;
      channelCtxBits =
        (channelCtxBits + ((costsByBand?.[(band << 3) + cachedHcspecIndex] ?? 0) & 0xffff)) &
        0xffff;
      continue;
    }

    quantNontoneNspecsAt5(
      activeCtxId,
      band,
      nextMode,
      quantOffset >>> 0,
      block.normalizedBandPeaks[band] ?? 0,
      AT5_NSPS[band] >>> 0,
      quantizedSpectrum?.subarray(AT5_ISPS[band] >>> 0) ?? null,
      activeWork,
      block
    );

    channelCtxBits =
      (channelCtxBits + selectBestHcspecCostForBand(activeWork, band, hcspecLimit)) & 0xffff;
  }

  block.bitDeltaByCtx[activeCtxId] = channelCtxBits & 0xffff;
}

/**
 * Searches the shared bitalloc offset in place, reusing cached HCSPEC costs
 * whenever the band mode stays unchanged and only rescoring bands that need a
 * fresh quantization pass.
 */
export function solveBitallocOffset(
  hdr,
  blocks,
  channels,
  channelCount,
  bandCount,
  bitLimit,
  coreMode
) {
  const totalChannels = channelCount | 0;
  const totalBands = bandCount | 0;
  const bitBudget = bitLimit | 0;
  if (totalChannels <= 0) {
    return;
  }

  const stagedChannels = channels ?? [];
  const stagedBlocks = blocks ?? [];
  const shared = stagedChannels[0]?.shared ?? null;
  const encodeFlags = (shared?.encodeFlags ?? 0) >>> 0;
  const bitallocOffsetState = createBitallocOffsetState(
    totalChannels,
    (shared?.sampleRateHz ?? 0) >>> 0,
    encodeFlags,
    coreMode | 0
  );
  const hcspecLimit = AT5_HC_SPEC_LIMIT_BY_TBL[(hdr?.tblIndex ?? 0) | 0] | 0;
  const sharedIdwlWork = stagedBlocks[0]?.idwlWork;
  if (sharedIdwlWork instanceof Uint8Array) {
    for (let ch = 0; ch < totalChannels; ch += 1) {
      const scratch = stagedBlocks[ch]?.idwlScratch;
      if (scratch) {
        scratch.work = sharedIdwlWork;
      }
    }
  }

  const minimumAcceptedBits = usesDirectBitallocScaling(encodeFlags)
    ? Math.trunc(bitBudget * AT5_SECOND_BIT_STEP_HALF)
    : Math.trunc(Math.fround(bitBudget * AT5_SECOND_BIT_STEP_SCALE));

  searchBitallocOffset(
    bitBudget,
    minimumAcceptedBits,
    ((hdr?.bitsTotal ?? 0) | 0) >= bitBudget,
    8,
    (probeOffset, iteration) => {
      const shouldRescoreSeededOffsetBands = (iteration | 0) === 0;
      for (let ch = 0; ch < totalChannels; ch += 1) {
        applyBitallocOffsetProbeToChannel(
          probeOffset,
          shouldRescoreSeededOffsetBands,
          bitallocOffsetState,
          hcspecLimit,
          stagedBlocks[ch] ?? null,
          stagedChannels[ch] ?? null,
          totalBands
        );
      }

      return at5RecomputeTotalBits(hdr, stagedBlocks, stagedChannels, totalChannels) | 0;
    }
  );

  const oldIdwlBits = (hdr?.bitsIdwl ?? 0) | 0;
  const newIdwlBits = computeIdwlBitsAt5(hdr, stagedChannels, stagedBlocks, totalChannels);
  const deltaIdwlBits = (newIdwlBits - oldIdwlBits) | 0;

  hdr.bitsIdwl = newIdwlBits & 0xffff;
  hdr.bitsTotalBase = ((hdr.bitsTotalBase | 0) + deltaIdwlBits) & 0xffff;
  hdr.bitsTotal = ((hdr.bitsTotal | 0) + deltaIdwlBits) & 0xffff;
}
