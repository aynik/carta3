import { subSeqAt5 } from "../dsp.js";
import {
  at5ActiveBandCount,
  at5PackGainIdlev0,
  at5PackGainIdlev1,
  at5PackGainIdlev2,
  at5PackGainIdlev3,
  at5PackGainIdlev4,
  at5PackGainIdlev5,
  at5PackGainIdloc0,
  at5PackGainIdloc1,
  at5PackGainIdloc2,
  at5PackGainIdloc3,
  at5PackGainIdloc4,
  at5PackGainIdloc5,
  at5PackGainIdloc6,
  at5PackGainNgc0,
  at5PackGainNgc1,
  at5PackGainNgc2Ch0,
  at5PackGainNgc3Ch0,
  at5PackGainNgc4Ch1,
  calcNbitsForGhaAt5,
  calcNbitsForIdctAt5,
  calcNbitsForIdsfChAt5,
  syncGhStateFromSigprocSlotsAt5,
  updateAt5PresenceTableBits,
} from "../bitstream/internal.js";
import { at5SigprocCorrHistoryViews, at5SigprocMode3Views } from "../sigproc/internal.js";
import { sharedMapSegmentCount, sharedNoiseFillEnabled } from "../shared-fields.js";
import {
  AT5_ZBA_DELTA_CLASS,
  AT5_ZBA_DELTA_WEIGHT_A,
  AT5_ZBA_DELTA_WEIGHT_B,
  AT5_ZBA_MM_TABLE_E,
  AT5_ZBA_MM_TABLE_G,
  AT5_ZBA_MM_TABLE_I,
  AT5_ZBA_MM_TABLE_K,
  AT5_ZBA_TC_TABLE_F,
  AT5_ZBA_TC_TABLE_H,
  AT5_ZBA_TC_TABLE_J,
  AT5_ZBA_TC_TABLE_L,
} from "../tables/encode-bitalloc.js";
import { AT5_SFTBL } from "../tables/decode.js";
import { AT5_IDSPCQUS_BY_BAND } from "../tables/encode-init.js";
import { AT5_ISPS, at5MapCountForBandCount } from "../tables/unpack.js";
import {
  allowsExtraBitallocBoost,
  computeBandScale,
  computeBitallocMode,
  equalizedStereoBitallocMode,
  firstGainRecordHasWideLevels,
  hasAllGainRecordsInPrefix,
  selectWcfxTable,
} from "./bitalloc-heuristics.js";
import {
  AT5_BANDS_MAX,
  AT5_EXPANDED_BAND_LIMIT,
  AT5_EXPANDED_MAP_COUNT,
  AT5_Y,
  at5BandLimitFallsInReservedGap,
} from "./constants.js";
import {
  at5BaseMaxQuantModeForCoreMode,
  computeGainRecordRangeFlag,
  countNonEmptyGainRecords,
  countPackedGainRecords,
  deriveScalefactorsFromSpectrumAt5,
  gainLevelsEqual,
  gainLocationPrefixEqual,
  normalizeSpectrumAt5,
} from "./metadata.js";
import { at5AbsI32, at5MeasurePackBits, toggleF32SignInPlace } from "./primitives.js";
import {
  applyLegacyLowBandOffsets,
  applyWideGainBoost,
  fillMaxIdwlModes,
  fillQuantModeBaseFromQuantUnits,
} from "./quant-bootstrap.js";
import {
  applySwapMapToSpectraInPlace,
  copyPresenceFromRuntime,
  runtimeCurrentBuffer,
  runtimePreviousBuffer,
} from "./runtime.js";
import { at5RecomputeCtxCosts, at5RecomputeTotalBits, setChannelWorkId } from "./core.js";

const INITIAL_FIXED_HEADER_BITS = 6;
const INITIAL_IDWL_BITS_PER_BAND = 3;
const INITIAL_MODE_SELECTOR_BITS = 2;
const INITIAL_GAIN_BITS_NO_DELTA = 11;
const INITIAL_GAIN_BITS_WITH_DELTA = 15;
const INITIAL_MISC_BITS_PLAIN = 1;
const INITIAL_MISC_BITS_EXTENDED = 9;
const INITIAL_INACTIVE_CTX_SENTINEL = 0x4000;
const INVALID_GAIN_CANDIDATE_BITS = 0x4000;
const AT5_SPECTRUM_WORDS = 0x800;
const AT5_EMPTY_STAGE_SCALE_FACTOR_INDICES = new Int32Array(AT5_EXPANDED_BAND_LIMIT);
const AT5_EMPTY_STAGE_BAND_SCALES = new Float32Array(AT5_EXPANDED_BAND_LIMIT);
const AT5_NORMALIZED_SPECTRUM_LIMIT = 1.12200927734375;
const AT5_MAX_IDSF_INDEX = 0x3f;
const AT5_STEREO_SPECTRUM_SCALE = 0.8912659;
const AT5_ENCODE_FLAG_SPECTRUM_SCALE = 0.94;
const gMode3DifferenceScratchByBlock = new WeakMap();

function getMode3DifferenceScratch(runtimeBlock) {
  const key = runtimeBlock && typeof runtimeBlock === "object" ? runtimeBlock : null;
  if (!key) {
    return {
      spectrum: new Float32Array(AT5_SPECTRUM_WORDS),
      bandPeaks: new Float32Array(AT5_EXPANDED_BAND_LIMIT),
    };
  }

  let scratch = gMode3DifferenceScratchByBlock.get(key);
  if (!scratch) {
    scratch = {
      spectrum: new Float32Array(AT5_SPECTRUM_WORDS),
      bandPeaks: new Float32Array(AT5_EXPANDED_BAND_LIMIT),
    };
    gMode3DifferenceScratchByBlock.set(key, scratch);
  }
  return scratch;
}
const AT5_ISPS_NEXT_BYTES = new Uint8Array(
  AT5_ISPS.buffer,
  AT5_ISPS.byteOffset,
  AT5_ISPS.byteLength
).subarray(1);
const MODE3_FLIP_THRESHOLD = -11.0;
const MODE3_TONE_CLEAR_THRESHOLD = 40.0;
const MODE3_IDSF_EQUALIZE_THRESHOLD = 60.0;
const MODE3_SCALE_REUSE_GAP_LIMIT = 1.0;
const PRIMARY_GAIN_MODE_PACKERS = {
  recordCount: [at5PackGainNgc0, at5PackGainNgc1, at5PackGainNgc2Ch0, at5PackGainNgc3Ch0],
  level: [at5PackGainIdlev0, at5PackGainIdlev1, at5PackGainIdlev2],
  location: [at5PackGainIdloc0, at5PackGainIdloc1, at5PackGainIdloc2],
};
const SECONDARY_GAIN_MODE_PACKERS = {
  recordCount: [at5PackGainNgc0, at5PackGainNgc1, at5PackGainNgc4Ch1],
  level: [at5PackGainIdlev0, at5PackGainIdlev4, at5PackGainIdlev5],
  location: [at5PackGainIdloc0, at5PackGainIdloc4, at5PackGainIdloc5],
};

const gCompactGainDeltaViewByTable = new WeakMap();

function readCompactGainDelta(table, range) {
  const byteOffset = (range | 0) * 2;
  if (byteOffset < 0 || byteOffset + 1 >= table.length) {
    return INVALID_GAIN_CANDIDATE_BITS;
  }

  let view = gCompactGainDeltaViewByTable.get(table);
  if (!view) {
    view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    gCompactGainDeltaViewByTable.set(table, view);
  }

  return view.getInt16(byteOffset, true) | 0;
}

