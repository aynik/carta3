import {
  at5ActiveBandCount,
  at5HcspecDescForBand,
  at5PackHcspecForBand,
  createAt5RegularBlockState,
} from "../bitstream/internal.js";
import { sharedMapSegmentCount } from "../shared-fields.js";
import {
  AT5_SECOND_BIT_STEP,
  AT5_SECOND_BIT_STEP_HALF,
  AT5_SECOND_BIT_STEP_SCALE,
} from "../tables/encode-bitalloc.js";
import { AT5_CB_TABLE_SET0_A, AT5_CB_TABLE_SET1_A } from "../tables/encode-init.js";
import { AT5_IFQF, AT5_SFTBL } from "../tables/decode.js";
import { AT5_ISPS, AT5_NSPS, at5MapCountForBandCount } from "../tables/unpack.js";
import { AT5_BANDS_MAX, AT5_CORE_MODE_MAX } from "./constants.js";
import { at5BaseMaxQuantModeForCoreMode } from "./metadata.js";
import { at5RoundHalfUp, clampI32 } from "./primitives.js";
import { CodecError } from "../../common/errors.js";
import {
  allowsExtraBitallocBoost,
  clampBitallocOffset,
  computeBitallocMode,
  createBitallocOffsetState,
  equalizedStereoBitallocMode,
  firstGainRecordHasWideLevels,
  gainRecordRangeFlag,
  hasAllGainRecordsInPrefix,
  quantModeForBitallocOffset,
  searchBitallocOffset,
  selectWcfxTable,
  sfAdjustConfigForCoreMode,
  usesDirectBitallocScaling,
} from "./bitalloc-heuristics.js";
import {
  applyLegacyLowBandOffsets,
  applyWideGainBoost,
  fillMaxIdwlModes,
  fillQuantModeBaseFromQuantUnits,
  initQuantOffsets,
} from "./quant-bootstrap.js";
import {
  applyRuntimeStereoSwapPresence,
  buildSwapAdjustedSpectra,
  clearBandTail,
  copyGainRecordsFromRuntime,
  copyPresenceFromRuntime,
} from "./runtime.js";
import { updateSpcLevelIndicesFromQuantizedData } from "./spc-levels.js";
import {
  quantizeBandAt5,
  quantizeBandScalar,
  quantizeBandScalarWithIdsfRefine,
} from "./quantize.js";

const AT5_BASIC_BLOCK_FALLBACK_SCALE = 0.95;

