import { invmixSeqAt5, mixSeqAt5 } from "../dsp.js";
import { dftXAt5 } from "../dft.js";
import { checkChannelCorrelationAt5 } from "../math.js";

import { analysisCtxForSlot, analysisCtxForSlotConst } from "./ctx.js";
import { analysisPrepareWindow } from "./gate.js";
import { analysisGeneralAt5 } from "./general.js";
import { analysisSineAt5Sub } from "./sine.js";
import { at5GhwaveApplySynthesisResidual } from "./synth.js";
import { checkPowerLevelAt5F32, findPeakBin, shellSortDesc } from "./util.js";

const AT5_GHWAVE_FRAME_SAMPLES = 0x100;
const AT5_GHWAVE_HALF_SAMPLES = AT5_GHWAVE_FRAME_SAMPLES >> 1;
const AT5_GHWAVE_MAX_TOTAL_ENTRIES = 48;
const AT5_GHWAVE_MAX_CHANNELS = 2;
const AT5_GHWAVE_MAX_BANDS = 16;
const AT5_GHWAVE_MODE_GENERAL = 3;
const AT5_GHWAVE_DFT_BINS = 0x81;
const AT5_GHWAVE_SPECTRUM_SIZE = AT5_GHWAVE_DFT_BINS + 3;
const AT5_GHWAVE_BAND_STRIDE = 16;
const AT5_GHWAVE_WEIGHT_DB_SCALE = 8.685889;
const AT5_GHWAVE_POWER_SCALE = 1 / AT5_GHWAVE_FRAME_SAMPLES;
const AT5_GHWAVE_MODE1_TOTAL_SHARE = 0.99999;
const AT5_GHWAVE_MODE2_TAIL_MULTIPLIER = 4;
const AT5_GHWAVE_INVALID_PEAK_DB = -160;
const AT5_GHWAVE_MODE2_PEAK_DB_LIMIT = 24.0;

function analysisPtrIndex(base, channelIndex, band) {
  return (base | 0) + (channelIndex | 0) * AT5_GHWAVE_BAND_STRIDE + (band | 0);
}

function clampGhwaveChannelCount(channelCount) {
  if ((channelCount | 0) <= 0) {
    return 0;
  }
  return Math.min(channelCount | 0, AT5_GHWAVE_MAX_CHANNELS);
}

function clampGhwaveBandCount(bandCount) {
  return Math.min(Math.max(bandCount | 0, 0), AT5_GHWAVE_MAX_BANDS);
}

function resetBandAnalysisContext(state) {
  if (!state) {
    return;
  }

  state.hasStart = 0;
  state.hasEnd = 0;
  state.gateStartValid = 0;
  state.gateEndValid = 0;
  state.gateStartIdx = 0;
  state.gateEndIdx = 0x20;
  state.count = 0;
}

function resetSlotAnalysisContexts(slot, bandCount) {
  if (!slot) {
    return;
  }

  for (let band = 0; band < bandCount; band += 1) {
    resetBandAnalysisContext(analysisCtxForSlot(slot, band));
  }
}

function zeroJointFlagsForMono(jointFlags, mixFlags, bandCount) {
  for (let band = 0; band < bandCount; band += 1) {
    jointFlags[band] = 0;
    mixFlags[band] = 0;
  }
}

function resetEnergyScratch(bandPowerByCh, bandPowerSum, chTotalPower, channelCount) {
  bandPowerSum.fill(0);
  chTotalPower.fill(0);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    bandPowerByCh[channelIndex]?.fill(0);
  }
}

function accumulateBandPower(
  analysisPtrs,
  analysisBase,
  channelCount,
  bandCount,
  bandPowerByCh,
  bandPowerSum,
  chTotalPower
) {
  if (!analysisPtrs) {
    return;
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    for (let band = 0; band < bandCount; band += 1) {
      const spectrum = analysisPtrs[analysisPtrIndex(analysisBase, channelIndex, band)] ?? null;
      if (!(spectrum instanceof Float32Array)) {
        continue;
      }

      const power =
        checkPowerLevelAt5F32(spectrum, spectrum, AT5_GHWAVE_FRAME_SAMPLES) *
        AT5_GHWAVE_POWER_SCALE;
      bandPowerByCh[channelIndex][band] = power;
      chTotalPower[channelIndex] += power;
      bandPowerSum[band] += power;
    }
  }
}

function sortBandsByPowerForChannel(
  channelIndex,
  bandCount,
  bandPowerByCh,
  sortedBandsByCh,
  bandSortValues
) {
  for (let band = 0; band < bandCount; band += 1) {
    bandSortValues[band] = bandPowerByCh[channelIndex][band];
    sortedBandsByCh[channelIndex][band] = band;
  }

  shellSortDesc(bandSortValues, sortedBandsByCh[channelIndex], bandCount);
}

function forceSingleBandGeneralMode(selectedModeByCh, global) {
  if (global) {
    global.flag = 0;
    global.bandCount = 1;
  }

  selectedModeByCh[0] = AT5_GHWAVE_MODE_GENERAL;
  selectedModeByCh[1] = 0;
}

function classifyChannelEnergySpread({
  channelIndex,
  bandCount,
  bandPowerByCh,
  sortedBandsByCh,
  chTotalPower,
  encodeFlagD0,
  global,
}) {
  const result = {
    selectedMode: AT5_GHWAVE_MODE_GENERAL,
    mode1Candidate: 0,
    mode2Candidate: 0,
    forceGeneralFallback: false,
  };

  const totalPower = chTotalPower[channelIndex];
  if (!(totalPower > 0)) {
    return result;
  }

  const strongestBand = bandCount > 0 ? sortedBandsByCh[channelIndex][0] | 0 : 0;
  const secondStrongestBand = bandCount > 1 ? sortedBandsByCh[channelIndex][1] | 0 : strongestBand;
  const strongestPairPower =
    bandPowerByCh[channelIndex][strongestBand] + bandPowerByCh[channelIndex][secondStrongestBand];

  if (strongestPairPower > totalPower * AT5_GHWAVE_MODE1_TOTAL_SHARE) {
    result.mode1Candidate = 1;
    return result;
  }

  const weakestBand = bandCount > 0 ? sortedBandsByCh[channelIndex][bandCount - 1] | 0 : 0;
  if (
    bandPowerByCh[channelIndex][weakestBand] * AT5_GHWAVE_MODE2_TAIL_MULTIPLIER >
    bandPowerByCh[channelIndex][strongestBand]
  ) {
    result.mode2Candidate = 1;
    return result;
  }

  if ((encodeFlagD0 | 0) !== 0) {
    return result;
  }

  if (global) {
    global.flag = 0;
    global.bandCount = 1;
  }
  result.forceGeneralFallback = true;
  return result;
}

