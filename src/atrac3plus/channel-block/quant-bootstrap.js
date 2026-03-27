import {
  AT5_CB_TABLE_SET0_A,
  AT5_CB_TABLE_SET0_B,
  AT5_CB_TABLE_SET0_C,
  AT5_CB_TABLE_SET1_A,
  AT5_CB_TABLE_SET1_B,
  AT5_CB_TABLE_SET1_C,
} from "../tables/encode-init.js";
import { usesDirectBitallocScaling } from "./bitalloc-heuristics.js";
import { AT5_BANDS_MAX, AT5_CORE_MODE_MAX } from "./constants.js";
import { getChannelWorkId } from "./core.js";
import { clampI32 } from "./primitives.js";

function addOffsetToRange(
  quantModeBaseByBand,
  value,
  start,
  end,
  limit = quantModeBaseByBand.length
) {
  if (value === 0) {
    return;
  }

  const hi = Math.max(0, Math.min(end | 0, limit | 0, quantModeBaseByBand.length));
  for (let i = Math.max(0, start | 0); i < hi; i += 1) {
    quantModeBaseByBand[i] += value;
  }
}

function clampQuantOffset(offset) {
  return offset > 0x0f ? 0x0f : offset;
}

function remap48kBandIndex(sampleRate, band) {
  return sampleRate === 48000 && band >= 0x12 && band < 0x1f ? band + 1 : band;
}

function assertChannelBlockScratch(block) {
  if (!block || !block.quantOffsetByBand || !block.normalizedBandPeaks) {
    throw new TypeError("invalid AT5 channel block scratch");
  }
}

function lowModeSeedBoostForQuantUnits(quantUnits) {
  return quantUnits > 0x12
    ? 0
    : quantUnits < 7
      ? 9
      : quantUnits <= 9
        ? 4
        : quantUnits < 0x0d
          ? 3
          : quantUnits < 0x10
            ? 2
            : 1;
}

function applyLowModeSeedBoosts(
  offsets,
  seededIdwlModesByBand,
  quantUnitsByBand,
  startBand,
  bandLimit
) {
  const firstBoostBand = Math.max(0, Math.min(startBand | 0, bandLimit | 0));
  if (firstBoostBand >= bandLimit) {
    return;
  }

  for (let band = firstBoostBand; band < bandLimit; band += 1) {
    if ((seededIdwlModesByBand?.[band] | 0) !== 1) {
      continue;
    }

    const boost = lowModeSeedBoostForQuantUnits(quantUnitsByBand?.[band] | 0);
    if (boost !== 0) {
      offsets[band] = clampQuantOffset(offsets[band] + boost);
    }
  }
}

function highBandMode1LiveBoost(band, quantUnits, bestCost) {
  const costThreshold =
    quantUnits < 0x0d ? 0x3c : quantUnits < 0x10 ? 0x46 : quantUnits < 0x13 ? 0x50 : 0;
  const sizeLimit = band > 0x17 ? 0x12 : band >= 0x16 ? 0x0f : 0x0c;
  return Number(costThreshold !== 0 && bestCost > costThreshold) + Number(quantUnits <= sizeLimit);
}

function applyLiveHighBandMode1Boosts(block, channel, bandCount) {
  const quantModes = channel?.idwl?.values ?? null;
  if (!(quantModes instanceof Uint32Array)) {
    return;
  }

  const activeWork = block?.hcspecWorkByCtx?.[getChannelWorkId(channel) & 1] ?? null;
  const bestIndexByBand = activeWork?.bestIndexByBand ?? null;
  const costsByBand = activeWork?.costsByBand ?? null;
  if (!(costsByBand instanceof Uint16Array) || !(bestIndexByBand instanceof Int32Array)) {
    return;
  }

  const bands = bandCount | 0;
  for (let band = 0x12; band < bands; band += 1) {
    if ((quantModes[band] | 0) !== 1) {
      continue;
    }

    const quantUnits = block.quantUnitsByBand?.[band] ?? 0;
    const bestCost = costsByBand[(band << 3) + (bestIndexByBand[band] | 0)] >>> 0;
    const boost = highBandMode1LiveBoost(band, quantUnits, bestCost);
    if (boost !== 0) {
      block.quantOffsetByBand[band] = clampQuantOffset(block.quantOffsetByBand[band] + boost);
    }
  }
}