function nearestScaleFactorIndex(max) {
  if (!(max > 0)) {
    return 0;
  }

  let bestIndex = 0;
  let bestError = Math.abs(max - AT5_SFTBL[0]);
  for (let i = 1; i < AT5_SFTBL.length; i += 1) {
    const error = Math.abs(max - AT5_SFTBL[i]);
    if (error < bestError) {
      bestError = error;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function weightedBandPeak(peak, sum, coefficientCount) {
  return peak > 0 && sum > 0 ? (coefficientCount * peak) / sum : 1;
}

function measureInitialModeBits(bootstrapByChannel, bandLimit, offset, bitallocOffsetState) {
  const channelCount = bitallocOffsetState.channelCount | 0;
  let totalBits = 96 + (channelCount * 2 + 4) * bandLimit;

  for (let ch = 0; ch < channelCount; ch += 1) {
    const channelBootstrap = bootstrapByChannel[ch];
    for (let band = 0; band < bandLimit; band += 1) {
      const mode = quantModeForBitallocOffset(
        (channelBootstrap.quantUnitsByBand[band] | 0) !== 0,
        channelBootstrap.maxIdwlModesByBand[band] | 0,
        channelBootstrap.quantModeBaseByBand[band],
        band,
        offset,
        bitallocOffsetState
      );
      if (mode === 0) {
        continue;
      }

      totalBits += (AT5_NSPS[band] >>> 0) * (0.35 + mode * 0.42) + mode * 2;
    }
  }

  return totalBits;
}

export function maxAbsInBand(spec, start, count) {
  let maxAbs = 0;
  for (let i = start | 0, end = (start + count) | 0; i < end; i += 1) {
    const value = Math.abs(spec[i]);
    if (value > maxAbs) {
      maxAbs = value;
    }
  }
  return maxAbs;
}

/**
 * Builds the band-by-band bootstrap analysis that seeds ATRAC3plus temporary
 * block quantization before the later rebitalloc passes refine it.
 */
export function computeInitialModeAnalysis(
  runtimeBlock,
  bandLimit,
  bootstrapSpectraByChannel = null,
  { secondBitOffset: secondBitOffsetOverride = null } = {}
) {
  const channelCount = runtimeBlock?.channelsInBlock | 0;
  const limit = Math.max(0, Math.min(bandLimit | 0, AT5_BANDS_MAX));
  const shared = runtimeBlock?.shared ?? null;
  const runtimeChannels = runtimeBlock?.channelEntries;
  const analysisSpectraByChannel =
    bootstrapSpectraByChannel?.analysis ??
    bootstrapSpectraByChannel?.analysisSpectraByChannel ??
    runtimeBlock?.quantizedSpectraByChannel;
  const scaleFactorSpectraByChannel =
    bootstrapSpectraByChannel?.scaleFactors ??
    bootstrapSpectraByChannel?.scaleFactorSpectraByChannel ??
    bootstrapSpectraByChannel?.idsfSpectraByChannel ??
    runtimeBlock?.bitallocSpectraByChannel;
  const coreMode = clampI32(shared?.coreMode ?? runtimeBlock?.coreMode ?? 0, 0, AT5_CORE_MODE_MAX);
  const sampleRate = (shared?.sampleRateHz ?? 44100) | 0;
  const encodeFlags = (shared?.encodeFlags ?? 0) | 0;
  const baseMaxQuantMode = at5BaseMaxQuantModeForCoreMode(
    coreMode,
    channelCount,
    runtimeBlock?.blockState?.isMode4Block ?? 0
  );
  const iterLimit =
    ((channelCount === 2 ? AT5_CB_TABLE_SET1_A : AT5_CB_TABLE_SET0_A)[coreMode] ?? 0) | 0;
  const wcfxTable = selectWcfxTable(coreMode, channelCount);
  const gainPrefixRecordCount = Math.min(sharedMapSegmentCount(shared), 8);
  const bootstrapByChannel = new Array(channelCount);
  let maxQuantUnitsAcrossChannels = 1;

  for (let ch = 0; ch < channelCount; ch += 1) {
    const runtimeChannel = runtimeChannels?.[ch];
    const scaleFactorSpectrum = scaleFactorSpectraByChannel?.[ch];
    if (!(scaleFactorSpectrum instanceof Float32Array)) {
      throw new CodecError("missing ATRAC3plus frequency-domain spectrum");
    }

    const analysisSpectrum =
      analysisSpectraByChannel?.[ch] instanceof Float32Array
        ? analysisSpectraByChannel[ch]
        : scaleFactorSpectrum;
    const channelBootstrap = {
      scaleFactorIndexByBand: new Uint32Array(AT5_BANDS_MAX),
      peakMagnitudeByBand: new Float32Array(AT5_BANDS_MAX),
      quantUnitsByBand: new Int32Array(AT5_BANDS_MAX),
      bandLevels: new Float32Array(AT5_BANDS_MAX),
      firstGainRecordIsWide: firstGainRecordHasWideLevels(runtimeChannel),
      hasFullGainPrefix: hasAllGainRecordsInPrefix(runtimeChannel, gainPrefixRecordCount),
      avgBandLevel: 0,
      seededIdwlModesByBand: new Int32Array(AT5_BANDS_MAX),
      maxIdwlModesByBand: new Int32Array(AT5_BANDS_MAX),
      quantModeBaseByBand: new Float32Array(AT5_BANDS_MAX),
      bitallocMode: computeBitallocMode(analysisSpectrum, gainRecordRangeFlag(runtimeChannel)) | 0,
    };
    let totalBandLevel = 0;
    let maxQuantUnits = 1;
    const reuseAnalysisSpectrum = analysisSpectrum === scaleFactorSpectrum;
    for (let band = 0; band < limit; band += 1) {
      const bandStart = AT5_ISPS[band] >>> 0;
      const bandCoeffCount = AT5_NSPS[band] >>> 0;
      const bandEnd = bandStart + bandCoeffCount;

      let analysisPeak = 0;
      let analysisSum = 0;
      let scaleFactorPeak = 0;
      let scaleFactorSum = 0;
      for (let i = bandStart; i < bandEnd; i += 1) {
        const analysisValue = Math.abs(analysisSpectrum[i]);
        analysisSum += analysisValue;
        if (analysisValue > analysisPeak) {
          analysisPeak = analysisValue;
        }

        const scaleFactorValue = reuseAnalysisSpectrum
          ? analysisValue
          : Math.abs(scaleFactorSpectrum[i]);
        scaleFactorSum += scaleFactorValue;
        if (scaleFactorValue > scaleFactorPeak) {
          scaleFactorPeak = scaleFactorValue;
        }
      }

      const analysisIndex = nearestScaleFactorIndex(analysisPeak);
      const scaleFactorIndex = nearestScaleFactorIndex(scaleFactorPeak);
      const quantUnit = at5RoundHalfUp((analysisIndex + scaleFactorIndex) * 0.5);
      const bandLevel =
        (weightedBandPeak(analysisPeak, analysisSum, bandCoeffCount) +
          weightedBandPeak(scaleFactorPeak, scaleFactorSum, bandCoeffCount)) *
        0.5;

      channelBootstrap.scaleFactorIndexByBand[band] = scaleFactorIndex;
      channelBootstrap.peakMagnitudeByBand[band] = scaleFactorPeak;
      channelBootstrap.quantUnitsByBand[band] = quantUnit;
      channelBootstrap.bandLevels[band] = bandLevel;
      totalBandLevel += bandLevel;
      maxQuantUnits = Math.max(maxQuantUnits, quantUnit);
    }

    channelBootstrap.avgBandLevel = limit > 0 ? totalBandLevel / limit : 0;
    bootstrapByChannel[ch] = channelBootstrap;
    maxQuantUnitsAcrossChannels = Math.max(maxQuantUnitsAcrossChannels, maxQuantUnits);
  }

  if (channelCount === 2) {
    const stereoBitallocMode = equalizedStereoBitallocMode(
      bootstrapByChannel[0].bitallocMode,
      bootstrapByChannel[1].bitallocMode
    );
    if (stereoBitallocMode !== null) {
      bootstrapByChannel[0].bitallocMode = stereoBitallocMode;
      bootstrapByChannel[1].bitallocMode = stereoBitallocMode;
    }
  }

  const bitallocScale = (baseMaxQuantMode * 10) / maxQuantUnitsAcrossChannels;
  const lowBandBoostLimit = Math.min(8, limit);
  const wideGainBoostAllowed = allowsExtraBitallocBoost(coreMode, channelCount);
  for (const channelBootstrap of bootstrapByChannel) {
    const wideGainBoostFlag =
      wideGainBoostAllowed && channelBootstrap.firstGainRecordIsWide ? 1 : 0;

    fillQuantModeBaseFromQuantUnits(
      channelBootstrap.quantModeBaseByBand,
      channelBootstrap.quantUnitsByBand,
      limit,
      bitallocScale,
      wcfxTable,
      sampleRate,
      encodeFlags
    );
    applyLegacyLowBandOffsets(
      channelBootstrap.quantModeBaseByBand,
      limit,
      sampleRate,
      coreMode,
      channelCount,
      channelBootstrap.bitallocMode,
      channelBootstrap.hasFullGainPrefix,
      channelBootstrap.avgBandLevel
    );
    fillMaxIdwlModes(
      channelBootstrap.maxIdwlModesByBand,
      channelBootstrap.bandLevels,
      limit,
      baseMaxQuantMode,
      channelBootstrap.bitallocMode,
      wideGainBoostFlag
    );
    if (wideGainBoostFlag !== 0) {
      applyWideGainBoost(
        channelBootstrap.quantModeBaseByBand,
        channelBootstrap.bandLevels,
        lowBandBoostLimit
      );
    }
  }

  const bitallocOffsetState = createBitallocOffsetState(
    channelCount,
    sampleRate,
    encodeFlags,
    coreMode
  );
  const requestedBitallocOffset =
    secondBitOffsetOverride == null ? Number.NaN : Number(secondBitOffsetOverride);
  const bitallocOffset = clampBitallocOffset(
    Number.isFinite(requestedBitallocOffset)
      ? requestedBitallocOffset
      : estimateBitallocOffset(
          bootstrapByChannel,
          limit,
          runtimeBlock?.bitsForBlock | 0,
          bitallocOffsetState
        )
  );
  for (const channelBootstrap of bootstrapByChannel) {
    for (let band = 0; band < limit; band += 1) {
      channelBootstrap.seededIdwlModesByBand[band] = quantModeForBitallocOffset(
        (channelBootstrap.quantUnitsByBand[band] | 0) !== 0,
        channelBootstrap.maxIdwlModesByBand[band] | 0,
        channelBootstrap.quantModeBaseByBand[band],
        band,
        bitallocOffset,
        bitallocOffsetState
      );
    }
  }

  return {
    baseMaxQuantMode: baseMaxQuantMode | 0,
    iterLimit,
    secondBitOffset: bitallocOffset,
    bootstrapByChannel,
  };
}

/**
 * Estimates the shared bitalloc offset that keeps the initial mode selection
 * near the block bit budget before exact packing data is available.
 */
export function estimateBitallocOffset(
  bootstrapByChannel,
  bandLimit,
  bitLimit,
  bitallocOffsetState
) {
  const limit = Math.max(1, bandLimit | 0);
  const bitBudget = Math.max(1, bitLimit | 0);
  const minimumAcceptedBits = Math.trunc(
    bitBudget *
      (usesDirectBitallocScaling(bitallocOffsetState.encodeFlags)
        ? AT5_SECOND_BIT_STEP_HALF
        : AT5_SECOND_BIT_STEP_SCALE)
  );

  return searchBitallocOffset(
    bitBudget,
    minimumAcceptedBits,
    measureInitialModeBits(bootstrapByChannel, limit, AT5_SECOND_BIT_STEP, bitallocOffsetState) >=
      bitBudget,
    7,
    (offset) => measureInitialModeBits(bootstrapByChannel, limit, offset, bitallocOffsetState)
  );
}

/**
 * Probes every HCSPEC codebook for the already-quantized band and returns the
 * packable IDCT index that yields the shortest payload.
 */
function findPackableIdctIndexForBand(channel, scratchBytes, scratchBitState, band, quantMode) {
  const shared = channel.shared;
  const coefficientCount = AT5_NSPS[band] >>> 0;
  if (coefficientCount === 0) {
    return 0;
  }

  const start = AT5_ISPS[band] >>> 0;
  const bandCoefficients = channel.scratchSpectra.subarray(start, start + coefficientCount);

  const previousQuantMode = channel.idwl.values[band] | 0;
  const previousIdctIndex = channel.idct.values[band] | 0;
  let bestIdctIndex = -1;
  let bestBits = Number.POSITIVE_INFINITY;
  channel.idwl.values[band] = quantMode >>> 0;

  for (let idctIndex = 0; idctIndex <= 7; idctIndex += 1) {
    channel.idct.values[band] = idctIndex;
    scratchBitState.bitpos = 0;
    if (
      !at5PackHcspecForBand(
        bandCoefficients,
        coefficientCount,
        at5HcspecDescForBand(shared, channel, band),
        scratchBytes,
        scratchBitState
      )
    ) {
      continue;
    }

    const bits = scratchBitState.bitpos | 0;
    if (bits < bestBits) {
      bestBits = bits;
      bestIdctIndex = idctIndex;
    }
  }

  channel.idwl.values[band] = previousQuantMode >>> 0;
  channel.idct.values[band] = previousIdctIndex;
  return bestIdctIndex;
}

/**
 * Builds a temporary ATRAC3plus regular-block encode plan from runtime
 * analysis, including swap-adjusted spectra, shared header state, and the
 * initial mode decisions that drive the basic-block bootstrap.
 */
export function createBasicBlockPlan(
  runtimeBlock,
  {
    bandLimit: bandLimitOverride = null,
    quantStepScale = 1,
    useExactQuant = false,
    secondBitOffset = null,
  } = {}
) {
  const channelCount = runtimeBlock?.channelsInBlock | 0;
  if (channelCount < 1 || channelCount > 2) {
    throw new CodecError(`unsupported ATRAC3plus runtime block channel count: ${channelCount}`);
  }

  const maxBands = Math.max(1, Math.min(runtimeBlock.ispsIndex | 0, 32));
  const bandLimit =
    bandLimitOverride == null ? maxBands : Math.max(1, Math.min(bandLimitOverride | 0, maxBands));
  const block = createAt5RegularBlockState(channelCount);
  const shared = block.shared;
  const runtimeShared = runtimeBlock?.shared ?? null;
  const mapSegmentCount =
    bandLimitOverride == null
      ? sharedMapSegmentCount(runtimeShared ?? shared)
      : at5MapCountForBandCount(bandLimit);
  Object.assign(shared, {
    channels: channelCount >>> 0,
    stereoFlag: channelCount === 2 ? 1 : 0,
    codedBandLimit: bandLimit >>> 0,
    mapSegmentCount,
    gainModeFlag: (runtimeBlock?.blockState?.encodeMode ?? 0) === 2 ? 0 : 1,
    noiseFillEnabled: 0,
    noiseFillShift: 0,
    noiseFillCursor: 0,
    zeroSpectraFlag: 0,
  });
  block.idwlShared.codedBandLimit = bandLimit >>> 0;
  block.idwlShared.pairCount = 0;
  block.idwlShared.pairFlags.fill(0);

  const { quantizedSpectraByChannel, bitallocSpectraByChannel } = buildSwapAdjustedSpectra(
    runtimeBlock,
    channelCount,
    bandLimit
  );
  const initialModeAnalysis = computeInitialModeAnalysis(
    runtimeBlock,
    bandLimit,
    {
      // Initial-mode analysis derives band activity from the swap-adjusted
      // analysis view while keeping scale-factor/magnitude decisions aligned to the
      // spectrum that will actually be quantized into the temporary block.
      analysis: bitallocSpectraByChannel,
      scaleFactors: quantizedSpectraByChannel,
    },
    {
      secondBitOffset,
    }
  );
  const bootstrapByChannel = initialModeAnalysis.bootstrapByChannel;
  const quantOffsetsByChannel = useExactQuant
    ? initQuantOffsets(runtimeBlock, bandLimit, { bootstrapByChannel })
    : null;
  const coreMode = clampI32(
    runtimeShared?.coreMode ?? runtimeBlock?.coreMode ?? 0,
    0,
    AT5_CORE_MODE_MAX
  );
  return {
    block,
    runtimeBlock,
    useExactQuant,
    quantOffsetsByChannel,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
    initialModeAnalysis,
    quantStepScale: Math.max(0.03125, quantStepScale),
    sfAdjustConfig: sfAdjustConfigForCoreMode(coreMode, channelCount),
    packScratchBytes: new Uint8Array(2048),
    packScratchBitState: { bitpos: 0 },
  };
}

/**
 * Encodes one channel of the temporary basic block from the initial mode
 * analysis, choosing either the exact or refined scalar quantization path for
 * each active band and keeping only packable HCSPEC outputs.
 */
export function encodeBasicBlockPlanChannel(plan, channelIndex) {
  const ch = channelIndex | 0;
  const {
    block,
    runtimeBlock,
    initialModeAnalysis,
    quantOffsetsByChannel,
    quantizedSpectraByChannel,
    packScratchBytes,
    packScratchBitState,
    quantStepScale,
    sfAdjustConfig,
    useExactQuant,
  } = plan;
  const { shared } = block;
  const bandLimit = shared.codedBandLimit | 0;
  const mapSegmentCount = shared.mapSegmentCount | 0;
  const channel = block.channels[ch] ?? null;
  const runtimeChannel = runtimeBlock?.channelEntries?.[ch] ?? null;
  const channelBootstrap = initialModeAnalysis?.bootstrapByChannel?.[ch] ?? null;
  const sourceSpectrum = quantizedSpectraByChannel?.[ch] ?? null;
  if (!channel || !channelBootstrap || !(sourceSpectrum instanceof Float32Array)) {
    throw new CodecError(`missing ATRAC3plus basic-block channel inputs for channel ${ch}`);
  }

  const quantOffsets = quantOffsetsByChannel?.[ch] ?? null;
  const scratchSpectra = channel.scratchSpectra;
  const idwlValues = channel.idwl.values;
  const scaleFactorValues = channel.idsf.values;
  const idctValues = channel.idct.values;
  idwlValues.fill(0);
  scaleFactorValues.fill(0);
  idctValues.fill(0);
  scratchSpectra.fill(0);
  channel.spclevIndex.fill(0xf);
  channel.idwlPackMode = 0;
  channel.idsfModeSelect = 0;
  channel.idctTableCtx = 0;
  channel.idctModeSelect = 0;
  channel.idct.flag = 0;
  channel.idct.count = 0;
  copyGainRecordsFromRuntime(channel, runtimeChannel, mapSegmentCount);
  copyPresenceFromRuntime(channel, runtimeChannel, mapSegmentCount);

  for (let band = 0; band < bandLimit; band += 1) {
    const scaleFactorIndex = channelBootstrap.scaleFactorIndexByBand[band] >>> 0;
    const magnitude = channelBootstrap.peakMagnitudeByBand[band];
    if (scaleFactorIndex === 0 || !(magnitude > 0)) {
      continue;
    }

    const quantMode = Math.min(
      channelBootstrap.seededIdwlModesByBand[band] | 0,
      channelBootstrap.maxIdwlModesByBand[band] | 0
    );
    const scaleFactor = AT5_SFTBL[scaleFactorIndex] ?? 0;
    if (!(scaleFactor > 0) || quantMode <= 0 || !AT5_IFQF[quantMode]) {
      continue;
    }

    const start = AT5_ISPS[band] >>> 0;
    const coefficientCount = AT5_NSPS[band] >>> 0;
    let committedScaleFactorIndex = scaleFactorIndex;
    let packableIdctIndex = -1;

    if (useExactQuant) {
      const quantScale = (magnitude / scaleFactor) * quantStepScale;
      const quantOffsetFloor = Math.max(0, (((quantOffsets?.[band] ?? 0) >>> 0) & 0x0f) - 2);

      for (let quantOffset = quantOffsetFloor; quantOffset <= 0x0f; quantOffset += 1) {
        if (
          quantizeBandAt5(
            sourceSpectrum,
            start,
            coefficientCount,
            quantMode,
            quantOffset,
            scaleFactor,
            quantScale,
            scratchSpectra
          ) === 0
        ) {
          continue;
        }

        packableIdctIndex = findPackableIdctIndexForBand(
          channel,
          packScratchBytes,
          packScratchBitState,
          band,
          quantMode
        );
        if (packableIdctIndex >= 0) {
          break;
        }
      }

      if (packableIdctIndex < 0) {
        const fallbackStep =
          (AT5_IFQF[quantMode] ?? 0) *
          scaleFactor *
          AT5_BASIC_BLOCK_FALLBACK_SCALE *
          quantStepScale;
        if (
          quantizeBandScalar(
            sourceSpectrum,
            start,
            coefficientCount,
            fallbackStep,
            quantMode,
            scratchSpectra
          ) !== 0
        ) {
          packableIdctIndex = findPackableIdctIndexForBand(
            channel,
            packScratchBytes,
            packScratchBitState,
            band,
            quantMode
          );
        }
      }
    } else {
      const refined = quantizeBandScalarWithIdsfRefine(
        sourceSpectrum,
        channel,
        band,
        quantMode,
        scaleFactorIndex,
        quantStepScale,
        AT5_BASIC_BLOCK_FALLBACK_SCALE,
        sfAdjustConfig,
        channelBootstrap.bandLevels[band] ?? 1
      );
      if ((refined.nonzero | 0) !== 0) {
        packableIdctIndex = findPackableIdctIndexForBand(
          channel,
          packScratchBytes,
          packScratchBitState,
          band,
          quantMode
        );
        if (packableIdctIndex >= 0) {
          committedScaleFactorIndex = refined.idsf >>> 0;
        }
      }
    }

    if (packableIdctIndex < 0) {
      scratchSpectra.fill(0, start, start + coefficientCount);
      continue;
    }

    idwlValues[band] = quantMode >>> 0;
    scaleFactorValues[band] = committedScaleFactorIndex;
    idctValues[band] = packableIdctIndex >>> 0;
  }
}

/**
 * Builds the temporary regular block used as the starting point for the later
 * ATRAC3plus channel-block bitalloc passes.
 */
export function buildBasicAt5RegularBlockFromRuntime(runtimeBlock, options = {}) {
  const plan = createBasicBlockPlan(runtimeBlock, options);
  const { block, initialModeAnalysis } = plan;
  const { shared, channels, idsfShared } = block;
  const channelCount = shared.channels | 0;

  for (let ch = 0; ch < channelCount; ch += 1) {
    encodeBasicBlockPlanChannel(plan, ch);
  }

  block.encoderDebug = { secondBitOffset: initialModeAnalysis.secondBitOffset };

  const idsfCount =
    at5ActiveBandCount(
      channels[0]?.idwl?.values,
      channels[1]?.idwl?.values,
      shared.codedBandLimit | 0,
      channelCount
    ) >>> 0;
  const mapCount = at5MapCountForBandCount(idsfCount) >>> 0;
  shared.idsfCount = idsfShared.idsfCount = idsfCount;
  shared.mapCount = idsfShared.idsfGroupCount = mapCount;

  updateSpcLevelIndicesFromQuantizedData(
    block,
    runtimeBlock,
    initialModeAnalysis,
    clampI32(runtimeBlock?.shared?.coreMode ?? runtimeBlock?.coreMode ?? 0, 0, AT5_CORE_MODE_MAX)
  );
  applyRuntimeStereoSwapPresence(block, runtimeBlock);

  const gainModeFlag = shared.gainModeFlag >>> 0;
  for (let ch = 0; ch < channelCount; ch += 1) {
    const channel = channels[ch];
    const idctShared = channel.idctState.shared;
    clearBandTail(channel, idsfCount);
    channel.idct.count = idsfCount;
    idctShared.maxCount = idsfCount;
    idctShared.fixIdx = gainModeFlag;
    idctShared.gainModeFlag = gainModeFlag;
  }

  return block;
}
