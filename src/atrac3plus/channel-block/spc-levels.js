import { calcNbitsForIdsfChAt5 } from "../bitstream/internal.js";
import { AT5_IFQF, AT5_LNGAIN, AT5_RNDTBL, AT5_SFTBL, AT5_SPCLEV } from "../tables/decode.js";
import {
  AT5_CB_GROUP_END_BY_BAND,
  AT5_CB_GROUP_SCALE_BY_OFFSET,
  AT5_CB_GROUP_START_BY_BAND,
  AT5_IDSPCQUS_BY_BAND,
} from "../tables/encode-init.js";
import { AT5_IDSPCBANDS, AT5_ISPS, AT5_NSPS, AT5_X } from "../tables/unpack.js";
import { sfAdjustConfigForCoreMode } from "./bitalloc-heuristics.js";
import { AT5_BANDS_MAX } from "./constants.js";
import { clampI32 } from "./primitives.js";
import {
  clampRaisedIdsf,
  hasHighLevelRatioGuard,
  lowerIdsfTowardReference,
  raiseIdsfTowardReference,
  shouldBackOffRaisedIdsf,
} from "./quantize.js";
import { runtimeCurrentBuffer, runtimePreviousBuffer } from "./runtime.js";

const AT5_PWC_RND_SCALE = 1 / 32768;
const AT5_CHANNEL_BLOCK_MAX_CHANNELS = 2;
const AT5_COEFFICIENT_SORT_CAPACITY = 0x100;
const AT5_SPC_SLOT_DISABLED_INDEX = 0x0f;
const AT5_SPC_SLOT_SEEDED_INDEX = 6;
const AT5_SPC_ADAPTIVE_SLOT_COUNT = 5;

function getChannelBlockScratch(hdr) {
  if (!hdr || typeof hdr !== "object") {
    return null;
  }

  const scratch = hdr.scratch && typeof hdr.scratch === "object" ? hdr.scratch : (hdr.scratch = {});
  return scratch.channelBlock && typeof scratch.channelBlock === "object"
    ? scratch.channelBlock
    : (scratch.channelBlock = {});
}

function reuseTypedArray(value, Type, length) {
  return value instanceof Type && value.length === length ? value : new Type(length);
}

function reuseBandAllowedRows(value) {
  if (
    Array.isArray(value) &&
    value.length === AT5_CHANNEL_BLOCK_MAX_CHANNELS &&
    value.every((row) => row instanceof Int32Array && row.length === AT5_BANDS_MAX)
  ) {
    return value;
  }
  return Array.from(
    { length: AT5_CHANNEL_BLOCK_MAX_CHANNELS },
    () => new Int32Array(AT5_BANDS_MAX)
  );
}

export function asI16(v) {
  return (v << 16) >> 16;
}

function buildSpcSeedMap(seedMap, channels, idsfCount, mapCount, channelCount = channels.length) {
  let seedSum = 0;

  for (let ch = 0; ch < (channelCount | 0); ch += 1) {
    const channel = channels[ch];
    const idsfValues = channel?.idsf?.values ?? null;
    if (!idsfValues) {
      continue;
    }

    for (let band = 0; band < (idsfCount | 0); band += 1) {
      seedSum = (seedSum + (idsfValues[band] & 0xffff)) & 0xffff;
    }
  }

  seedMap.fill(0);

  let seed = seedSum & 0x3fc;
  const seedCount = Math.min(mapCount | 0, seedMap.length | 0);
  for (let i = 0; i < seedCount; i += 1) {
    seedMap[i] = seed;
    seed = (seed + 0x80) & 0x3fc;
  }
}

function sumAbsoluteValues(spec, count, offset = 0) {
  const sampleCount = count ?? 0;
  if (sampleCount <= 0) {
    return 0;
  }

  let total = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    total += Math.abs(spec[offset + i]);
  }
  return total;
}