export function applyLegacyLowBandOffsets(
  quantModeBaseByBand,
  limit,
  sampleRate,
  coreMode,
  channelCount,
  bitallocMode,
  hasAllGainRecords,
  avgBandLevel
) {
  const sampleRateValue = sampleRate | 0;
  const channels = channelCount | 0;
  const is48k = sampleRateValue === 48000;
  if (coreMode >= (sampleRateValue === 48000 ? 0x1a : 0x19)) {
    return;
  }

  const primaryOffset =
    bitallocMode < 3 ? (bitallocMode === 2 ? 0.5 : 0.25) : bitallocMode * 0.125 + 0.75;
  addOffsetToRange(quantModeBaseByBand, primaryOffset, 0, 8);

  if (channels === 2) {
    const stereoOffset =
      is48k && coreMode >= 0x18
        ? 0
        : coreMode < 0x0e
          ? 0.7
          : coreMode < 0x10
            ? 1.0
            : is48k
              ? 0.75
              : 0.5;
    addOffsetToRange(quantModeBaseByBand, stereoOffset, 0, 8);
  } else {
    const prefixOffset = is48k ? (coreMode < 0x0e ? 0.7 : coreMode < 0x10 ? 0.75 : 0.5) : 0.5;
    const prefixCount = is48k ? 8 : coreMode >= 0x0c && coreMode < 0x0e ? 0x0c : 8;
    const tailOffset = is48k ? (coreMode < 0x0c ? 0.25 : 0.5) : 0.25;
    const tailEnd = is48k
      ? coreMode < 0x0c
        ? 0x0e
        : coreMode < 0x0e
          ? 0x0c
          : 8
      : coreMode < 0x0c
        ? 0x0e
        : 8;

    addOffsetToRange(quantModeBaseByBand, prefixOffset, 0, prefixCount);
    addOffsetToRange(quantModeBaseByBand, tailOffset, 8, tailEnd, limit);
  }

  if (!hasAllGainRecords && ((channels === 2 && coreMode > 0x0c) || coreMode > 10)) {
    addOffsetToRange(
      quantModeBaseByBand,
      avgBandLevel < 2.9
        ? -0.75
        : Math.min(0.5, -0.5 + Math.trunc((avgBandLevel - 2.9) * 10) * 0.25),
      0,
      8
    );
  }
}

export function applyWideGainBoost(
  quantModeBaseByBand,
  bandLevels,
  limit = quantModeBaseByBand.length
) {
  const bandLimit = Math.max(0, Math.min(limit | 0, quantModeBaseByBand.length));
  for (let band = 0; band < bandLimit; band += 1) {
    quantModeBaseByBand[band] += (bandLevels?.[band] ?? 0) >= 3 ? 1.25 : 0.5;
  }
}

export function fillMaxIdwlModes(
  maxIdwlModes,
  bandLevels,
  limit,
  baseMaxQuantMode,
  bitallocMode,
  wideGainBoostFlag
) {
  const bandLimit = Math.max(0, Math.min(limit | 0, maxIdwlModes.length));
  const lowBandLimit = Math.min(8, bandLimit);
  const minimumMode = bitallocMode | 0;
  const lowBandBoost = (wideGainBoostFlag | 0) !== 0 ? 1 : 0;

  maxIdwlModes.fill(baseMaxQuantMode | 0);
  for (let band = 0; band < bandLimit; band += 1) {
    const level = bandLevels?.[band] ?? 0;
    let mode =
      (maxIdwlModes[band] | 0) +
      (level >= 6 ? 2 : level >= 3.5 ? 1 : 0) +
      (band < lowBandLimit ? lowBandBoost : 0);

    if (band < lowBandLimit && mode < minimumMode) {
      mode = minimumMode;
    }
    maxIdwlModes[band] = Math.min(7, mode);
  }
}

export function fillQuantModeBaseFromQuantUnits(
  quantModeBaseByBand,
  quantUnitsByBand,
  bandCount,
  bitallocScale,
  wcfxTable,
  sampleRate,
  encodeFlags,
  { roundWeightedScale = false } = {}
) {
  if (!(quantModeBaseByBand instanceof Float32Array)) {
    return;
  }

  const limit = Math.max(0, Math.min(bandCount | 0, quantModeBaseByBand.length));
  const scale = bitallocScale ?? 0;
  quantModeBaseByBand.fill(0);

  if (usesDirectBitallocScaling(encodeFlags)) {
    const directScale = scale / 10;
    for (let band = 0; band < limit; band += 1) {
      quantModeBaseByBand[band] = (quantUnitsByBand?.[band] | 0) * directScale;
    }
    return;
  }

  for (let band = 0; band < limit; band += 1) {
    const quantUnits = quantUnitsByBand?.[band] | 0;
    const tableBand = remap48kBandIndex(sampleRate, band);
    let scaled = quantUnits * scale;
    if (roundWeightedScale && tableBand === band) {
      scaled = Math.fround(scaled);
    }
    quantModeBaseByBand[band] = scaled * (wcfxTable[tableBand] ?? 0);
  }
}