function buildAuxZeroBandMask(sharedAux, segmentCount, bandCount, channelCount) {
  if (segmentCount <= 0 || bandCount <= 0) {
    return null;
  }

  const corrHistory = at5SigprocCorrHistoryViews(sharedAux);
  const leftMetrics = corrHistory.metric1;
  if (!(leftMetrics instanceof Float32Array)) {
    return null;
  }

  const isStereo = (channelCount | 0) === 2;
  const rightMetrics = isStereo ? corrHistory.metric2 : null;
  const auxZeroBandMask = new Uint8Array(bandCount);

  for (let seg = 0; seg < segmentCount; seg += 1) {
    const left = leftMetrics[seg] ?? 0;
    const right = isStereo ? (rightMetrics?.[seg] ?? 0) : 0;
    if (left >= 0 && right >= 0) {
      continue;
    }

    const start = AT5_Y[seg] ?? 0;
    auxZeroBandMask.fill(1, start, Math.min(bandCount, AT5_Y[seg + 1] ?? start));
  }

  return auxZeroBandMask;
}

export function shouldScaleSpectrumFromEncodeFlags(flags) {
  const bits = (flags >>> 2) & 0x1f;
  return (bits & 0x03) === 0x01 || ((bits ^ (bits >>> 1)) & 0x06) !== 0 || (bits & 0x18) === 0x10;
}

export function scaleSpectrumPairInPlace(spec0, spec1, scale) {
  if (!(spec0 instanceof Float32Array) || !(spec1 instanceof Float32Array)) {
    return;
  }

  for (let i = 0; i < AT5_SPECTRUM_WORDS; i += 1) {
    spec0[i] *= scale;
    spec1[i] *= scale;
  }
}

// Preserve the current byte-based AT5_ISPS walk used by the signal-perfect path.
function toggleMode3SpectrumRange(ch1Spec, band) {
  const startIdx = AT5_ISPS[band] >>> 0;
  const endIdx = (AT5_ISPS_NEXT_BYTES[band] ?? 0) >>> 0;
  if (startIdx < endIdx && ch1Spec instanceof Float32Array) {
    toggleF32SignInPlace(ch1Spec, startIdx, endIdx);
  }
}

function selectMode3ThresholdTables(coreMode) {
  if (coreMode < 0x0d) {
    return {
      toneThresholdTable: AT5_ZBA_TC_TABLE_F,
      maskThresholdTable: AT5_ZBA_MM_TABLE_E,
    };
  }
  if (coreMode < 0x13) {
    return {
      toneThresholdTable: AT5_ZBA_TC_TABLE_H,
      maskThresholdTable: AT5_ZBA_MM_TABLE_G,
    };
  }
  if (coreMode < 0x1b) {
    return {
      toneThresholdTable: AT5_ZBA_TC_TABLE_J,
      maskThresholdTable: AT5_ZBA_MM_TABLE_I,
    };
  }
  return {
    toneThresholdTable: AT5_ZBA_TC_TABLE_L,
    maskThresholdTable: AT5_ZBA_MM_TABLE_K,
  };
}

function scanMode3IdsfGapRange(leftIdsfByBand, rightIdsfByBand, startBand, endBand) {
  let minIdsfGap = at5AbsI32((leftIdsfByBand[startBand] | 0) - (rightIdsfByBand[startBand] | 0));
  let maxIdsfGap = minIdsfGap;

  for (let band = startBand + 1; band < endBand; band += 1) {
    const idsfGap = at5AbsI32((leftIdsfByBand[band] | 0) - (rightIdsfByBand[band] | 0));
    if (idsfGap < minIdsfGap) {
      minIdsfGap = idsfGap;
    }
    if (idsfGap > maxIdsfGap) {
      maxIdsfGap = idsfGap;
    }
  }

  return { minIdsfGap, maxIdsfGap };
}

/**
 * Seeds stereo mode-3 masking and flip hints before the main initial-bitalloc
 * pass chooses packed IDSF and quantization state.
 */