function copyBandCoefficients(out, spectrum, offset, count) {
  out.set(spectrum.subarray(offset, offset + count), 0);
}

function usesSharedMode3BandSource(channelCount, band, mode3BandMask) {
  return channelCount === 2 && (mode3BandMask?.[band] ?? 0) === 1;
}

function spcSlotContributionWeight(band, idsfIndex) {
  const groupOffset = clampI32(
    (band - (AT5_CB_GROUP_START_BY_BAND[band] ?? band)) | 0,
    0,
    (AT5_CB_GROUP_SCALE_BY_OFFSET.length - 1) | 0
  );
  return idsfIndex * (AT5_CB_GROUP_SCALE_BY_OFFSET[groupOffset] ?? 0);
}

function gainRecordCount(record) {
  const count = record?.entries | 0;
  if (count <= 0) {
    return 0;
  }
  return count > 7 ? 7 : count;
}

function gainRecordIndex(record, i) {
  const idx = (record?.levels?.[i] ?? record?.indices?.[i] ?? 0) | 0;
  return clampI32(idx, 0, (AT5_LNGAIN.length - 1) | 0);
}

function fillPwcRandomValues(rnd, seed, nsps) {
  const base = asI16(seed | 0);
  for (let i = 0; i < (nsps | 0); i += 1) {
    const idx = (base + i) & 0x3ff;
    rnd[i] = (AT5_RNDTBL[idx] | 0) * AT5_PWC_RND_SCALE;
  }
}

function pwcNoiseScale(curRec, prevRec, shift, spclev) {
  let baseGain = 0;
  const curCount = gainRecordCount(curRec);
  if (curCount > 0) {
    baseGain = asI16(-(AT5_LNGAIN[gainRecordIndex(curRec, 0)] | 0));
  }

  let best = 0;
  const prevCount = gainRecordCount(prevRec);
  for (let i = 0; i < prevCount; i += 1) {
    const gain = asI16(-(AT5_LNGAIN[gainRecordIndex(prevRec, i)] | 0));
    const sum = asI16((gain + baseGain) | 0);
    if (sum > best) {
      best = sum;
    }
  }

  for (let i = 0; i < curCount; i += 1) {
    const gain = asI16(-(AT5_LNGAIN[gainRecordIndex(curRec, i)] | 0));
    if (gain > best) {
      best = gain;
    }
  }

  const shiftVal = (asI16(best) + (shift | 0)) | 0;
  return spclev / (1 << (shiftVal & 31));
}

function finalizeSpcSlots(
  spclevIndex,
  slotStart,
  slotLimit,
  slotPwcRatioSum,
  slotBandLevelSum,
  slotWeightSum,
  coreMode
) {
  for (let slot = Math.max(0, slotStart); slot < slotLimit; slot += 1) {
    let averagePwcRatio = slotPwcRatioSum[slot] ?? 0;
    let averageBandLevel = slotBandLevelSum[slot] ?? 0;
    const totalWeight = slotWeightSum[slot] ?? 0;

    if (averagePwcRatio > 0 && totalWeight > 0) {
      averagePwcRatio /= totalWeight;
      averageBandLevel /= totalWeight;
    }

    let levelIndex = AT5_SPC_SLOT_DISABLED_INDEX;
    for (let i = 0x0e; i >= 0; i -= 1) {
      if (averagePwcRatio > (AT5_SPCLEV[i] ?? 0)) {
        levelIndex = i;
      } else {
        break;
      }
    }

    let slotValue = levelIndex + (coreMode < 0x13 ? 4 : 5);
    if (averageBandLevel > 3) {
      slotValue += averageBandLevel > 6 ? 2 : 1;
    }

    spclevIndex[slot] = clampI32(slotValue, 0, AT5_SPC_SLOT_DISABLED_INDEX);
  }
}

/**
 * Synthesizes the per-band PWC contribution for one channel, applying stereo
 * swap routing and record-driven scaling before mixing the noise band into
 * `out`.
 */