export function at5GhwaveClassifyEnergy(options) {
  const {
    analysisPtrs,
    analysisBase,
    bandCount,
    channelCount,
    bandPowerByCh,
    bandPowerSum,
    chTotalPower,
    sortedBandsByCh,
    bandSortValues,
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    shared,
    global,
  } = options ?? {};
  if (
    !bandPowerByCh ||
    !bandPowerSum ||
    !chTotalPower ||
    !sortedBandsByCh ||
    !bandSortValues ||
    !selectedModeByCh ||
    !mode2CandidateByCh ||
    !mode1CandidateByCh
  ) {
    return false;
  }

  const ptrs = Array.isArray(analysisPtrs) ? analysisPtrs : null;
  const base = analysisBase | 0;
  const bands = clampGhwaveBandCount(bandCount);
  const channels = clampGhwaveChannelCount(channelCount);

  resetEnergyScratch(bandPowerByCh, bandPowerSum, chTotalPower, channels);
  accumulateBandPower(ptrs, base, channels, bands, bandPowerByCh, bandPowerSum, chTotalPower);

  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    selectedModeByCh[channelIndex] = AT5_GHWAVE_MODE_GENERAL;
    mode2CandidateByCh[channelIndex] = 0;
    mode1CandidateByCh[channelIndex] = 0;

    sortBandsByPowerForChannel(channelIndex, bands, bandPowerByCh, sortedBandsByCh, bandSortValues);

    const channelMode = classifyChannelEnergySpread({
      channelIndex,
      bandCount: bands,
      bandPowerByCh,
      sortedBandsByCh,
      chTotalPower,
      encodeFlagD0: shared?.encodeFlagD0 ?? 0,
      global,
    });

    selectedModeByCh[channelIndex] = channelMode.selectedMode;
    mode1CandidateByCh[channelIndex] = channelMode.mode1Candidate;
    mode2CandidateByCh[channelIndex] = channelMode.mode2Candidate;

    if (channelMode.forceGeneralFallback) {
      forceSingleBandGeneralMode(selectedModeByCh, global);
      return true;
    }
  }

  return false;
}

function selectJointAndMixFlagsAt5(
  analysisPtrs,
  analysisBase,
  bandCount,
  jointFlags,
  mixFlags,
  scratch,
  corrScratch
) {
  let bands = bandCount | 0;
  if (bands < 0) {
    bands = 0;
  } else if (bands > AT5_GHWAVE_MAX_BANDS) {
    bands = AT5_GHWAVE_MAX_BANDS;
  }

  const base = analysisBase | 0;
  const scratchObj = scratch && typeof scratch === "object" ? scratch : null;

  let leftPtrs = scratchObj?.leftPtrs ?? null;
  if (!Array.isArray(leftPtrs) || leftPtrs.length < bands) {
    leftPtrs = new Array(bands).fill(null);
    if (scratchObj) {
      scratchObj.leftPtrs = leftPtrs;
    }
  }

  let rightPtrs = scratchObj?.rightPtrs ?? null;
  if (!Array.isArray(rightPtrs) || rightPtrs.length < bands) {
    rightPtrs = new Array(bands).fill(null);
    if (scratchObj) {
      scratchObj.rightPtrs = rightPtrs;
    }
  }

  let corrDb = scratchObj?.corrDb ?? null;
  if (!(corrDb instanceof Float32Array) || corrDb.length !== AT5_GHWAVE_MAX_BANDS) {
    corrDb = new Float32Array(AT5_GHWAVE_MAX_BANDS);
    if (scratchObj) {
      scratchObj.corrDb = corrDb;
    }
  }

  let powerA = scratchObj?.corrPowerA ?? null;
  if (!(powerA instanceof Float32Array) || powerA.length !== AT5_GHWAVE_MAX_BANDS) {
    powerA = new Float32Array(AT5_GHWAVE_MAX_BANDS);
    if (scratchObj) {
      scratchObj.corrPowerA = powerA;
    }
  }

  let powerB = scratchObj?.corrPowerB ?? null;
  if (!(powerB instanceof Float32Array) || powerB.length !== AT5_GHWAVE_MAX_BANDS) {
    powerB = new Float32Array(AT5_GHWAVE_MAX_BANDS);
    if (scratchObj) {
      scratchObj.corrPowerB = powerB;
    }
  }

  for (let band = 0; band < bands; band += 1) {
    leftPtrs[band] = analysisPtrs?.[base + band] ?? null;
    rightPtrs[band] = analysisPtrs?.[base + band + AT5_GHWAVE_BAND_STRIDE] ?? null;
  }

  checkChannelCorrelationAt5(
    leftPtrs,
    rightPtrs,
    AT5_GHWAVE_FRAME_SAMPLES,
    bands,
    corrDb,
    powerA,
    powerB,
    corrScratch
  );

  for (let band = 0; band < bands; band += 1) {
    const correlationDb = corrDb[band];
    if (correlationDb >= 20.0) {
      jointFlags[band] = 1;
      mixFlags[band] = 0;
    } else if (correlationDb < -11.0) {
      jointFlags[band] = 1;
      mixFlags[band] = 1;
    } else {
      jointFlags[band] = 0;
      mixFlags[band] = 0;
    }
  }
}

function measurePeakMetrics(source, spectrum) {
  if (!(source instanceof Float32Array)) {
    return { peakBin: -1, peakRatio: 0, peakMagnitude: 0 };
  }

  dftXAt5(source, AT5_GHWAVE_FRAME_SAMPLES, spectrum, 0);

  const peakBin = findPeakBin(spectrum, AT5_GHWAVE_DFT_BINS);
  let strongestBinValue = spectrum[0];
  let totalValue = spectrum[0];

  for (let bin = 1; bin < AT5_GHWAVE_DFT_BINS; bin += 1) {
    const value = spectrum[bin];
    if (value > strongestBinValue) {
      strongestBinValue = value;
    }
    totalValue += value;
  }

  return {
    peakBin: peakBin | 0,
    peakRatio: totalValue !== 0 ? (strongestBinValue * AT5_GHWAVE_DFT_BINS) / totalValue : 0,
    peakMagnitude: peakBin === -1 ? 0 : spectrum[peakBin],
  };
}