export function at5ApplyMode3BandMaskAndFlipHintsAt5(
  hdr,
  blocks,
  channels,
  coreMode,
  shared,
  quantizedSpectraByChannel
) {
  const sharedAux = channels?.[0]?.sharedAux ?? null;
  const { toneCount, toneActiveFlags, toneValues, flipValues } = at5SigprocMode3Views(sharedAux);
  if (!toneCount || !toneActiveFlags || !toneValues || !flipValues) {
    return;
  }

  hdr.mode3DeltaFlags.fill(0);
  hdr.mode3BandMask.fill(0);

  const leftIdsfByBand = channels[0].idsf?.values ?? null;
  const rightIdsfByBand = channels[1].idsf?.values ?? null;
  if (!(leftIdsfByBand && rightIdsfByBand)) {
    return;
  }

  const sharedReuseMaskByBand = hdr.mode3BandMask;
  const sharedIdsfSeedByBand = hdr.idsfValues;
  const { toneThresholdTable, maskThresholdTable } = selectMode3ThresholdTables(coreMode);
  const toneSegmentCount = toneCount[0] | 0;
  const mapSegmentCount = sharedMapSegmentCount(shared) | 0;
  const flipFlags = shared.stereoFlipPresence?.flags ?? null;
  const leftBandLevels = blocks?.[0]?.bandLevels ?? null;
  const rightBandLevels = blocks?.[1]?.bandLevels ?? null;
  const leftScaleByBand = runtimeCurrentBuffer(channels[0])?.bandScales ?? null;
  const rightScaleByBand = runtimeCurrentBuffer(channels[1])?.bandScales ?? null;
  const rightSpectrum = quantizedSpectraByChannel?.[1];

  function seedToneDrivenReuseMask() {
    for (let segment = 0; segment < toneSegmentCount; segment += 1) {
      const startBand = AT5_Y[segment] ?? 0;
      const endBand = AT5_Y[(segment + 1) | 0] ?? startBand;
      const segmentToneValue = toneValues[segment] ?? 0;
      const toneStartsSharedReuse =
        segment > 0 && segmentToneValue >= (toneThresholdTable[segment] ?? 0);
      const toneIsActive = (toneActiveFlags[segment] ?? 0) !== 0;

      for (let band = startBand; band < endBand; band += 1) {
        const leftIdsf = leftIdsfByBand[band] | 0;
        const rightIdsf = rightIdsfByBand[band] | 0;

        if (
          toneStartsSharedReuse &&
          leftIdsf === rightIdsf &&
          leftIdsf >= (sharedIdsfSeedByBand[band] | 0)
        ) {
          sharedReuseMaskByBand[band] = 1;
        }

        if (!toneIsActive) {
          continue;
        }

        const bandLevel = Math.max(leftBandLevels?.[band] ?? 0, rightBandLevels?.[band] ?? 0);
        if ((sharedReuseMaskByBand[band] | 0) === 0) {
          const sharedIdsfGap = Math.max(leftIdsf, rightIdsf) - (sharedIdsfSeedByBand[band] | 0);
          const reuseThreshold = Math.max(
            3,
            (((bandLevel * 0.33333334) | 0) +
              ((maskThresholdTable[band] ?? 0) | 0) -
              ((segmentToneValue * 0.125) | 0)) |
              0
          );
          if (reuseThreshold <= sharedIdsfGap) {
            sharedReuseMaskByBand[band] = 1;
          }
        }

        if (segmentToneValue <= MODE3_TONE_CLEAR_THRESHOLD && (bandLevel | 0) > 6) {
          sharedReuseMaskByBand[band] = 0;
        }
      }
    }
  }

  function applyFlipHintsAndEqualizeIdsf() {
    for (let segment = 0; segment < mapSegmentCount; segment += 1) {
      const startBand = AT5_Y[segment] ?? 0;
      const endBand = AT5_Y[(segment + 1) | 0] ?? startBand;
      const segmentToneValue = toneValues[segment] ?? 0;
      const { minIdsfGap, maxIdsfGap } = scanMode3IdsfGapRange(
        leftIdsfByBand,
        rightIdsfByBand,
        startBand,
        endBand
      );
      const shouldFlipSpectrum =
        segmentToneValue <= MODE3_FLIP_THRESHOLD &&
        maxIdsfGap < 2 &&
        ((flipValues[segment] ?? 0) <= MODE3_FLIP_THRESHOLD || maxIdsfGap === minIdsfGap)
          ? 1
          : 0;
      const hasFlipFlagSlot = flipFlags && segment < flipFlags.length;
      if (hasFlipFlagSlot) {
        flipFlags[segment] = shouldFlipSpectrum;
      }

      if (shouldFlipSpectrum !== 0) {
        for (let band = startBand; band < endBand; band += 1) {
          const scaleGap = Math.abs(
            (leftScaleByBand?.[band] ?? 0) - (rightScaleByBand?.[band] ?? 0)
          );
          if (scaleGap <= MODE3_SCALE_REUSE_GAP_LIMIT) {
            sharedReuseMaskByBand[band] = 1;
          }
          toggleMode3SpectrumRange(rightSpectrum, band);
        }
      }

      if (
        segmentToneValue < MODE3_IDSF_EQUALIZE_THRESHOLD &&
        !(shouldFlipSpectrum !== 0 && hasFlipFlagSlot)
      ) {
        continue;
      }

      for (let band = startBand; band < endBand; band += 1) {
        if ((sharedReuseMaskByBand[band] | 0) === 0) {
          continue;
        }

        const leftIdsf = leftIdsfByBand[band] | 0;
        const rightIdsf = rightIdsfByBand[band] | 0;
        if (leftIdsf === rightIdsf + 1) {
          leftIdsfByBand[band] = rightIdsf;
        } else if (leftIdsf + 1 === rightIdsf) {
          rightIdsfByBand[band] = leftIdsf;
        }
      }
    }
  }

  function reopenReuseForLateSegments() {
    for (let segment = toneSegmentCount; segment < mapSegmentCount; segment += 1) {
      if ((flipValues[segment] ?? 0) < MODE3_FLIP_THRESHOLD) {
        continue;
      }

      const startBand = AT5_Y[segment] ?? 0;
      const endBand = AT5_Y[(segment + 1) | 0] ?? startBand;
      sharedReuseMaskByBand.fill(1, startBand, endBand);
    }
  }

  seedToneDrivenReuseMask();
  applyFlipHintsAndEqualizeIdsf();
  // Later non-tone segments must reopen reuse after the flip/equalization pass;
  // folding this into the main map walk changes encoded output.
  reopenReuseForLateSegments();
}

function lateGroupTailStartForBootstrap(coreMode, sampleRate, bandCount) {
  if (coreMode >= 0x10 || sampleRate !== 44100 || bandCount <= 0x17 || bandCount >= 0x20) {
    return AT5_SPECTRUM_WORDS;
  }

  const scaledBandEdge = Math.trunc((AT5_ISPS[bandCount] | 0) * 0.010766);
  let tailStart = Math.trunc((scaledBandEdge * 1000) / 10.766);
  if (tailStart < 0) {
    tailStart += 0x0f;
  }
  return (tailStart >> 4) * 0x10;
}

function resetInitialBitallocHeaderState(shared, hdr, gainModeFlag, channelCount) {
  Object.assign(shared, {
    zeroSpectraFlag: 0,
    noiseFillEnabled: 0,
    noiseFillShift: 0,
    noiseFillCursor: 0,
    gainModeFlag,
    stereoFlag: channelCount === 2 ? 1 : 0,
  });
  Object.assign(hdr, {
    baseBits: gainModeFlag === 0 ? 0x10 : 4,
    tblIndex: gainModeFlag >>> 0,
    idwlEnabled: 1,
    idwlInitialized: 0,
    idsfModeWord: 1,
  });
  hdr.mode3BandMask.fill(0);
  hdr.mode3DeltaFlags.fill(0);
}

function applyBootstrapSpectrumTransforms(
  quantizedSpectra,
  bitallocSpectra,
  channelCount,
  coreMode,
  encodeFlags,
  lateGroupTailStart,
  mapSegmentCount,
  swapMap
) {
  const shouldApplyStereoScale =
    (coreMode < 0x0c && channelCount === 2) || (coreMode === 9 && channelCount === 1);
  const shouldApplyEncodeFlagScale = shouldScaleSpectrumFromEncodeFlags(encodeFlags);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const quantizedSpectrum = quantizedSpectra[channelIndex];
    const bitallocSpectrum = bitallocSpectra[channelIndex];
    if (shouldApplyStereoScale) {
      scaleSpectrumPairInPlace(quantizedSpectrum, bitallocSpectrum, AT5_STEREO_SPECTRUM_SCALE);
    }
    if (shouldApplyEncodeFlagScale) {
      scaleSpectrumPairInPlace(quantizedSpectrum, bitallocSpectrum, AT5_ENCODE_FLAG_SPECTRUM_SCALE);
    }

    if (lateGroupTailStart < AT5_SPECTRUM_WORDS) {
      quantizedSpectrum?.fill?.(0, lateGroupTailStart);
      bitallocSpectrum?.fill?.(0, lateGroupTailStart);
    }
  }

  if (channelCount === 2 && mapSegmentCount > 0) {
    applySwapMapToSpectraInPlace(quantizedSpectra, bitallocSpectra, swapMap, mapSegmentCount);
  }
}