export function pwcQuAt5(
  channels,
  seed,
  ch,
  band,
  shift,
  out,
  rnd,
  lastBandRef,
  sharedOverride = null,
  runtimeEntries = null
) {
  if (!Array.isArray(channels) || ch < 0 || ch >= channels.length || band < 2) {
    return;
  }

  const inputChannel = channels[ch] ?? null;
  const shared = sharedOverride ?? inputChannel?.shared ?? null;
  let sourceChannelIndex = ch;
  let channel = inputChannel;
  if (!channel || !shared) {
    return;
  }

  const mapIndex = ((AT5_X[band + 1] ?? 0) << 24) >> 24;
  const swapMap = shared.stereoSwapPresence?.flags ?? shared.swapMap ?? null;
  if (shared.channels === 2 && (swapMap?.[mapIndex] ?? 0) !== 0) {
    const swappedChannelIndex = 1 - ch;
    const swappedChannel = channels[swappedChannelIndex] ?? null;
    if (swappedChannel) {
      sourceChannelIndex = swappedChannelIndex;
      channel = swappedChannel;
    }
  }

  const sampleCount = AT5_NSPS[band] ?? 0;
  const slotIndex = AT5_IDSPCBANDS[mapIndex] ?? 0;
  const spcLevel = AT5_SPCLEV[channel?.spclevIndex?.[slotIndex] ?? 0] ?? 0;
  if (!(spcLevel > 0) || sampleCount === 0) {
    return;
  }

  if ((lastBandRef?.value ?? null) !== mapIndex) {
    if (lastBandRef) {
      lastBandRef.value = mapIndex;
    }
    fillPwcRandomValues(rnd, seed, sampleCount);
  }

  const runtimeChannel = runtimeEntries?.[sourceChannelIndex] ?? channel;
  const curBuf = runtimeCurrentBuffer(runtimeChannel);
  const prevBuf = runtimePreviousBuffer(runtimeChannel);
  const scale = pwcNoiseScale(
    curBuf?.records?.[mapIndex] ?? null,
    prevBuf?.records?.[mapIndex] ?? null,
    shift,
    spcLevel
  );

  for (let i = 0; i < sampleCount; i += 1) {
    out[i] += scale * rnd[i];
  }
}

/**
 * Returns reusable scratch buffers for the SPC-level slot-analysis pass.
 */
export function getSpcLevelScratchState(hdr) {
  const scratch = getChannelBlockScratch(hdr);
  const spcLevels =
    scratch.spcLevels && typeof scratch.spcLevels === "object"
      ? scratch.spcLevels
      : (scratch.spcLevels = {});
  spcLevels.seedByMapIndex = reuseTypedArray(spcLevels.seedByMapIndex, Uint16Array, AT5_BANDS_MAX);
  spcLevels.slotPwcRatioSum = reuseTypedArray(spcLevels.slotPwcRatioSum, Float32Array, 8);
  spcLevels.slotBandLevelSum = reuseTypedArray(spcLevels.slotBandLevelSum, Float32Array, 8);
  spcLevels.slotWeightSum = reuseTypedArray(spcLevels.slotWeightSum, Uint32Array, 8);
  // Reusable band-sized scratch lanes. Callers alias these to the local role
  // they need, such as synthesized PWC output, quantized spectra, or shared
  // masked-stereo scratch.
  spcLevels.primaryBandScratch = reuseTypedArray(spcLevels.primaryBandScratch, Float32Array, 128);
  spcLevels.secondaryBandScratch = reuseTypedArray(
    spcLevels.secondaryBandScratch,
    Float32Array,
    128
  );
  spcLevels.randomScratch = reuseTypedArray(spcLevels.randomScratch, Float32Array, 128);
  if (!spcLevels.cachedSeedBand || typeof spcLevels.cachedSeedBand !== "object") {
    spcLevels.cachedSeedBand = { value: -1 };
  }
  return spcLevels;
}