/**
 * Seeds per-band quant offsets from the ATRAC3plus mode tables and applies the
 * extra low-mode boosts for bands whose initial analysis already wants
 * mode-1 coding.
 */
export function prepareQuantOffsets(
  channelCount,
  bandLimit,
  coreMode,
  sampleRateHz,
  bootstrapByChannel = null
) {
  const channels = Math.max(0, channelCount | 0);
  const mode = coreMode | 0;
  const sampleRate = sampleRateHz >>> 0;
  const iterLimitByMode = channels === 2 ? AT5_CB_TABLE_SET1_A : AT5_CB_TABLE_SET0_A;
  const startBandByMode = channels === 2 ? AT5_CB_TABLE_SET1_B : AT5_CB_TABLE_SET0_B;
  const baseOffsetTable = channels === 2 ? AT5_CB_TABLE_SET1_C : AT5_CB_TABLE_SET0_C;
  const modeRowBase = (mode * AT5_BANDS_MAX) | 0;
  const limit = Math.max(0, Math.min(bandLimit | 0, AT5_BANDS_MAX));
  const startBand = (startBandByMode[mode] ?? 0) | 0;
  const iterLimit = (iterLimitByMode[mode] ?? 0) | 0;
  const baseOffsetByBand = new Uint8Array(AT5_BANDS_MAX);
  const useLowModeSeedBoosts = mode < 0x10;

  for (let band = 0; band < limit; band += 1) {
    baseOffsetByBand[band] =
      baseOffsetTable[modeRowBase + remap48kBandIndex(sampleRate, band)] ?? 0;
  }

  const quantOffsetByChannel = new Array(channels);
  for (let ch = 0; ch < channels; ch += 1) {
    const offsets = baseOffsetByBand.slice();
    if (useLowModeSeedBoosts) {
      applyLowModeSeedBoosts(
        offsets,
        bootstrapByChannel?.[ch]?.seededIdwlModesByBand ?? null,
        bootstrapByChannel?.[ch]?.quantUnitsByBand ?? null,
        startBand,
        limit
      );
    }
    quantOffsetByChannel[ch] = offsets;
  }

  return { quantOffsetByChannel, startBand, iterLimit };
}

/**
 * Initializes each live channel-block scratch table from the shared bootstrap
 * seed path, then layers the encoder-only high-band mode-1 boosts on top.
 */
export function at5InitQuantOffsets(
  blocks,
  channelCtxList,
  hdr,
  channelCount,
  bandCount,
  coreMode,
  sampleRateHz
) {
  const chCount = channelCount | 0;
  const bands = bandCount | 0;
  const mode = coreMode | 0;
  const sampleRate = sampleRateHz >>> 0;

  const { quantOffsetByChannel, startBand, iterLimit } = prepareQuantOffsets(
    chCount,
    bands,
    mode,
    sampleRate
  );

  hdr.cbStartBand = startBand >>> 0;
  hdr.cbIterLimit = iterLimit >>> 0;
  const usesLowModeSeedBoosts = mode < 0x10;
  const canBoostHighMode1Bands = usesLowModeSeedBoosts && bands > 0x12;

  for (let ch = 0; ch < chCount; ch += 1) {
    const block = blocks[ch];
    const channel = channelCtxList?.[ch];
    const quantOffsets = quantOffsetByChannel[ch];
    assertChannelBlockScratch(block);
    if (usesLowModeSeedBoosts) {
      applyLowModeSeedBoosts(
        quantOffsets,
        channel?.idwl?.values ?? null,
        block?.quantUnitsByBand,
        startBand,
        bands
      );
    }
    block.quantOffsetByBand.set(quantOffsets.subarray(0, bands), 0);
    if (canBoostHighMode1Bands) {
      applyLiveHighBandMode1Boosts(block, channel, bands);
    }
  }
}

export function initQuantOffsets(runtimeBlock, bandLimit, initialModeAnalysis = null) {
  const channels = runtimeBlock?.channelsInBlock | 0;
  const runtimeShared = runtimeBlock?.shared ?? null;
  const coreMode = clampI32(
    runtimeShared?.coreMode ?? runtimeBlock?.coreMode ?? 0,
    0,
    AT5_CORE_MODE_MAX
  );
  const sampleRate = (runtimeShared?.sampleRateHz ?? 44100) | 0;

  return prepareQuantOffsets(
    channels,
    bandLimit,
    coreMode,
    sampleRate,
    initialModeAnalysis?.bootstrapByChannel ?? null
  ).quantOffsetByChannel;
}