function stageRuntimeChannelForInitialBitalloc(
  runtimeChannel,
  block,
  hdr,
  quantizedSpectrum,
  bitallocSpectrum,
  baseMaxQuantMode,
  bandCount,
  mapSegmentCount,
  pairedBandCount
) {
  const currentGainBuffer = runtimeCurrentBuffer(runtimeChannel);
  const previousGainBuffer = runtimePreviousBuffer(runtimeChannel);
  const gain = runtimeChannel?.gain ?? null;
  const idsfValues = runtimeChannel?.idsf?.values ?? null;
  const uniqueGainRecordCount = countNonEmptyGainRecords(currentGainBuffer, mapSegmentCount);
  const activeGainRecordCount =
    uniqueGainRecordCount < 2
      ? uniqueGainRecordCount
      : countPackedGainRecords(currentGainBuffer, uniqueGainRecordCount);
  const gainHasData = Number(uniqueGainRecordCount > 0);
  const gainUsesDelta = Number(uniqueGainRecordCount !== activeGainRecordCount);

  block.bitallocHeader = hdr;
  block.blockState = runtimeChannel?.blockState ?? null;
  block.quantizedSpectrum = quantizedSpectrum;
  block.baseMaxQuantMode = baseMaxQuantMode;

  if (runtimeChannel) {
    runtimeChannel.gainEncActiveCount = activeGainRecordCount;
    runtimeChannel.gainEncHasData = gainHasData;
    runtimeChannel.gainEncUniqueCount = uniqueGainRecordCount;
    runtimeChannel.gainEncHasDeltaFlag = gainUsesDelta;
  }

  if (gain) {
    gain.hasData = gainHasData >>> 0;
    gain.activeCount = activeGainRecordCount >>> 0;
    gain.uniqueCount = uniqueGainRecordCount >>> 0;
    gain.hasDeltaFlag = gainUsesDelta >>> 0;
    if (Array.isArray(currentGainBuffer?.records)) {
      gain.records = currentGainBuffer.records;
    }
  }

  if (runtimeChannel?.channelPresence?.flags) {
    copyPresenceFromRuntime(runtimeChannel, runtimeChannel, mapSegmentCount);
  }

  runtimeChannel?.idct?.values?.fill(0);
  runtimeChannel?.idwl?.values?.fill(0);
  idsfValues?.fill(0);

  const { bandPeaks, bitallocBandPeaks, quantUnitsByBand, bandLevels } = block;
  const gainRecordRangeFlag = computeGainRecordRangeFlag(currentGainBuffer, previousGainBuffer);
  block.gainRecordRangeFlag = gainRecordRangeFlag;
  block.bitallocMode =
    bitallocSpectrum instanceof Float32Array
      ? computeBitallocMode(bitallocSpectrum, gainRecordRangeFlag) | 0
      : 0;

  if (
    !(quantizedSpectrum instanceof Float32Array) ||
    !(bitallocSpectrum instanceof Float32Array) ||
    !(idsfValues instanceof Uint32Array)
  ) {
    return 1;
  }

  const currentBitallocScalefactors =
    currentGainBuffer?.scaleFactorIndices instanceof Int32Array
      ? currentGainBuffer.scaleFactorIndices
      : AT5_EMPTY_STAGE_SCALE_FACTOR_INDICES;
  const previousBitallocScalefactors =
    previousGainBuffer?.scaleFactorIndices instanceof Int32Array
      ? previousGainBuffer.scaleFactorIndices
      : AT5_EMPTY_STAGE_SCALE_FACTOR_INDICES;
  const currentBandScales =
    currentGainBuffer?.bandScales instanceof Float32Array ? currentGainBuffer.bandScales : null;
  const previousBandScales =
    previousGainBuffer?.bandScales instanceof Float32Array
      ? previousGainBuffer.bandScales
      : AT5_EMPTY_STAGE_BAND_SCALES;

  deriveScalefactorsFromSpectrumAt5(quantizedSpectrum, idsfValues, bandPeaks, bandCount);
  if (currentBitallocScalefactors !== AT5_EMPTY_STAGE_SCALE_FACTOR_INDICES) {
    deriveScalefactorsFromSpectrumAt5(
      bitallocSpectrum,
      currentBitallocScalefactors,
      bitallocBandPeaks,
      bandCount
    );
  }

  currentBandScales?.fill(1.0);

  let pairedBandLevelTotal = 0.0;
  let maxQuantUnitsInChannel = 1;
  for (let band = 0; band < bandCount; band += 1) {
    const bandStart = AT5_ISPS[band] >>> 0;
    const coefficientCount = (AT5_ISPS[band + 1] >>> 0) - bandStart;
    // Preserve the bootstrap fallback where a missing current scale table
    // contributes 0 and leaves the previous-frame scale to carry the blend.
    let currentBandScale = 0;

    if (currentBandScales) {
      currentBandScales[band] =
        bandPeaks[band] > 0
          ? computeBandScale(bandPeaks[band], quantizedSpectrum, bandStart, coefficientCount)
          : 1;
      currentBandScale = currentBandScales[band];
    }

    const quantUnits = Math.trunc(
      (currentBitallocScalefactors[band] + previousBitallocScalefactors[band]) * 0.5 + 0.5
    );
    const bandLevel = (currentBandScale + previousBandScales[band]) * 0.5;
    quantUnitsByBand[band] = quantUnits;
    bandLevels[band] = bandLevel;
    maxQuantUnitsInChannel = Math.max(maxQuantUnitsInChannel, quantUnits);
    if (band < pairedBandCount) {
      pairedBandLevelTotal += bandLevel;
    }
  }

  block.avgBandLevel = pairedBandCount > 0 ? pairedBandLevelTotal / pairedBandCount : 0.0;
  return maxQuantUnitsInChannel;
}

function finalizeInitialBitallocModeCaps(
  runtimeChannels,
  blocks,
  channelCount,
  bandCount,
  coreMode,
  baseMaxQuantMode,
  maxStagedQuantUnits
) {
  if (channelCount === 2) {
    const stereoBitallocMode = equalizedStereoBitallocMode(
      blocks[0].bitallocMode,
      blocks[1].bitallocMode
    );
    if (stereoBitallocMode !== null) {
      blocks[0].bitallocMode = blocks[1].bitallocMode = stereoBitallocMode;
    }
  }

  const bitallocScale = Math.fround((baseMaxQuantMode * 10.0) / maxStagedQuantUnits);
  const allowExtraBitallocBoost = allowsExtraBitallocBoost(coreMode, channelCount);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const runtimeChannel = runtimeChannels[channelIndex];
    const block = blocks[channelIndex];
    const wideGainBoostFlag =
      allowExtraBitallocBoost && firstGainRecordHasWideLevels(runtimeChannel) ? 1 : 0;
    block.bitallocScale = bitallocScale;
    block.wideGainBoostFlag = wideGainBoostFlag;
    fillMaxIdwlModes(
      block.maxQuantModeByBand,
      block.bandLevels,
      bandCount,
      block.baseMaxQuantMode,
      block.bitallocMode,
      wideGainBoostFlag
    );
  }
}

/**
 * Seeds the temporary ATRAC3plus block state from the current time2freq output
 * so the later bitalloc passes start from the same gain, presence, and band
 * analysis that the runtime has already prepared.
 */