/**
 * Returns reusable scratch buffers for the later channel-block solve stages
 * that rank bands, gate retries, and prune coefficients.
 */
export function getSolveScratchState(hdr) {
  const scratch = getChannelBlockScratch(hdr);
  const bandPairs = AT5_BANDS_MAX * AT5_CHANNEL_BLOCK_MAX_CHANNELS;

  const latePriority =
    scratch.latePriority && typeof scratch.latePriority === "object"
      ? scratch.latePriority
      : (scratch.latePriority = {
          bandScores: scratch.bandScores,
          orderedBandSlots: scratch.bandOrder,
          stereoScores: scratch.stereoScores,
          stereoBandsByPriority: scratch.stereoOrder,
          stereoBandCount: 0,
        });
  latePriority.bandScores = reuseTypedArray(latePriority.bandScores, Int32Array, bandPairs);
  latePriority.orderedBandSlots = reuseTypedArray(
    latePriority.orderedBandSlots,
    Int32Array,
    bandPairs
  );
  latePriority.stereoScores = reuseTypedArray(latePriority.stereoScores, Int32Array, AT5_BANDS_MAX);
  latePriority.stereoBandsByPriority = reuseTypedArray(
    latePriority.stereoBandsByPriority,
    Int32Array,
    AT5_BANDS_MAX
  );
  latePriority.stereoBandCount = latePriority.stereoBandCount | 0;

  scratch.spcLevelEnabledByChannel = reuseTypedArray(
    scratch.spcLevelEnabledByChannel ?? scratch.spcLevelEnabled,
    Int32Array,
    AT5_CHANNEL_BLOCK_MAX_CHANNELS
  );
  scratch.raiseAllowedByChannel = reuseBandAllowedRows(
    scratch.raiseAllowedByChannel ?? scratch.bandAllowed
  );

  const coefficientPruning =
    scratch.coefficientPruning && typeof scratch.coefficientPruning === "object"
      ? scratch.coefficientPruning
      : (scratch.coefficientPruning = {});
  coefficientPruning.sortedMagnitudes = reuseTypedArray(
    coefficientPruning.sortedMagnitudes,
    Float32Array,
    AT5_COEFFICIENT_SORT_CAPACITY
  );
  coefficientPruning.sortedIndices = reuseTypedArray(
    coefficientPruning.sortedIndices,
    Int32Array,
    AT5_COEFFICIENT_SORT_CAPACITY
  );
  coefficientPruning.acceptedBandSnapshot = reuseTypedArray(
    coefficientPruning.acceptedBandSnapshot,
    Float32Array,
    AT5_COEFFICIENT_SORT_CAPACITY
  );

  return scratch;
}

function retuneScaleFactorIndex(
  baseIndex,
  synthesizedEnergy,
  referenceEnergy,
  bandLevel,
  scaleRatio,
  config
) {
  if (!(synthesizedEnergy > 0) || !(referenceEnergy > 0)) {
    return baseIndex | 0;
  }

  if (synthesizedEnergy < referenceEnergy) {
    const raised = raiseIdsfTowardReference(baseIndex, synthesizedEnergy, referenceEnergy);
    let adjusted = raised.idsf;
    if (raised.specEnergy > referenceEnergy * config.kHi) {
      adjusted -= 1;
    }
    if (shouldBackOffRaisedIdsf(bandLevel, scaleRatio)) {
      adjusted -= 1;
    }
    return clampRaisedIdsf(baseIndex, adjusted, config.stepLimit);
  }

  if (hasHighLevelRatioGuard(bandLevel, scaleRatio)) {
    return baseIndex | 0;
  }

  const lowered = lowerIdsfTowardReference(baseIndex, synthesizedEnergy, referenceEnergy);
  return lowered.specEnergy < referenceEnergy * config.kLo ? (lowered.idsf + 1) | 0 : lowered.idsf;
}