function resetPeakMetricState(peakMeasuredByCh, peakRatioByCh, peakMagnitudeByCh, channelCount) {
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    peakMeasuredByCh[channelIndex].fill(0);
    peakRatioByCh[channelIndex].fill(0);
    peakMagnitudeByCh[channelIndex].fill(0);
  }
}

function storePeakMetrics(
  peakBinsByCh,
  peakMeasuredByCh,
  peakRatioByCh,
  peakMagnitudeByCh,
  channelIndex,
  band,
  metrics
) {
  peakBinsByCh[channelIndex][band] = metrics.peakBin | 0;
  peakMeasuredByCh[channelIndex][band] = 1;
  peakRatioByCh[channelIndex][band] = metrics.peakRatio;
  peakMagnitudeByCh[channelIndex][band] = metrics.peakMagnitude;
}

function storeJointPeakMetrics(
  peakBinsByCh,
  peakMeasuredByCh,
  peakRatioByCh,
  peakMagnitudeByCh,
  band,
  metrics,
  channelCount
) {
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    storePeakMetrics(
      peakBinsByCh,
      peakMeasuredByCh,
      peakRatioByCh,
      peakMagnitudeByCh,
      channelIndex,
      band,
      metrics
    );
  }
}

function ensurePeakMetricsForBand(
  channelIndex,
  band,
  analysisPtrs,
  analysisBase,
  jointFlags,
  mixFlags,
  peakBinsByCh,
  peakMeasuredByCh,
  peakRatioByCh,
  peakMagnitudeByCh,
  channelCount,
  mixed,
  spectrum
) {
  if ((peakMeasuredByCh[channelIndex][band] | 0) !== 0) {
    return;
  }

  if ((jointFlags[band] | 0) === 0) {
    const source = analysisPtrs?.[analysisPtrIndex(analysisBase, channelIndex, band)] ?? null;
    storePeakMetrics(
      peakBinsByCh,
      peakMeasuredByCh,
      peakRatioByCh,
      peakMagnitudeByCh,
      channelIndex,
      band,
      measurePeakMetrics(source, spectrum)
    );
    return;
  }

  mixed.fill(0);
  const left = analysisPtrs?.[analysisPtrIndex(analysisBase, 0, band)] ?? null;
  const right = analysisPtrs?.[analysisPtrIndex(analysisBase, 1, band)] ?? null;
  if (left && right) {
    if ((mixFlags[band] | 0) === 0) {
      mixSeqAt5(left, right, mixed, AT5_GHWAVE_FRAME_SAMPLES);
    } else {
      invmixSeqAt5(left, right, mixed, AT5_GHWAVE_FRAME_SAMPLES);
    }
  }

  storeJointPeakMetrics(
    peakBinsByCh,
    peakMeasuredByCh,
    peakRatioByCh,
    peakMagnitudeByCh,
    band,
    measurePeakMetrics(mixed, spectrum),
    channelCount
  );
}

function clearChannelMode(selectedModeByCh, candidateFlagsByCh, channelIndex) {
  selectedModeByCh[channelIndex] = 0;
  candidateFlagsByCh[channelIndex] = 0;
}

function relativePeakDb(peakMagnitudes, referenceBand, band) {
  const referenceMagnitude = peakMagnitudes[referenceBand];
  if (referenceMagnitude === 0) {
    return AT5_GHWAVE_INVALID_PEAK_DB;
  }

  const ratio = peakMagnitudes[band] / referenceMagnitude;
  return ratio > 0 ? Math.log(ratio) * AT5_GHWAVE_WEIGHT_DB_SCALE : AT5_GHWAVE_INVALID_PEAK_DB;
}