export function initializeChannelBlock(args) {
  const { runtimeBlock, hdr, blocks, quantizedSpectraByChannel, bitallocSpectraByChannel } =
    args ?? {};
  const channelCount = runtimeBlock?.channelsInBlock | 0;
  if (channelCount <= 0) {
    return;
  }

  const shared = runtimeBlock?.shared;
  const bandCount = shared?.codedBandLimit | 0;
  const mapSegmentCount = sharedMapSegmentCount(shared) | 0;
  const coreMode = shared?.coreMode | 0;
  const sampleRate = shared?.sampleRateHz | 0;
  const encodeFlags = shared?.encodeFlags >>> 0;
  const swapMap = shared?.swapMap ?? null;
  const runtimeChannels = runtimeBlock?.channelEntries ?? [];
  const quantizedSpectra = quantizedSpectraByChannel ?? [];
  const bitallocSpectra = bitallocSpectraByChannel ?? [];
  const monoMode4Block = channelCount === 1 ? runtimeBlock?.blockState?.isMode4Block | 0 : 0;
  const baseMaxQuantMode = at5BaseMaxQuantModeForCoreMode(coreMode, channelCount, monoMode4Block);
  const pairedBandCount = Math.min(
    bandCount,
    AT5_Y[runtimeBlock?.aux?.intensityBand?.[0] ?? 0] ?? 0
  );
  const lateGroupTailStart = lateGroupTailStartForBootstrap(coreMode, sampleRate, bandCount);

  const gainModeFlag = (runtimeBlock?.blockState?.encodeMode | 0) === 2 ? 0 : 1;
  resetInitialBitallocHeaderState(shared, hdr, gainModeFlag, channelCount);
  applyBootstrapSpectrumTransforms(
    quantizedSpectra,
    bitallocSpectra,
    channelCount,
    coreMode,
    encodeFlags,
    lateGroupTailStart,
    mapSegmentCount,
    swapMap
  );

  let maxStagedQuantUnits = 1;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const runtimeChannel = runtimeChannels[channelIndex];
    const block = blocks[channelIndex];
    const quantizedSpectrum = quantizedSpectra[channelIndex] ?? null;
    const bitallocSpectrum = bitallocSpectra[channelIndex] ?? null;
    maxStagedQuantUnits = Math.max(
      maxStagedQuantUnits,
      stageRuntimeChannelForInitialBitalloc(
        runtimeChannel,
        block,
        hdr,
        quantizedSpectrum,
        bitallocSpectrum,
        baseMaxQuantMode,
        bandCount,
        mapSegmentCount,
        pairedBandCount
      )
    );
  }

  finalizeInitialBitallocModeCaps(
    runtimeChannels,
    blocks,
    channelCount,
    bandCount,
    coreMode,
    baseMaxQuantMode,
    maxStagedQuantUnits
  );
}

/**
 * Normalizes the staged quantized spectra in place and refreshes the per-band
 * normalized peak cache consumed by the later budget passes.
 *
 * Stereo mode 3 also seeds the shared header IDSF table from the left-right
 * difference spectrum before each channel is normalized.
 *
 * `runtimeBlock.channelEntries` / `runtimeBlock.channels` and
 * `runtimeBlock.channelsInBlock` are used by default when the caller does not
 * need to override the staged channel list.
 */
export function normalizeChannelBlock(args) {
  const { runtimeBlock, hdr, blocks, quantizedSpectraByChannel, mode } = args ?? {};
  const runtimeChannels = runtimeBlock?.channelEntries ?? runtimeBlock?.channels ?? [];
  const channelCount = (runtimeBlock?.channelsInBlock ?? runtimeChannels.length) | 0;
  const shared = runtimeBlock?.shared;
  const bandCount = shared?.codedBandLimit | 0;
  const quantizedSpectra = quantizedSpectraByChannel ?? [];
  const blockMode = mode | 0;
  const sharedMode3Idsf = hdr?.idsfValues ?? null;

  if (blockMode === 3 && channelCount === 2 && sharedMode3Idsf instanceof Int32Array) {
    const { spectrum: differenceSpectrum, bandPeaks: differenceBandPeaks } =
      getMode3DifferenceScratch(runtimeBlock);
    const differenceCount = AT5_ISPS[bandCount] >>> 0;
    subSeqAt5(quantizedSpectra[0], quantizedSpectra[1], differenceSpectrum, differenceCount);
    deriveScalefactorsFromSpectrumAt5(
      differenceSpectrum,
      sharedMode3Idsf,
      differenceBandPeaks,
      bandCount
    );
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const block = blocks[channelIndex];
    const quantizedSpectrum = quantizedSpectra[channelIndex];
    const idsfValues = runtimeChannels[channelIndex]?.idsf?.values;
    const normalizedBandPeaks = block?.normalizedBandPeaks;
    if (
      !(quantizedSpectrum instanceof Float32Array) ||
      !(idsfValues instanceof Uint32Array) ||
      !(normalizedBandPeaks instanceof Float32Array)
    ) {
      continue;
    }

    normalizeSpectrumAt5(quantizedSpectrum, idsfValues, bandCount);
    for (let band = 0; band < bandCount; band += 1) {
      const idsf = idsfValues[band] >>> 0;
      const bandStart = AT5_ISPS[band] >>> 0;
      const bandEnd = AT5_ISPS[band + 1] >>> 0;
      if (idsf === AT5_MAX_IDSF_INDEX) {
        for (let i = bandStart; i < bandEnd; i += 1) {
          const value = quantizedSpectrum[i];
          if (value > AT5_NORMALIZED_SPECTRUM_LIMIT) {
            quantizedSpectrum[i] = AT5_NORMALIZED_SPECTRUM_LIMIT;
          } else if (value < -AT5_NORMALIZED_SPECTRUM_LIMIT) {
            quantizedSpectrum[i] = -AT5_NORMALIZED_SPECTRUM_LIMIT;
          }
        }
      }

      const idsfScale = AT5_SFTBL[idsf] ?? 1.0;
      normalizedBandPeaks[band] = idsfScale > 0 ? block.bandPeaks[band] / idsfScale : 0;
    }
  }
}

function seedInitialQuantModeForBand(block, band) {
  const seededQuantMode = Math.trunc(block.quantModeBaseByBand[band] + 0.5);
  const maxQuantMode = block.maxQuantModeByBand[band] | 0;
  // Preserve the original seed clamp where a zero per-band ceiling forces
  // the staged mode to zero instead of reintroducing the minimum of 1.
  return seededQuantMode > maxQuantMode ? maxQuantMode : Math.max(1, seededQuantMode);
}

function reconcileMode3QuantModeWithBaseBand(
  quantMode,
  baseQuantMode,
  mode3BandMask,
  mode3DeltaFlags,
  band
) {
  const bandReusesBaseQuantMode = (mode3BandMask[band] | 0) === 1;
  const canReuseBaseQuantMode = (quantMode | 0) !== 0 && (baseQuantMode | 0) !== 0;

  if (!canReuseBaseQuantMode) {
    if ((quantMode | 0) === 0 && (baseQuantMode | 0) !== 0) {
      mode3DeltaFlags[band] = 1;
    }
    mode3BandMask[band] = 0;
    return quantMode;
  }

  return bandReusesBaseQuantMode ? 0 : quantMode;
}

export function initializeQuantModes(
  block,
  channel,
  bandCount,
  channelCount,
  coreMode,
  baseQuantModes = null,
  auxZeroBandMask = null,
  mode3BandMask = null,
  mode3DeltaFlags = null
) {
  const quantModes = channel?.idwl?.values;
  if (!(quantModes instanceof Uint32Array)) {
    return null;
  }

  const shouldZeroInactiveBands =
    ((channel.blockState?.encodeMode ?? 0) | 0) === 2 ||
    (coreMode | 0) < ((channelCount | 0) === 2 ? 0x1b : 0x17);

  for (let band = 0; band < (bandCount | 0); band += 1) {
    let quantMode = seedInitialQuantModeForBand(block, band);
    const bandHasNoQuantUnits = (block.quantUnitsByBand[band] | 0) === 0;
    const bandIsAuxMuted = (auxZeroBandMask?.[band] ?? 0) !== 0;

    if (bandHasNoQuantUnits && (shouldZeroInactiveBands || bandIsAuxMuted)) {
      quantMode = 0;
    }

    if (baseQuantModes) {
      quantMode = reconcileMode3QuantModeWithBaseBand(
        quantMode,
        baseQuantModes[band] | 0,
        mode3BandMask,
        mode3DeltaFlags,
        band
      );
    }

    quantModes[band] = quantMode >>> 0;
  }

  block.quantModeByBand?.set(quantModes.subarray(0, bandCount | 0));
  return quantModes;
}