function refreshPackedIdsfBitTotals(hdr, channels, channelCount) {
  const totalChannels = channelCount | 0;
  const committedIdsfBits = (hdr.bitsIdsf ?? 0) & 0xffff;
  const variableBits = ((hdr.bitsTotal ?? 0) - (hdr.bitsTotalBase ?? 0)) & 0xffff;
  const channel0IdsfCount = (channels?.[0]?.shared?.idsfCount ?? 0) | 0;
  const flatIdsfMode = (hdr.idsfModeWord | 0) === 0;
  let repackedIdsfBits = 0;

  if (channel0IdsfCount > 0) {
    repackedIdsfBits = (totalChannels * 2) | 0;
    for (let ch = 0; ch < totalChannels; ch += 1) {
      const channel = channels?.[ch] ?? null;
      if (flatIdsfMode) {
        repackedIdsfBits = (repackedIdsfBits + ((channel?.shared?.idsfCount ?? 0) | 0) * 6) | 0;
        if (channel) {
          channel.idsfModeSelect = 0;
          if (channel.idsf) {
            channel.idsf.modeSelect = 0;
          }
        }
        continue;
      }

      repackedIdsfBits = (repackedIdsfBits + (calcNbitsForIdsfChAt5(channel) | 0)) | 0;
    }
  }

  hdr.bitsIdsf = repackedIdsfBits & 0xffff;
  hdr.bitsTotalBase = ((hdr.bitsTotalBase ?? 0) - committedIdsfBits + repackedIdsfBits) & 0xffff;
  hdr.bitsTotal = (variableBits + (hdr.bitsTotalBase ?? 0)) & 0xffff;
}

/**
 * Computes the encoded SPC-level slot indices (`spclevIndex`) from the current
 * quantized spectra, synthesized PWC noise bands, and per-channel `bandLevels`
 * exposed by the supplied channel blocks.
 */