export function at5GhwaveRefineModeCandidatesFromPeaks(options) {
  const {
    analysisPtrs,
    analysisBase,
    bandCount,
    channelCount,
    jointFlags,
    mixFlags,
    sortedBandsByCh,
    chTotalPower,
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    peakBinsByCh,
    encodeFlags,
    scratch = null,
  } = options ?? {};
  if (
    !jointFlags ||
    !mixFlags ||
    !sortedBandsByCh ||
    !chTotalPower ||
    !selectedModeByCh ||
    !mode2CandidateByCh ||
    !mode1CandidateByCh ||
    !peakBinsByCh
  ) {
    return;
  }

  const ptrs = Array.isArray(analysisPtrs) ? analysisPtrs : null;
  const base = analysisBase | 0;
  const bands = clampGhwaveBandCount(bandCount);
  const channels = clampGhwaveChannelCount(channelCount);
  const scratchObj = scratch && typeof scratch === "object" ? scratch : null;
  const peakMeasuredByCh = ensureI32x2(scratchObj?.peakDoneByCh, AT5_GHWAVE_MAX_BANDS);
  const peakRatioByCh = ensureF32x2(scratchObj?.peakRatioByCh, AT5_GHWAVE_MAX_BANDS);
  const peakMagnitudeByCh = ensureF32x2(scratchObj?.peakMagByCh, AT5_GHWAVE_MAX_BANDS);
  const mixed = ensureF32(scratchObj?.peakMixed, AT5_GHWAVE_FRAME_SAMPLES);
  const spectrum = ensureF32(scratchObj?.peakSpec, AT5_GHWAVE_SPECTRUM_SIZE);

  if (scratchObj) {
    scratchObj.peakDoneByCh = peakMeasuredByCh;
    scratchObj.peakRatioByCh = peakRatioByCh;
    scratchObj.peakMagByCh = peakMagnitudeByCh;
    scratchObj.peakMixed = mixed;
    scratchObj.peakSpec = spectrum;
  }

  resetPeakMetricState(peakMeasuredByCh, peakRatioByCh, peakMagnitudeByCh, channels);

  const usesStrictPeakDiff = (encodeFlags & 2) === 0;
  const peakRatioThreshold = usesStrictPeakDiff ? 30.0 : 6.0;
  const peakDiffLimit = usesStrictPeakDiff ? 8 : 16;

  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    if (chTotalPower[channelIndex] < 1.0) {
      selectedModeByCh[channelIndex] = 0;
      mode2CandidateByCh[channelIndex] = 0;
      mode1CandidateByCh[channelIndex] = 0;
      continue;
    }

    const topBand = sortedBandsByCh[channelIndex][0] | 0;

    if ((mode1CandidateByCh[channelIndex] | 0) !== 0) {
      let peakyBandCount = 0;

      for (let rank = 0; rank < bands && (mode1CandidateByCh[channelIndex] | 0) !== 0; rank += 1) {
        const band = sortedBandsByCh[channelIndex][rank] | 0;
        ensurePeakMetricsForBand(
          channelIndex,
          band,
          ptrs,
          base,
          jointFlags,
          mixFlags,
          peakBinsByCh,
          peakMeasuredByCh,
          peakRatioByCh,
          peakMagnitudeByCh,
          channels,
          mixed,
          spectrum
        );

        if ((peakBinsByCh[channelIndex][band] | 0) === -1) {
          clearChannelMode(selectedModeByCh, mode1CandidateByCh, channelIndex);
          break;
        }

        if (peakyBandCount > 1 || peakRatioByCh[channelIndex][band] > peakRatioThreshold) {
          if (usesStrictPeakDiff && peakyBandCount < 2) {
            const peakDiff =
              Math.abs(
                (peakBinsByCh[channelIndex][band] | 0) - (peakBinsByCh[channelIndex][topBand] | 0)
              ) | 0;
            if (peakDiff > peakDiffLimit) {
              mode1CandidateByCh[channelIndex] = 0;
            }
          }
          peakyBandCount += 1;
          continue;
        }

        mode1CandidateByCh[channelIndex] = 0;
      }
      continue;
    }

    if ((mode2CandidateByCh[channelIndex] | 0) === 0) {
      continue;
    }

    for (let rank = 0; rank < bands && (mode2CandidateByCh[channelIndex] | 0) !== 0; rank += 1) {
      const band = sortedBandsByCh[channelIndex][rank] | 0;
      ensurePeakMetricsForBand(
        channelIndex,
        band,
        ptrs,
        base,
        jointFlags,
        mixFlags,
        peakBinsByCh,
        peakMeasuredByCh,
        peakRatioByCh,
        peakMagnitudeByCh,
        channels,
        mixed,
        spectrum
      );

      if ((peakBinsByCh[channelIndex][band] | 0) === -1) {
        clearChannelMode(selectedModeByCh, mode2CandidateByCh, channelIndex);
        break;
      }

      if (peakRatioByCh[channelIndex][band] <= peakRatioThreshold) {
        mode2CandidateByCh[channelIndex] = 0;
        continue;
      }

      if (
        Math.abs(relativePeakDb(peakMagnitudeByCh[channelIndex], topBand, band)) >=
        AT5_GHWAVE_MODE2_PEAK_DB_LIMIT
      ) {
        mode2CandidateByCh[channelIndex] = 0;
      }
    }
  }
}

export function refineGhwaveModeCandidatesAt5(options) {
  const {
    analysisPtrs,
    analysisBase,
    bandCount,
    channelCount,
    bandPowerByCh,
    bandPowerSum,
    chTotalPower,
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    peakBinsByCh,
    sortedBandsByCh,
    bandSortValues,
    shared,
    currentGlobal,
    scratch,
    sharedAux,
  } = options ?? {};
  const forcedGeneralMode = at5GhwaveClassifyEnergy({
    analysisPtrs,
    analysisBase,
    bandCount,
    channelCount,
    bandPowerByCh,
    bandPowerSum,
    chTotalPower,
    sortedBandsByCh,
    bandSortValues,
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    shared,
    global: currentGlobal,
  });
  if (forcedGeneralMode) {
    return true;
  }

  const jointFlags = currentGlobal?.jointFlags ?? null;
  const mixFlags = currentGlobal?.mixFlags ?? null;
  if (!(jointFlags instanceof Int32Array) || !(mixFlags instanceof Int32Array)) {
    return false;
  }

  if (channelCount === 2) {
    selectJointAndMixFlagsAt5(
      analysisPtrs,
      analysisBase,
      bandCount,
      jointFlags,
      mixFlags,
      scratch,
      sharedAux?.scratch?.corr ?? null
    );
  } else {
    zeroJointFlagsForMono(jointFlags, mixFlags, bandCount);
  }

  at5GhwaveRefineModeCandidatesFromPeaks({
    analysisPtrs,
    analysisBase,
    bandCount,
    channelCount,
    jointFlags,
    mixFlags,
    sortedBandsByCh,
    chTotalPower,
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    peakBinsByCh,
    encodeFlags: (shared?.encodeFlags ?? 0) >>> 0,
    scratch,
  });

  return true;
}

function buildBandOrder(bandCount, bandPowerSum, bandSortValues, bandOrder) {
  for (let band = 0; band < bandCount; band += 1) {
    bandOrder[band] = band;
    bandSortValues[band] = bandPowerSum[band];
  }

  shellSortDesc(bandSortValues, bandOrder, bandCount);
  return bandOrder;
}

function filterGhwaveBandOrderAt5(bandOrder, bandCount, activeBandCount) {
  if ((activeBandCount | 0) <= 0 || (activeBandCount | 0) >= (bandCount | 0)) {
    return bandOrder;
  }

  let out = 0;
  for (let index = 0; index < bandCount; index += 1) {
    const band = bandOrder[index] | 0;
    if (band >= 0 && band < (activeBandCount | 0)) {
      bandOrder[out++] = band;
    }
  }

  return bandOrder;
}

function buildActiveBandOrderAt5(
  bandCount,
  bandPowerSum,
  bandSortValues,
  activeBandCount,
  bandOrder
) {
  return filterGhwaveBandOrderAt5(
    buildBandOrder(bandCount, bandPowerSum, bandSortValues, bandOrder),
    bandCount,
    activeBandCount
  );
}