export function normalizeBandLimit(shared, channels, bandCount, channelCount) {
  const activeBandCount = bandCount | 0;
  if (at5BandLimitFallsInReservedGap(activeBandCount)) {
    for (let ch = 0; ch < (channelCount | 0); ch += 1) {
      const quantModes = channels?.[ch]?.idwl?.values;
      if (quantModes && activeBandCount < AT5_EXPANDED_BAND_LIMIT) {
        quantModes.fill(0, activeBandCount, AT5_EXPANDED_BAND_LIMIT);
      }
    }

    shared.bandLimit = AT5_EXPANDED_BAND_LIMIT;
    shared.channelPresenceMapCount = AT5_EXPANDED_MAP_COUNT;
    return;
  }

  shared.bandLimit = (shared.codedBandLimit ?? 0) >>> 0;
  shared.channelPresenceMapCount = sharedMapSegmentCount(shared);
}

function measureCheapestGainCoding(
  channel,
  packers,
  extraCandidateBits = INVALID_GAIN_CANDIDATE_BITS
) {
  let cheapestBits = extraCandidateBits | 0;
  let cheapestMode = packers.length | 0;
  for (let mode = 0; mode < packers.length; mode += 1) {
    const candidateBits = at5MeasurePackBits(packers[mode], channel);
    if (candidateBits < cheapestBits) {
      cheapestBits = candidateBits;
      cheapestMode = mode;
    }
  }
  return { mode: cheapestMode >>> 0, bits: cheapestBits | 0 };
}

function selectPrimaryGainCodingSections(channel, gain) {
  let minEntryCount = 7;
  let maxEntryCount = 0;
  let minLevel = 0x0f;
  let maxLevel = 0;
  let minLocationBias = 0x1f;
  let maxLocationBias = 0;

  for (let recordIndex = 0; recordIndex < gain.activeCount >>> 0; recordIndex += 1) {
    const record = gain.records?.[recordIndex];
    const entryCount = record?.entries ?? 0;
    const levels = record?.levels;
    const locations = record?.locations;

    minEntryCount = Math.min(minEntryCount, entryCount);
    maxEntryCount = Math.max(maxEntryCount, entryCount);

    for (let entry = 0; entry < entryCount; entry += 1) {
      const level = levels?.[entry] ?? 0;
      const locationBias = ((locations?.[entry] ?? 0) | 0) - entry;
      minLevel = Math.min(minLevel, level);
      maxLevel = Math.max(maxLevel, level);
      minLocationBias = Math.min(minLocationBias, locationBias);
      maxLocationBias = Math.max(maxLocationBias, locationBias);
    }
  }

  gain.n0 =
    (AT5_ZBA_DELTA_CLASS[Math.max(0, (maxEntryCount - minEntryCount) | 0) & 0x7] ?? 0) >>> 0;
  gain.n1 = minEntryCount >>> 0;

  let compactLevelBits = INVALID_GAIN_CANDIDATE_BITS;
  const levelRange = ((maxLevel | 0) - (minLevel | 0)) | 0;
  if (levelRange < 0x10) {
    const width = readCompactGainDelta(AT5_ZBA_DELTA_WEIGHT_A, levelRange);
    if ((width | 0) !== INVALID_GAIN_CANDIDATE_BITS) {
      gain.idlevWidth = width & 0xffff;
      gain.idlevBase = minLevel & 0xff;
      compactLevelBits = at5MeasurePackBits(at5PackGainIdlev3, channel);
    }
  }

  let compactLocationBits = INVALID_GAIN_CANDIDATE_BITS;
  const locationBiasRange = ((maxLocationBias | 0) - (minLocationBias | 0)) | 0;
  if (locationBiasRange < 0x20) {
    const step = readCompactGainDelta(AT5_ZBA_DELTA_WEIGHT_B, locationBiasRange);
    if ((step | 0) !== INVALID_GAIN_CANDIDATE_BITS) {
      gain.idlocStep = step & 0xffff;
      gain.idlocBase = minLocationBias | 0;
      compactLocationBits = at5MeasurePackBits(at5PackGainIdloc3, channel);
    }
  }

  return {
    recordCount: measureCheapestGainCoding(channel, PRIMARY_GAIN_MODE_PACKERS.recordCount),
    level: measureCheapestGainCoding(channel, PRIMARY_GAIN_MODE_PACKERS.level, compactLevelBits),
    location: measureCheapestGainCoding(
      channel,
      PRIMARY_GAIN_MODE_PACKERS.location,
      compactLocationBits
    ),
  };
}

function selectReuseGainCodingSections(channel, gain) {
  const currentRecords = gain.records;
  const baseRecords = (channel.block0 ?? channel)?.gain?.records;
  const levelChangedByRecord = gain.idlevFlags instanceof Uint32Array ? gain.idlevFlags : null;
  const locationChangedByRecord = gain.idlocFlags instanceof Uint32Array ? gain.idlocFlags : null;
  let countsMatchBase = true;
  let levelsMatchBase = true;
  let locationPrefixMatchesBase = true;

  levelChangedByRecord?.fill(0);
  locationChangedByRecord?.fill(0);

  for (let recordIndex = 0; recordIndex < gain.activeCount >>> 0; recordIndex += 1) {
    const record = currentRecords?.[recordIndex];
    const baseRecord = baseRecords?.[recordIndex] ?? record;
    const entryCount = record?.entries >>> 0;
    const baseEntryCount = baseRecord?.entries >>> 0;
    const levelsEqualToBase = gainLevelsEqual(record, baseRecord);
    const locationPrefixEqualToBase = gainLocationPrefixEqual(record, baseRecord);

    if (entryCount !== baseEntryCount) {
      countsMatchBase = false;
    }
    if (!levelsEqualToBase) {
      levelsMatchBase = false;
    }
    if (!locationPrefixEqualToBase) {
      locationPrefixMatchesBase = false;
    }

    if (recordIndex < (levelChangedByRecord?.length ?? 0)) {
      levelChangedByRecord[recordIndex] = Number(!levelsEqualToBase);
    }
    if (recordIndex < (locationChangedByRecord?.length ?? 0)) {
      locationChangedByRecord[recordIndex] = Number(
        entryCount === 0 || entryCount > baseEntryCount || !locationPrefixEqualToBase
      );
    }
  }

  return {
    recordCount: measureCheapestGainCoding(
      channel,
      SECONDARY_GAIN_MODE_PACKERS.recordCount,
      countsMatchBase ? 0 : INVALID_GAIN_CANDIDATE_BITS
    ),
    level: measureCheapestGainCoding(
      channel,
      SECONDARY_GAIN_MODE_PACKERS.level,
      levelsMatchBase ? 0 : INVALID_GAIN_CANDIDATE_BITS
    ),
    location: measureCheapestGainCoding(
      channel,
      SECONDARY_GAIN_MODE_PACKERS.location,
      locationPrefixMatchesBase
        ? at5MeasurePackBits(at5PackGainIdloc6, channel)
        : INVALID_GAIN_CANDIDATE_BITS
    ),
  };
}

/**
 * Chooses the cheapest gain transport for the staged channel:
 * channel 0 packs its records directly, while channel 1 tries to reuse the
 * base channel and only pays for the sections that actually diverge.
 */