export function computeSpcLevelSlotsAt5(
  channelBlocks,
  channels,
  hdr,
  shared,
  channelCount,
  coreMode,
  enabledByChannel
) {
  const chCount = channelCount | 0;
  const mode = coreMode | 0;
  if (
    !shared ||
    !hdr ||
    !Array.isArray(channels) ||
    !Array.isArray(channelBlocks) ||
    chCount <= 0
  ) {
    return;
  }

  const idsfBandCount = (shared.idsfCount ?? 0) | 0;
  const {
    seedByMapIndex,
    slotPwcRatioSum: pwcRatioSumBySlot,
    slotBandLevelSum: bandLevelSumBySlot,
    slotWeightSum: weightSumBySlot,
    primaryBandScratch: synthesizedPwcBandScratch,
    randomScratch,
    cachedSeedBand,
  } = getSpcLevelScratchState(hdr);
  const mapCount = (shared.mapCount ?? 0) | 0;
  buildSpcSeedMap(seedByMapIndex, channels, idsfBandCount, mapCount, chCount);

  const firstAnalyzedBand = (AT5_CB_GROUP_END_BY_BAND[mode >>> 0] ?? 0) | 0;
  const firstActiveSlot = AT5_IDSPCQUS_BY_BAND[firstAnalyzedBand] ?? 0;
  const lastSeededSlot = AT5_IDSPCQUS_BY_BAND[mapCount + (AT5_BANDS_MAX - 1)] ?? 0;
  const seededSlotEndExclusive = lastSeededSlot + 1;
  const mode3BandMask = hdr.mode3BandMask ?? hdr.shared?.mode3BandMask ?? null;
  const runtimeEntries = hdr.channelEntries ?? null;

  for (let ch = 0; ch < chCount; ch += 1) {
    const channel = channels[ch];
    if (!channel) {
      continue;
    }

    const slotLevels = channel.spclevIndex;
    if (!(slotLevels instanceof Uint32Array) || slotLevels.length === 0) {
      continue;
    }

    const enabled = enabledByChannel?.[ch] ?? 1;
    if ((enabled | 0) === 0) {
      slotLevels.fill(AT5_SPC_SLOT_DISABLED_INDEX);
      continue;
    }

    pwcRatioSumBySlot.fill(0);
    bandLevelSumBySlot.fill(0);
    weightSumBySlot.fill(0);
    cachedSeedBand.value = -1;
    slotLevels.fill(AT5_SPC_SLOT_DISABLED_INDEX);

    const seededSlotEndForChannel = Math.min(seededSlotEndExclusive, slotLevels.length | 0);
    slotLevels.fill(AT5_SPC_SLOT_SEEDED_INDEX, firstActiveSlot, seededSlotEndForChannel);

    // Slot finalization only adjusts the front adaptive slot window; later
    // seeded slots stay at the baseline value.
    const slotFinalizeEndExclusive = Math.min(seededSlotEndForChannel, AT5_SPC_ADAPTIVE_SLOT_COUNT);

    const idsfByBand = channel?.idsf?.values ?? null;
    if (!idsfByBand) {
      continue;
    }

    for (let band = firstAnalyzedBand; band < idsfBandCount; band += 1) {
      const sourceBandReusesChannel0 =
        usesSharedMode3BandSource(chCount, band, mode3BandMask) && ch === 1;
      const sourceChannelIndex = sourceBandReusesChannel0 ? 0 : ch;
      const sourceChannel = channels?.[sourceChannelIndex] ?? null;
      const sourceBandLevel = channelBlocks?.[sourceChannelIndex]?.bandLevels?.[band] ?? 0;
      const quantMode = sourceChannel?.idwl?.values?.[band] ?? 0;
      const idsfIndex = idsfByBand[band] ?? 0;
      const idsfScale = AT5_SFTBL[idsfIndex] ?? 0;
      const slotWeight = spcSlotContributionWeight(band, idsfIndex);
      const quantizedSpectrum = sourceChannel?.scratchSpectra ?? null;
      const bandSampleCount = AT5_NSPS[band] ?? 0;
      const sourceBandIsReadyForSpcAnalysis =
        quantMode !== 0 &&
        sourceBandLevel > 0 &&
        idsfScale > 0 &&
        slotWeight > 0 &&
        !!quantizedSpectrum &&
        bandSampleCount !== 0;
      if (!sourceBandIsReadyForSpcAnalysis) {
        continue;
      }

      // Measure the current quantized band before synthesizing the matching
      // PWC band from the shared seed stream.
      const spectrumOffset = AT5_ISPS[band] ?? 0;
      const quantStep = (AT5_IFQF[quantMode] ?? 0) * idsfScale;
      const bandScaleWidth = bandSampleCount * idsfScale;
      const quantizedBandAbsSum = sumAbsoluteValues(
        quantizedSpectrum,
        bandSampleCount,
        spectrumOffset
      );
      const sourceBandPwcRatio =
        1 / sourceBandLevel -
        (quantizedBandAbsSum > 0 ? (quantStep * quantizedBandAbsSum) / bandScaleWidth : 0);
      const bandSeed = asI16(seedByMapIndex[AT5_X[band + 1] ?? 0] ?? 0);

      synthesizedPwcBandScratch.fill(0, 0, bandSampleCount);
      pwcQuAt5(
        channels,
        bandSeed,
        ch,
        band,
        quantMode,
        synthesizedPwcBandScratch,
        randomScratch,
        cachedSeedBand,
        shared,
        runtimeEntries
      );

      // Fold the synthesized band back into the slot accumulators that later
      // map the average PWC ratio onto packed SPC level indices.
      const synthesizedBandAbsSum = sumAbsoluteValues(synthesizedPwcBandScratch, bandSampleCount);
      const slotIndex = AT5_IDSPCQUS_BY_BAND[band] ?? 0;
      if (synthesizedBandAbsSum > 0) {
        pwcRatioSumBySlot[slotIndex] +=
          (bandScaleWidth / synthesizedBandAbsSum / quantStep) * sourceBandPwcRatio * slotWeight;
      }

      bandLevelSumBySlot[slotIndex] += sourceBandLevel * slotWeight;
      weightSumBySlot[slotIndex] = (weightSumBySlot[slotIndex] + slotWeight) >>> 0;
    }

    finalizeSpcSlots(
      slotLevels,
      firstActiveSlot,
      slotFinalizeEndExclusive,
      pwcRatioSumBySlot,
      bandLevelSumBySlot,
      weightSumBySlot,
      mode
    );
  }
}