function resolvedGhwaveChannelMode(selectedMode, mode2Candidate, mode1Candidate) {
  if ((selectedMode | 0) === 0) {
    return 0;
  }
  if ((mode2Candidate | 0) !== 0) {
    return 2;
  }
  if ((mode1Candidate | 0) !== 0) {
    return 1;
  }
  return AT5_GHWAVE_MODE_GENERAL;
}

function lowCoreGhwaveBandCount(bandCount) {
  return Math.min(Math.max(bandCount | 0, 0), 1);
}

export function resolveGhwaveModeConfigAt5(options) {
  const {
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    coreMode,
    channelCount,
    bandCount,
    encodeFlagD0,
    encodeFlags,
    resolvedModeByCh: resolvedModeByChIn,
  } = options ?? {};
  const resolvedModeByCh =
    resolvedModeByChIn instanceof Int32Array &&
    resolvedModeByChIn.length === AT5_GHWAVE_MAX_CHANNELS
      ? resolvedModeByChIn
      : new Int32Array(AT5_GHWAVE_MAX_CHANNELS);
  resolvedModeByCh.fill(0);
  let localMode = 0;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelMode = resolvedGhwaveChannelMode(
      selectedModeByCh?.[channelIndex] ?? 0,
      mode2CandidateByCh?.[channelIndex] ?? 0,
      mode1CandidateByCh?.[channelIndex] ?? 0
    );
    resolvedModeByCh[channelIndex] = channelMode;
    localMode |= channelMode;
  }

  const core = coreMode | 0;
  let globalFlag = 0;
  let globalBandCount = 0;
  let nextEncodeFlags = encodeFlags >>> 0;

  if (core < 0x0c && channelCount === 2) {
    localMode = AT5_GHWAVE_MODE_GENERAL;
    globalFlag = 0;
    globalBandCount = lowCoreGhwaveBandCount(bandCount);
  } else if (core < 10 && channelCount === 1) {
    localMode = AT5_GHWAVE_MODE_GENERAL;
    globalFlag = 0;
    globalBandCount = lowCoreGhwaveBandCount(bandCount);
  } else if ((localMode | 0) === 1) {
    globalFlag = 1;
    globalBandCount = bandCount;
    nextEncodeFlags |= 1;
  } else if ((localMode | 0) === 2) {
    globalFlag = 1;
    globalBandCount = bandCount;
  } else if ((encodeFlagD0 | 0) === 0) {
    globalFlag = 0;
    globalBandCount = 1;
  } else {
    globalFlag = 1;
    globalBandCount =
      (core < 0x13 && channelCount === 1) || (core < 0x19 && channelCount === 2) ? 1 : 2;
    if (globalBandCount > (bandCount | 0)) {
      globalBandCount = bandCount | 0;
    }
  }

  return {
    localMode: localMode | 0,
    globalFlag: globalFlag | 0,
    globalBandCount: globalBandCount | 0,
    encodeFlags: nextEncodeFlags >>> 0,
    resolvedModeByCh,
  };
}

function sineExtractBudgetAt5(coreMode) {
  const core = coreMode | 0;
  if (core < 0x0b) {
    return 0;
  }
  if (core <= 0x0c) {
    return 12;
  }
  return 48;
}

function sineExtractBandWeight(power) {
  return power >= 1.0 ? Math.log(power) * AT5_GHWAVE_WEIGHT_DB_SCALE : 0;
}

function splitSineAllocation(units, channelCount, isJointBand) {
  if ((channelCount | 0) === 1) {
    return [units | 0, 0];
  }

  const first = (units - (units >> 1)) | 0;
  return [first, isJointBand ? 0 : (units - first) | 0];
}

function clampSineAllocation(units) {
  if ((units | 0) < 0) {
    return 0;
  }
  return Math.min(units | 0, 0x0f);
}

export function computeSineExtractAllocationsAt5(
  coreMode,
  channelCount,
  bandCount,
  bandPowerSum,
  bandOrder,
  jointFlags,
  work = null
) {
  const workState = work && typeof work === "object" ? work : null;
  const allocations = workState
    ? (workState.sineAllocations = ensureI32x2(workState.sineAllocations, AT5_GHWAVE_MAX_BANDS))
    : [new Int32Array(AT5_GHWAVE_MAX_BANDS), new Int32Array(AT5_GHWAVE_MAX_BANDS)];
  allocations[0].fill(0);
  allocations[1].fill(0);

  const budget = sineExtractBudgetAt5(coreMode);
  if (budget <= 0) {
    return allocations;
  }

  const bandWeights = workState
    ? (workState.sineBandWeights = ensureF32(workState.sineBandWeights, AT5_GHWAVE_MAX_BANDS))
    : new Float32Array(AT5_GHWAVE_MAX_BANDS);
  bandWeights.fill(0);
  let weightSum = 0;
  for (let band = 0; band < bandCount; band += 1) {
    const weight = sineExtractBandWeight(bandPowerSum?.[band] ?? 0);
    bandWeights[band] = weight;
    weightSum += weight;
  }

  if (!(weightSum > 0)) {
    return allocations;
  }

  let remaining = budget | 0;
  for (let orderIndex = 0; orderIndex < bandCount; orderIndex += 1) {
    const band = bandOrder?.[orderIndex] ?? 0;
    const units = Math.min(
      remaining,
      Math.max(1, Math.floor((budget * bandWeights[band]) / weightSum + 0.5))
    );
    const [firstChannel, secondChannel] = splitSineAllocation(
      units,
      channelCount,
      (jointFlags?.[band] | 0) !== 0
    );

    allocations[0][band] = clampSineAllocation(firstChannel);
    allocations[1][band] = clampSineAllocation(secondChannel);

    remaining -=
      channelCount === 1 ? allocations[0][band] : (allocations[0][band] + allocations[1][band]) | 0;
    if (remaining < 0) {
      remaining = 0;
    }
  }

  return allocations;
}

function updateSinePeakBinFromWindow(
  src,
  analysisState,
  window,
  spectrum,
  peakBins,
  channelIndex,
  band
) {
  window.fill(0);

  const start = analysisState.start | 0;
  const end = analysisState.end | 0;
  if (end > start && src) {
    window.set(src.subarray(start, end), start);
  }

  dftXAt5(window, AT5_GHWAVE_FRAME_SAMPLES, spectrum, 0);
  peakBins[channelIndex][band] = findPeakBin(spectrum, AT5_GHWAVE_DFT_BINS);
}