export function selectGainCodingMode(channel) {
  const gain = channel?.gain;
  if (!channel || !gain || (gain.hasData | 0) === 0) {
    return 0;
  }

  const selectedCodingBySection =
    channel.channelIndex >>> 0 === 0
      ? selectPrimaryGainCodingSections(channel, gain)
      : selectReuseGainCodingSections(channel, gain);
  const recordCountCoding = selectedCodingBySection.recordCount;
  const levelCoding = selectedCodingBySection.level;
  const locationCoding = selectedCodingBySection.location;

  gain.ngcMode = recordCountCoding.mode;
  gain.idlevMode = levelCoding.mode;
  gain.idlocMode = locationCoding.mode;
  return (recordCountCoding.bits + levelCoding.bits + locationCoding.bits) | 0;
}

function applyBandLevelQuantModeBiases(quantModeBaseByBand, bandLevels, bandCount) {
  for (let band = 0; band < bandCount; band += 1) {
    const level = bandLevels[band] ?? 0;
    quantModeBaseByBand[band] += level >= 10 ? 2 : level >= 6 ? 1 : level >= 3.5 ? 0.5 : 0;
  }
}

function buildInitialQuantModeCurves(
  blocks,
  channelEntries,
  totalChannels,
  bandCount,
  wcfxTable,
  sampleRateHz,
  encodeFlags,
  normalizedCoreMode,
  gainPrefixSegmentCount,
  useLegacyLowBandOffsets,
  allowWideGainBoost
) {
  for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
    const channel = channelEntries[channelIndex];
    if (!channel) {
      continue;
    }
    setChannelWorkId(channel, 0);

    const block = blocks[channelIndex];
    const quantModeBaseByBand = block?.quantModeBaseByBand ?? null;
    if (!quantModeBaseByBand) {
      continue;
    }
    const bandLevels = block.bandLevels;
    const bitallocScale = block.bitallocScale ?? 0;
    const bitallocMode = block.bitallocMode | 0;
    const avgBandLevel = block.avgBandLevel ?? 0;
    const gainsStayInPrefix = hasAllGainRecordsInPrefix(channel, gainPrefixSegmentCount);

    fillQuantModeBaseFromQuantUnits(
      quantModeBaseByBand,
      block.quantUnitsByBand,
      bandCount,
      bitallocScale,
      wcfxTable,
      sampleRateHz,
      encodeFlags,
      { roundWeightedScale: true }
    );

    if (useLegacyLowBandOffsets) {
      applyLegacyLowBandOffsets(
        quantModeBaseByBand,
        bandCount,
        sampleRateHz,
        normalizedCoreMode,
        totalChannels,
        bitallocMode,
        gainsStayInPrefix,
        avgBandLevel
      );
    }

    applyBandLevelQuantModeBiases(quantModeBaseByBand, bandLevels, bandCount);

    if (allowWideGainBoost && (block.wideGainBoostFlag | 0) !== 0) {
      applyWideGainBoost(
        quantModeBaseByBand,
        bandLevels,
        Math.min(8, quantModeBaseByBand.length | 0)
      );
    }
  }
}

function stageInitialQuantModesAndCtxCosts(
  blocks,
  channelEntries,
  quantizedSpectra,
  totalChannels,
  bandCount,
  normalizedCoreMode,
  primaryChannelQuantModes,
  auxZeroBandMask,
  mode3BandMask,
  mode3DeltaFlags
) {
  for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
    const channel = channelEntries[channelIndex];
    const block = blocks[channelIndex];
    if (!channel || !block?.quantModeBaseByBand) {
      continue;
    }

    initializeQuantModes(
      block,
      channel,
      bandCount,
      totalChannels,
      normalizedCoreMode,
      channelIndex === 1 ? primaryChannelQuantModes : null,
      auxZeroBandMask,
      mode3BandMask,
      mode3DeltaFlags
    );

    block.bitDeltaByCtx[1] = INITIAL_INACTIVE_CTX_SENTINEL;
    const quantizedSpectrum =
      block.quantizedSpectrum instanceof Float32Array
        ? block.quantizedSpectrum
        : (quantizedSpectra[channelIndex] ?? null);
    at5RecomputeCtxCosts(block, channel, 0, bandCount, quantizedSpectrum);
  }
}

function measureInitialIdsfBits(channel, idsfCount, useFlatIdsfMode, flatIdsfBitsPerChannel) {
  if (!channel || idsfCount <= 0) {
    return 0;
  }

  if (!useFlatIdsfMode) {
    return INITIAL_MODE_SELECTOR_BITS + calcNbitsForIdsfChAt5(channel);
  }

  channel.idsfModeSelect = 0;
  channel.idsf.modeSelect = 0;
  return flatIdsfBitsPerChannel;
}

function measureInitialGainBits(channel) {
  const gain = channel?.gain;
  if ((gain?.hasData | 0) === 0) {
    return 0;
  }

  const gainHeaderBits =
    (gain.hasDeltaFlag | 0) !== 0 ? INITIAL_GAIN_BITS_WITH_DELTA : INITIAL_GAIN_BITS_NO_DELTA;
  return gainHeaderBits + selectGainCodingMode(channel);
}

function measureInitialStereoMapBits(shared, idsfCount, mapCount, totalChannels) {
  const selectorBits =
    idsfCount >= 3
      ? (((AT5_IDSPCQUS_BY_BAND[mapCount + (AT5_BANDS_MAX - 1)] ?? 0) * 4 + 4) * totalChannels) | 0
      : 0;
  const presenceBits =
    totalChannels === 2
      ? updateAt5PresenceTableBits(shared.stereoSwapPresence ?? null, mapCount) +
        updateAt5PresenceTableBits(shared.stereoFlipPresence ?? null, mapCount)
      : 0;
  return (selectorBits + presenceBits) & 0xffff;
}

function measureInitialHeaderBits(
  runtimeBlock,
  hdr,
  blocks,
  channelEntries,
  totalChannels,
  shared,
  idsfCount,
  mapCount,
  channelPresenceMapCount,
  useFlatIdsfMode
) {
  const flatIdsfBitsPerChannel = idsfCount * 6 + INITIAL_MODE_SELECTOR_BITS;
  let idsfBits = 0;
  // The seed pass starts with one gain-presence flag per channel before any
  // record payload is measured.
  let gainBits = totalChannels;
  let channelMapBits = 0;

  for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
    const channel = channelEntries[channelIndex];
    if (!channel) {
      continue;
    }

    idsfBits += measureInitialIdsfBits(channel, idsfCount, useFlatIdsfMode, flatIdsfBitsPerChannel);
    channelMapBits += updateAt5PresenceTableBits(
      channel.channelPresence ?? null,
      channelPresenceMapCount
    );
    gainBits += measureInitialGainBits(channel);
  }

  syncGhStateFromSigprocSlotsAt5(runtimeBlock);
  const headerBits = {
    bitsFixed: INITIAL_FIXED_HEADER_BITS,
    bitsIdwl:
      ((((shared.bandLimit ?? 0) >>> 0) * INITIAL_IDWL_BITS_PER_BAND + INITIAL_MODE_SELECTOR_BITS) *
        totalChannels) &
      0xffff,
    bitsIdsf: idsfBits & 0xffff,
    bitsIdct: calcNbitsForIdctAt5(channelEntries, blocks, totalChannels, 0) & 0xffff,
    bitsGain: gainBits & 0xffff,
    bitsChannelMaps: channelMapBits & 0xffff,
    bitsStereoMaps: measureInitialStereoMapBits(shared, idsfCount, mapCount, totalChannels),
    bitsGha: (calcNbitsForGhaAt5(runtimeBlock, 1) | 0) & 0xffff,
    bitsMisc:
      sharedNoiseFillEnabled(shared) === 0 ? INITIAL_MISC_BITS_PLAIN : INITIAL_MISC_BITS_EXTENDED,
  };
  headerBits.bitsTotalBase =
    (headerBits.bitsFixed +
      headerBits.bitsIdwl +
      headerBits.bitsIdsf +
      headerBits.bitsIdct +
      headerBits.bitsStereoMaps +
      headerBits.bitsChannelMaps +
      headerBits.bitsGain +
      headerBits.bitsGha +
      headerBits.bitsMisc) &
    0xffff;
  Object.assign(hdr, headerBits);

  return at5RecomputeTotalBits(hdr, blocks, channelEntries, totalChannels) | 0;
}