/**
 * Retunes per-band scalefactor indices after PWC reconstruction so the
 * synthesized spectrum better matches the reference quantized spectrum, then
 * refreshes the packed IDSF bit totals.
 */
export function adjustScalefactorsAt5(
  blocks,
  quantizedSpectraByChannel,
  channels,
  channelCount,
  bandCount,
  coreMode
) {
  const channelTotal = channelCount | 0;
  const bands = bandCount | 0;
  if (channelTotal <= 0 || bands <= 0) {
    return;
  }

  const hdr = blocks?.[0]?.bitallocHeader ?? null;
  if (!hdr) {
    return;
  }

  const {
    seedByMapIndex,
    primaryBandScratch,
    secondaryBandScratch,
    randomScratch,
    cachedSeedBand,
  } = getSpcLevelScratchState(hdr);
  buildSpcSeedMap(
    seedByMapIndex,
    channels,
    (channels?.[0]?.shared?.idsfCount ?? 0) | 0,
    (channels?.[0]?.shared?.mapCount ?? 0) | 0,
    channelTotal
  );
  cachedSeedBand.value = -1;

  const mode3BandMask = hdr.mode3BandMask;
  const config = sfAdjustConfigForCoreMode(coreMode | 0, channelTotal);

  for (let band = config.startBand; band < bands; band += 1) {
    const seed = asI16(seedByMapIndex[AT5_X[band + 1] ?? 0] ?? 0);
    const bandOffset = AT5_ISPS[band] ?? 0;
    const coefficientCount = AT5_NSPS[band] ?? 0;
    const sharedMode3Band = usesSharedMode3BandSource(channelTotal, band, mode3BandMask);

    if (sharedMode3Band) {
      const sharedScratchSpectrum = channels?.[0]?.scratchSpectra ?? null;
      if (!sharedScratchSpectrum) {
        continue;
      }
      copyBandCoefficients(primaryBandScratch, sharedScratchSpectrum, bandOffset, coefficientCount);
      secondaryBandScratch.set(primaryBandScratch.subarray(0, coefficientCount), 0);
    }

    for (let channelIndex = 0; channelIndex < channelTotal; channelIndex += 1) {
      const channel = channels?.[channelIndex] ?? null;
      const idsfValues = channel?.idsf?.values ?? null;
      const targetSpectrum = quantizedSpectraByChannel?.[channelIndex] ?? null;
      if (!idsfValues || !(targetSpectrum instanceof Float32Array)) {
        continue;
      }

      const sourceChannelIndex = sharedMode3Band && channelIndex === 1 ? 0 : channelIndex;
      const quantMode = channels?.[sourceChannelIndex]?.idwl?.values?.[band] ?? 0;
      const baseIdsf = idsfValues[band] ?? 0;
      if (quantMode <= 0 || baseIdsf <= 0) {
        continue;
      }

      const pwcBandScratch =
        sharedMode3Band && channelIndex === 1 ? secondaryBandScratch : primaryBandScratch;
      if (!sharedMode3Band) {
        const scratchSpectrum = channel?.scratchSpectra ?? null;
        if (!scratchSpectrum) {
          continue;
        }
        copyBandCoefficients(pwcBandScratch, scratchSpectrum, bandOffset, coefficientCount);
      }

      pwcQuAt5(
        channels,
        seed,
        channelIndex,
        band,
        quantMode,
        pwcBandScratch,
        randomScratch,
        cachedSeedBand
      );

      const idsfScale = AT5_SFTBL[baseIdsf] ?? 0;
      const quantStep = (AT5_IFQF[quantMode] ?? 0) * idsfScale;
      const bandLevel = blocks?.[sourceChannelIndex]?.bandLevels?.[band] ?? 0;
      let synthesizedEnergy = 0;
      let targetEnergy = 0;
      for (let i = coefficientCount - 1; i >= 0; i -= 1) {
        const synthesized = pwcBandScratch[i];
        const reference = targetSpectrum[bandOffset + i];
        synthesizedEnergy += synthesized * synthesized;
        targetEnergy += reference * reference;
      }

      const synthesizedAbsSum = sumAbsoluteValues(pwcBandScratch, coefficientCount);
      const synthesizedScaleRatio =
        synthesizedAbsSum > 0 ? (coefficientCount * idsfScale) / synthesizedAbsSum : 0;
      const bandQuantScale = bandLevel * quantStep;
      idsfValues[band] = retuneScaleFactorIndex(
        baseIdsf,
        synthesizedEnergy * quantStep * quantStep,
        targetEnergy * idsfScale * idsfScale,
        bandLevel,
        bandQuantScale > 0 ? synthesizedScaleRatio / bandQuantScale : Number.POSITIVE_INFINITY,
        config
      );
    }
  }

  refreshPackedIdsfBitTotals(hdr, channels, channelTotal);
}