function countExtractedEntriesAt5(currentSlots, channelCount, bandCount, jointFlags) {
  let totalEntries = 0;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    for (let band = 0; band < bandCount; band += 1) {
      if (channelIndex > 0 && (jointFlags?.[band] | 0) !== 0) {
        continue;
      }

      totalEntries += analysisCtxForSlotConst(currentSlots[channelIndex], band)?.count ?? 0;
    }
  }

  return totalEntries | 0;
}

function disableGhwaveOutputAt5(currentSlots, channelCount, bandCount) {
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const global = currentSlots[channelIndex]?.sharedPtr ?? null;
    if (global) {
      global.enabled = 0;
      global.bandCount = 1;
    }
    resetSlotAnalysisContexts(currentSlots[channelIndex], bandCount);
  }
}

function scratchRoot(sharedAux) {
  const root = sharedAux?.scratch ?? null;
  if (!root || typeof root !== "object") {
    return null;
  }

  const existing = root.ghwave;
  return existing && typeof existing === "object" ? existing : (root.ghwave = {});
}

function ensureI32(value, length) {
  if (value instanceof Int32Array && value.length === length) {
    return value;
  }
  return new Int32Array(length);
}

function ensureF32(value, length) {
  if (value instanceof Float32Array && value.length === length) {
    return value;
  }
  return new Float32Array(length);
}

function ensureI32x2(value, length) {
  if (Array.isArray(value) && value.length === AT5_GHWAVE_MAX_CHANNELS) {
    const first = value[0];
    const second = value[1];
    if (
      first instanceof Int32Array &&
      second instanceof Int32Array &&
      first.length === length &&
      second.length === length
    ) {
      return value;
    }
  }
  return [new Int32Array(length), new Int32Array(length)];
}

function ensureF32x2(value, length) {
  if (Array.isArray(value) && value.length === AT5_GHWAVE_MAX_CHANNELS) {
    const first = value[0];
    const second = value[1];
    if (
      first instanceof Float32Array &&
      second instanceof Float32Array &&
      first.length === length &&
      second.length === length
    ) {
      return value;
    }
  }
  return [new Float32Array(length), new Float32Array(length)];
}

function ensurePtrArray(value, length) {
  if (Array.isArray(value) && value.length === length) {
    return value;
  }
  return new Array(length).fill(null);
}

function at5GhwaveScratch(sharedAux) {
  const scratch = scratchRoot(sharedAux);
  if (!scratch) {
    return null;
  }

  const generalWork =
    scratch.generalWork && typeof scratch.generalWork === "object"
      ? scratch.generalWork
      : (scratch.generalWork = {});

  scratch.peakBinsByCh = ensureI32x2(scratch.peakBinsByCh, AT5_GHWAVE_MAX_BANDS);
  scratch.peakDoneByCh = ensureI32x2(scratch.peakDoneByCh, AT5_GHWAVE_MAX_BANDS);
  scratch.bandPowerByCh = ensureF32x2(scratch.bandPowerByCh, AT5_GHWAVE_MAX_BANDS);
  scratch.sortedBandsByCh = ensureI32x2(scratch.sortedBandsByCh, AT5_GHWAVE_MAX_BANDS);
  scratch.peakRatioByCh = ensureF32x2(scratch.peakRatioByCh, AT5_GHWAVE_MAX_BANDS);
  scratch.peakMagByCh = ensureF32x2(scratch.peakMagByCh, AT5_GHWAVE_MAX_BANDS);

  scratch.bandPowerSum = ensureF32(scratch.bandPowerSum, AT5_GHWAVE_MAX_BANDS);
  scratch.bandSortValues = ensureF32(
    scratch.bandSortValues ?? scratch.tmpValues,
    AT5_GHWAVE_MAX_BANDS
  );
  scratch.bandOrder = ensureI32(scratch.bandOrder, AT5_GHWAVE_MAX_BANDS);
  scratch.corrDb = ensureF32(scratch.corrDb, AT5_GHWAVE_MAX_BANDS);
  scratch.corrPowerA = ensureF32(scratch.corrPowerA, AT5_GHWAVE_MAX_BANDS);
  scratch.corrPowerB = ensureF32(scratch.corrPowerB, AT5_GHWAVE_MAX_BANDS);
  scratch.leftPtrs = ensurePtrArray(scratch.leftPtrs, AT5_GHWAVE_MAX_BANDS);
  scratch.rightPtrs = ensurePtrArray(scratch.rightPtrs, AT5_GHWAVE_MAX_BANDS);
  scratch.tmpPrev = ensureF32(scratch.tmpPrev, AT5_GHWAVE_HALF_SAMPLES);
  scratch.tmpCur = ensureF32(scratch.tmpCur, AT5_GHWAVE_HALF_SAMPLES);
  scratch.tmpSum = ensureF32(scratch.tmpSum, AT5_GHWAVE_HALF_SAMPLES);
  scratch.peakWindow = ensureF32(scratch.peakWindow, AT5_GHWAVE_FRAME_SAMPLES);
  scratch.peakMixed = ensureF32(scratch.peakMixed, AT5_GHWAVE_FRAME_SAMPLES);
  scratch.peakSpec = ensureF32(scratch.peakSpec, AT5_GHWAVE_SPECTRUM_SIZE);

  scratch.chTotalPower = ensureF32(scratch.chTotalPower, AT5_GHWAVE_MAX_CHANNELS);
  scratch.selectedModeByCh = ensureI32(scratch.selectedModeByCh, AT5_GHWAVE_MAX_CHANNELS);
  scratch.mode2CandidateByCh = ensureI32(scratch.mode2CandidateByCh, AT5_GHWAVE_MAX_CHANNELS);
  scratch.mode1CandidateByCh = ensureI32(scratch.mode1CandidateByCh, AT5_GHWAVE_MAX_CHANNELS);
  scratch.resolvedModeByCh = ensureI32(scratch.resolvedModeByCh, AT5_GHWAVE_MAX_CHANNELS);

  generalWork.window = ensureF32(generalWork.window, AT5_GHWAVE_FRAME_SAMPLES);
  generalWork.mixed = ensureF32(generalWork.mixed, AT5_GHWAVE_FRAME_SAMPLES);
  generalWork.spectrumMix = ensureF32(generalWork.spectrumMix, AT5_GHWAVE_SPECTRUM_SIZE);
  generalWork.spectrumCh0 = ensureF32(generalWork.spectrumCh0, AT5_GHWAVE_SPECTRUM_SIZE);
  generalWork.spectrumCh1 = ensureF32(generalWork.spectrumCh1, AT5_GHWAVE_SPECTRUM_SIZE);
  generalWork.freqMask = ensureF32(generalWork.freqMask, AT5_GHWAVE_SPECTRUM_SIZE);
  generalWork.scanBuf = ensureF32(generalWork.scanBuf, AT5_GHWAVE_FRAME_SAMPLES);
  generalWork.scanGroupPeaks = ensureF32(generalWork.scanGroupPeaks, 8);
  generalWork.scanSpectrum = ensureF32(generalWork.scanSpectrum, AT5_GHWAVE_SPECTRUM_SIZE);
  generalWork.entryMagnitudes = ensureF32(generalWork.entryMagnitudes, 16);
  generalWork.entryPhases = ensureI32(generalWork.entryPhases, 16);
  generalWork.entryFrequencies = ensureI32(generalWork.entryFrequencies, 16);

  return scratch;
}