/**
 * Runs the ATRAC3plus bootstrap lifecycle that turns runtime spectra and gain
 * staging into the initial channel-block bitalloc state later refined by the
 * budget solver.
 */
export function bootstrapChannelBlock(args) {
  const { runtimeBlock, hdr, blocks, quantizedSpectraByChannel, bitallocSpectraByChannel } =
    args ?? {};
  const normalizedBlockMode = (args?.blockMode ?? runtimeBlock?.blockMode ?? 1) | 0;
  const normalizedCoreMode =
    args?.coreMode == null
      ? (runtimeBlock?.shared?.coreMode ?? runtimeBlock?.coreMode ?? 0) | 0
      : args.coreMode | 0;

  initializeChannelBlock({
    runtimeBlock,
    hdr,
    blocks,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
  });
  normalizeChannelBlock({
    runtimeBlock,
    hdr,
    blocks,
    quantizedSpectraByChannel,
    mode: normalizedBlockMode,
  });
  return (
    seedInitialBitalloc({
      runtimeBlock,
      hdr,
      blocks,
      quantizedSpectraByChannel,
      blockMode: normalizedBlockMode,
      coreMode: normalizedCoreMode,
      maxBits: args?.maxBits,
    }) | 0
  );
}

/**
 * Seeds the initial ATRAC3plus bit-allocation stage by turning the coarse
 * runtime analysis into initial quant modes and a measured fixed-header bit
 * budget.
 *
 * The lifecycle context defaults to the channel list staged on `runtimeBlock`,
 * so the caller only needs to pass explicit `channels` or `channelCount` when
 * operating on a detached test fixture.
 */
export function seedInitialBitalloc(args) {
  const {
    runtimeBlock,
    hdr,
    blocks,
    quantizedSpectraByChannel,
    channels,
    channelCount,
    blockMode,
    coreMode,
    maxBits,
  } = args ?? {};
  const channelEntries = channels ?? runtimeBlock?.channelEntries ?? runtimeBlock?.channels ?? [];
  const totalChannels =
    (channelCount ?? runtimeBlock?.channelsInBlock ?? channelEntries.length) | 0;
  if (totalChannels <= 0) {
    return 0;
  }

  const quantizedSpectra = quantizedSpectraByChannel ?? [];
  const primaryChannel = channelEntries[0] ?? null;
  const shared = primaryChannel?.shared ?? runtimeBlock?.shared ?? null;
  if (!shared) {
    return 0;
  }

  const normalizedCoreMode = coreMode | 0;
  const bitBudget = maxBits | 0;
  const bandCount = (shared.codedBandLimit ?? 0) | 0;
  const sampleRateHz = (shared.sampleRateHz ?? 0) >>> 0;
  const encodeFlags = (shared.encodeFlags ?? 0) >>> 0;
  const mapSegmentCount = sharedMapSegmentCount(shared) | 0;
  const gainPrefixSegmentCount = Math.min(mapSegmentCount, 8);
  const wcfxTable = selectWcfxTable(normalizedCoreMode, totalChannels);
  const useLegacyLowBandOffsets =
    (encodeFlags & 124) === 0 &&
    ((normalizedCoreMode < 25 && sampleRateHz === 44100) ||
      (normalizedCoreMode < 26 && sampleRateHz === 48000));
  const allowWideGainBoost = allowsExtraBitallocBoost(normalizedCoreMode, totalChannels);
  const mode3BandMask = hdr?.mode3BandMask ?? null;
  const mode3DeltaFlags = hdr?.mode3DeltaFlags ?? null;
  const primaryBlockState = primaryChannel?.blockState ?? null;
  const primaryChannelQuantModes = primaryChannel?.idwl?.values ?? null;
  const auxZeroBandMask = buildAuxZeroBandMask(
    primaryChannel?.sharedAux,
    mapSegmentCount,
    bandCount,
    totalChannels
  );
  const useFlatIdsfMode = (hdr.idsfModeWord | 0) === 0;

  shared.maxBits = bitBudget >>> 0;

  if ((blockMode | 0) === 3 && totalChannels === 2) {
    // Stereo mode 3 seeds channel-1 reuse and flip hints before quant staging.
    at5ApplyMode3BandMaskAndFlipHintsAt5(
      hdr,
      blocks,
      channelEntries,
      normalizedCoreMode,
      shared,
      quantizedSpectra
    );
  }

  buildInitialQuantModeCurves(
    blocks,
    channelEntries,
    totalChannels,
    bandCount,
    wcfxTable,
    sampleRateHz,
    encodeFlags,
    normalizedCoreMode,
    gainPrefixSegmentCount,
    useLegacyLowBandOffsets,
    allowWideGainBoost
  );
  stageInitialQuantModesAndCtxCosts(
    blocks,
    channelEntries,
    quantizedSpectra,
    totalChannels,
    bandCount,
    normalizedCoreMode,
    primaryChannelQuantModes,
    auxZeroBandMask,
    mode3BandMask,
    mode3DeltaFlags
  );

  normalizeBandLimit(shared, channelEntries, bandCount, totalChannels);
  const secondaryChannelQuantModes = channelEntries[1]?.idwl?.values ?? primaryChannelQuantModes;
  const idsfCount =
    at5ActiveBandCount(
      primaryChannelQuantModes,
      secondaryChannelQuantModes,
      bandCount,
      totalChannels
    ) >>> 0;
  const channelPresenceMapCount = shared.channelPresenceMapCount ?? 0;
  const mapCount = at5MapCountForBandCount(idsfCount);
  shared.idsfCount = idsfCount;
  shared.mapCount = mapCount;

  const total = measureInitialHeaderBits(
    runtimeBlock,
    hdr,
    blocks,
    channelEntries,
    totalChannels,
    shared,
    idsfCount,
    mapCount,
    channelPresenceMapCount,
    useFlatIdsfMode
  );
  const shouldKeepInitialQuantCaps =
    ((primaryBlockState?.isMode4Block ?? 0) | 0) !== 0 || total > bitBudget * 0.9;
  if (shouldKeepInitialQuantCaps) {
    return total;
  }

  for (let channelIndex = 0; channelIndex < totalChannels; channelIndex += 1) {
    const block = blocks[channelIndex];
    if (!block || (block.baseMaxQuantMode | 0) >= 7) {
      continue;
    }
    block.maxQuantModeByBand.fill(7, 0, bandCount);
  }

  return (hdr.bitsTotal ?? total) | 0;
}