/**
 * Rebuilds SPC level indices from the current quantized spectra and the
 * initial mode-analysis band levels. This path is used during block seeding,
 * before the full late solve has rebuilt the live packed channel state.
 */
export function updateSpcLevelIndicesFromQuantizedData(
  block,
  runtimeBlock,
  initialModeAnalysis,
  coreMode
) {
  const shared = block?.shared ?? null;
  const channels = block?.channels ?? null;
  if (!shared || !Array.isArray(channels)) {
    return;
  }

  const runtimeShared = runtimeBlock?.shared ?? null;
  const channelCount = channels.length | 0;
  const bootstrapByChannel = initialModeAnalysis?.bootstrapByChannel ?? [];
  const bootstrapChannelBlocks = Array.from({ length: channelCount }, (_, ch) => ({
    bandLevels: bootstrapByChannel[ch]?.bandLevels ?? null,
  }));
  const spcLevelAnalysisEnabled = ((runtimeShared?.encodeFlags ?? 0) & 0x7c) === 0;
  const bootstrapSpcAnalysis = {
    channelBlocks: bootstrapChannelBlocks,
    enabledByChannel: Int32Array.from(bootstrapChannelBlocks, ({ bandLevels }) =>
      spcLevelAnalysisEnabled && bandLevels ? 1 : 0
    ),
    shared: {
      channels: channelCount,
      idsfCount: clampI32(shared.idsfCount | 0, 0, AT5_BANDS_MAX),
      mapCount: Math.max(0, shared.mapCount | 0),
    },
    runtime:
      runtimeBlock && typeof runtimeBlock === "object"
        ? runtimeBlock
        : {
            shared: runtimeShared,
            channelEntries: [],
            mode3BandMask: ArrayBuffer.isView(runtimeShared?.mode3BandMask)
              ? runtimeShared.mode3BandMask
              : null,
          },
  };
  if (ArrayBuffer.isView(runtimeShared?.swapMap)) {
    bootstrapSpcAnalysis.shared.swapMap = runtimeShared.swapMap;
  }

  computeSpcLevelSlotsAt5(
    bootstrapSpcAnalysis.channelBlocks,
    channels,
    bootstrapSpcAnalysis.runtime,
    bootstrapSpcAnalysis.shared,
    channelCount,
    coreMode,
    bootstrapSpcAnalysis.enabledByChannel
  );
}