export function runSineModeExtractionAt5(options) {
  const {
    analysisPtrs,
    analysisBase,
    bandCount,
    channelCount,
    bandOrder,
    bandPowerSum,
    previousSlots,
    currentSlots,
    currentGlobal,
    peakBinsByCh,
    scratch,
    shared,
    coreMode,
  } = options ?? {};
  const jointFlags = currentGlobal?.jointFlags ?? null;
  const mixFlags = currentGlobal?.mixFlags ?? null;
  const activeBandCount = currentGlobal.bandCount | 0;
  const allocations = computeSineExtractAllocationsAt5(
    coreMode,
    channelCount,
    activeBandCount,
    bandPowerSum,
    bandOrder,
    jointFlags,
    scratch
  );
  const globalEntries = currentGlobal.entriesU32;
  const scratchObj = scratch && typeof scratch === "object" ? scratch : null;
  const window = ensureF32(scratchObj?.peakWindow, AT5_GHWAVE_FRAME_SAMPLES);
  const spectrum = ensureF32(scratchObj?.peakSpec, AT5_GHWAVE_SPECTRUM_SIZE);
  const mixed = ensureF32(scratchObj?.peakMixed, AT5_GHWAVE_FRAME_SAMPLES);
  if (scratchObj) {
    scratchObj.peakWindow = window;
    scratchObj.peakSpec = spectrum;
    scratchObj.peakMixed = mixed;
  }
  const encodeFlagD0 = shared?.encodeFlagD0 ?? 0;

  let entryCursor = 0;
  for (let orderIndex = 0; orderIndex < activeBandCount; orderIndex += 1) {
    const band = bandOrder[orderIndex] | 0;
    if (band < 0 || band >= bandCount) {
      continue;
    }

    const isJointBand = (jointFlags?.[band] | 0) !== 0;
    if (isJointBand) {
      if (channelCount < 2 || (allocations[0][band] | 0) <= 0) {
        continue;
      }

      const left = analysisPtrs?.[analysisPtrIndex(analysisBase, 0, band)] ?? null;
      const right = analysisPtrs?.[analysisPtrIndex(analysisBase, 1, band)] ?? null;
      if (!left || !right) {
        continue;
      }

      if ((mixFlags?.[band] | 0) === 0) {
        mixSeqAt5(left, right, mixed, AT5_GHWAVE_FRAME_SAMPLES);
      } else {
        invmixSeqAt5(left, right, mixed, AT5_GHWAVE_FRAME_SAMPLES);
      }
    }

    const channelLimit = isJointBand ? 1 : channelCount;
    for (let channelIndex = 0; channelIndex < channelLimit; channelIndex += 1) {
      if ((allocations[channelIndex][band] | 0) <= 0) {
        continue;
      }

      const stateChannel = isJointBand ? 0 : channelIndex;
      const currentState = analysisCtxForSlot(currentSlots[stateChannel], band);
      const previousState = analysisCtxForSlotConst(previousSlots[stateChannel], band);
      if (!currentState || !previousState) {
        continue;
      }
      analysisPrepareWindow(currentState, previousState);

      const source = isJointBand
        ? mixed
        : (analysisPtrs?.[analysisPtrIndex(analysisBase, channelIndex, band)] ?? null);
      if ((encodeFlagD0 | 0) !== 0) {
        updateSinePeakBinFromWindow(
          source,
          currentState,
          window,
          spectrum,
          peakBinsByCh,
          channelIndex,
          band
        );
        if (isJointBand) {
          peakBinsByCh[1][band] = peakBinsByCh[0][band];
        }
      }

      currentState.entries = globalEntries.subarray(entryCursor * 4);
      if (!source) {
        continue;
      }

      analysisSineAt5Sub(source, currentState, peakBinsByCh[channelIndex][band], bandCount);
      if (isJointBand) {
        const siblingState = analysisCtxForSlot(currentSlots[1], band);
        if (siblingState) {
          siblingState.hasStart = currentState.hasStart | 0;
          siblingState.hasEnd = currentState.hasEnd | 0;
          siblingState.start = currentState.start | 0;
          siblingState.end = currentState.end | 0;
          siblingState.count = currentState.count | 0;
          siblingState.entries = currentState.entries;
        }
      }

      entryCursor += currentState.count | 0;
    }
  }
}

export function extractGhwaveAt5(
  channelEntriesIn,
  analysisPtrsIn,
  analysisBaseIn,
  coreMode,
  bandCountIn,
  channelCountIn,
  work = null
) {
  const channelCount = clampGhwaveChannelCount(channelCountIn);
  if (channelCount <= 0) {
    return;
  }

  const bandCount = clampGhwaveBandCount(bandCountIn);
  const channelEntries = Array.isArray(channelEntriesIn) ? channelEntriesIn : null;
  const analysisPtrs = Array.isArray(analysisPtrsIn) ? analysisPtrsIn : null;
  const analysisBase = analysisBaseIn | 0;

  const previousSlots = [null, null];
  const currentSlots = [null, null];
  let shared = null;
  let currentGlobal = null;
  let baseGlobal = null;

  const sharedAux = channelEntries?.[0]?.sharedAux ?? channelEntries?.[0]?.aux ?? null;
  const scratch = at5GhwaveScratch(sharedAux) ?? {};
  const {
    peakBinsByCh = [new Int32Array(AT5_GHWAVE_MAX_BANDS), new Int32Array(AT5_GHWAVE_MAX_BANDS)],
    bandPowerByCh = [
      new Float32Array(AT5_GHWAVE_MAX_BANDS),
      new Float32Array(AT5_GHWAVE_MAX_BANDS),
    ],
    sortedBandsByCh = [new Int32Array(AT5_GHWAVE_MAX_BANDS), new Int32Array(AT5_GHWAVE_MAX_BANDS)],
    bandPowerSum = new Float32Array(AT5_GHWAVE_MAX_BANDS),
    bandSortValues = new Float32Array(AT5_GHWAVE_MAX_BANDS),
    chTotalPower = new Float32Array(AT5_GHWAVE_MAX_CHANNELS),
    selectedModeByCh = new Int32Array(AT5_GHWAVE_MAX_CHANNELS),
    mode2CandidateByCh = new Int32Array(AT5_GHWAVE_MAX_CHANNELS),
    mode1CandidateByCh = new Int32Array(AT5_GHWAVE_MAX_CHANNELS),
    resolvedModeByCh: resolvedModeByChScratch = new Int32Array(AT5_GHWAVE_MAX_CHANNELS),
    bandOrder: bandOrderScratch = new Int32Array(AT5_GHWAVE_MAX_BANDS),
    tmpPrev = new Float32Array(AT5_GHWAVE_HALF_SAMPLES),
    tmpCur = new Float32Array(AT5_GHWAVE_HALF_SAMPLES),
    tmpSum = new Float32Array(AT5_GHWAVE_HALF_SAMPLES),
  } = scratch;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    peakBinsByCh[channelIndex].fill(-1);
    bandPowerByCh[channelIndex].fill(0);
    chTotalPower[channelIndex] = 0;

    const channel = channelEntries?.[channelIndex] ?? null;
    if (!channel) {
      continue;
    }

    shared ??= channel.shared ?? null;
    const previousSlot = channel.slots?.[3] ?? null;
    const currentSlot = channel.slots?.[4] ?? null;
    previousSlots[channelIndex] = previousSlot;
    currentSlots[channelIndex] = currentSlot;

    const slotGlobal = currentSlot?.sharedPtr ?? null;
    if (slotGlobal) {
      currentGlobal = slotGlobal;
      currentGlobal.enabled = 0;
      currentGlobal.bandCount = 1;
    }

    baseGlobal ??= previousSlot?.sharedPtr ?? null;
    resetSlotAnalysisContexts(currentSlot, bandCount);
  }

  if (!currentGlobal || !shared) {
    return;
  }

  if (
    !refineGhwaveModeCandidatesAt5({
      analysisPtrs,
      analysisBase,
      bandCount,
      channelCount,
      bandPowerByCh,
      bandPowerSum,
      chTotalPower,
      selectedModeByCh,
      mode2CandidateByCh,
      mode1CandidateByCh,
      peakBinsByCh,
      sortedBandsByCh,
      bandSortValues,
      shared,
      currentGlobal,
      scratch,
      sharedAux,
    })
  ) {
    return;
  }

  const modeConfig = resolveGhwaveModeConfigAt5({
    selectedModeByCh,
    mode2CandidateByCh,
    mode1CandidateByCh,
    coreMode,
    channelCount,
    bandCount,
    encodeFlagD0: shared?.encodeFlagD0 ?? 0,
    encodeFlags: shared?.encodeFlags ?? 0,
    resolvedModeByCh: resolvedModeByChScratch,
  });
  const bandOrder = buildActiveBandOrderAt5(
    bandCount,
    bandPowerSum,
    bandSortValues,
    modeConfig.globalBandCount,
    bandOrderScratch
  );

  selectedModeByCh.set(modeConfig.resolvedModeByCh);
  currentGlobal.flag = modeConfig.globalFlag | 0;
  currentGlobal.bandCount = modeConfig.globalBandCount | 0;
  shared.encodeFlags = modeConfig.encodeFlags >>> 0;

  const encodeFlagD0 = (shared.encodeFlagD0 ?? 0) | 0;
  const isGeneralMode = (modeConfig.localMode | 0) === AT5_GHWAVE_MODE_GENERAL;
  const generalWork = work ?? scratch.generalWork ?? null;
  const baseFlag = baseGlobal ? baseGlobal.flag >>> 0 : 0;
  const currentFlag = currentGlobal.flag >>> 0;
  const residualArgs = {
    analysisPtrs,
    analysisBase,
    channelCount,
    bandCount,
    p20Slots: previousSlots,
    p24Slots: currentSlots,
    baseGlobal,
    global: currentGlobal,
    baseFlag,
    curFlag: currentFlag,
    tmpPrev,
    tmpCur,
    tmpSum,
  };

  if (isGeneralMode && encodeFlagD0 === 0) {
    at5GhwaveApplySynthesisResidual({
      ...residualArgs,
      requirePrevEntries: true,
    });

    currentGlobal.enabled = 0;
    return;
  }

  if (isGeneralMode) {
    analysisGeneralAt5(
      channelEntries,
      analysisPtrs,
      analysisBase,
      coreMode | 0,
      channelCount,
      peakBinsByCh,
      bandPowerByCh,
      bandOrder,
      generalWork
    );
  } else {
    runSineModeExtractionAt5({
      analysisPtrs,
      analysisBase,
      bandCount,
      channelCount,
      bandOrder,
      bandPowerSum,
      previousSlots,
      currentSlots,
      currentGlobal,
      peakBinsByCh,
      scratch,
      shared,
      coreMode: coreMode | 0,
    });
  }

  if (
    countExtractedEntriesAt5(
      currentSlots,
      channelCount,
      bandCount,
      currentGlobal.jointFlags ?? null
    ) > AT5_GHWAVE_MAX_TOTAL_ENTRIES
  ) {
    disableGhwaveOutputAt5(currentSlots, channelCount, bandCount);
  }

  at5GhwaveApplySynthesisResidual(residualArgs);

  currentGlobal.enabled = 1;
}
