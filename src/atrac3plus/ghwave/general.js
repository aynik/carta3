import {
  AT5_ANALYSIS_K1,
  AT5_ANALYSIS_GROUP_SCALE,
  AT5_ANALYSIS_MAG_SCALE,
  AT5_ANALYSIS_MAG_THRESH,
  AT5_ANALYSIS_PHASE_SCALE,
  AT5_ANALYSIS_RATIO_HI,
  AT5_ANALYSIS_RATIO_LO,
  AT5_ANALYSIS_SCALE_09F,
  AT5_ANALYSIS_SCALE_0BF,
  AT5_ANALYSIS_SCALE_0DF,
  AT5_ANALYSIS_SCALE_0FF,
  AT5_ANALYSIS_SCALE_DEFAULT,
  AT5_ANALYSIS_SCALE_FULL,
  AT5_ANALYSIS_ZERO,
} from "../tables/encode-init.js";
import { AT5_GHA_AMP, AT5_SFTBL_GHA, AT5_SIN } from "../tables/decode.js";
import { invmixSeqAt5, mixSeqAt5 } from "../dsp.js";
import { dftXAt5 } from "../dft.js";

import { fineAnalysisAt5 } from "./component.js";
import { analysisCtxForSlot, analysisCtxForSlotConst } from "./ctx.js";
import { analysisComputeGate, analysisPrepareWindow } from "./gate.js";
import { checkPowerLevelAt5F32, findPeakBin, searchPairedScaleIndex } from "./util.js";

const AT5_ANALYSIS_WEIGHT_DB_SCALE = 8.68588924407959;
const AT5_ANALYSIS_INVALID_WEIGHT_DB = -160;
const AT5_ANALYSIS_MAX_BANDS = 16;
const AT5_ANALYSIS_MAX_CHANNELS = 2;
const AT5_ANALYSIS_GATE_STRIDE = 4;
const AT5_DFT_N = 0x100;
const AT5_DFT_BINS = 0x81;
const AT5_ANALYSIS_SPECTRUM_SIZE = 0x84;
const AT5_ANALYSIS_BAND_STRIDE = 16;
const AT5_ANALYSIS_BAND0_SPLIT_BIN = 0x40;
const AT5_ANALYSIS_BAND0_RATIO_LIMIT = 16;
const AT5_ANALYSIS_JOINT_RATIO_MIN = 0.25;
const AT5_ANALYSIS_JOINT_RATIO_MAX = 4;
const AT5_ANALYSIS_ENTRY_WIDTH = 4;
const AT5_ANALYSIS_GROUP_COUNT = 8;
const AT5_ANALYSIS_GROUP_SIZE = 0x20;
const AT5_ANALYSIS_MAX_ENTRIES = 16;
const AT5_ANALYSIS_QUANTIZED_PHASE_MASK = 0x1f;
const AT5_ANALYSIS_PHASE_MASK = 0x7ff;

function analysisSourceIndex(srcBase, channelIndex, band) {
  return (srcBase | 0) + (channelIndex | 0) * AT5_ANALYSIS_BAND_STRIDE + (band | 0);
}

function clampAnalysisChannelCount(channelCount) {
  if ((channelCount | 0) <= 0) {
    return 0;
  }
  return Math.min(channelCount | 0, AT5_ANALYSIS_MAX_CHANNELS);
}

function clampAnalysisBandCount(bandCount) {
  return Math.min(Math.max(bandCount | 0, 0), AT5_ANALYSIS_MAX_BANDS);
}

function reuseF32Array(value, length) {
  return value instanceof Float32Array && value.length === length
    ? value
    : new Float32Array(length);
}

function reuseI32Array(value, length) {
  return value instanceof Int32Array && value.length === length ? value : new Int32Array(length);
}

function reuseU32Array(value, length) {
  return value instanceof Uint32Array && value.length === length ? value : new Uint32Array(length);
}

function generalAnalysisBudgetAt5(analysisParam) {
  const param = analysisParam | 0;
  if (param < 5) {
    return 3;
  }
  if (param <= 10) {
    return 6;
  }
  if (param <= 12) {
    return 0x0c;
  }
  if (param <= 14) {
    return 0x18;
  }
  return 0x30;
}

function transformAnalysisWeight(weight) {
  if (weight < 1) {
    return 0;
  }

  return weight > 0
    ? Math.log(weight) * AT5_ANALYSIS_WEIGHT_DB_SCALE
    : AT5_ANALYSIS_INVALID_WEIGHT_DB;
}

function clampEntryBudget(entryCount) {
  if ((entryCount | 0) < 0) {
    return 0;
  }
  return Math.min(entryCount | 0, 0x0f);
}

function rebalanceBandUnits(perBandUnits, budget, bandCount) {
  let totalUnits = 0;
  for (let band = 0; band < bandCount; band += 1) {
    totalUnits += perBandUnits[band] | 0;
  }

  const diff = (budget - totalUnits) | 0;
  if (diff > 1 && bandCount > 0) {
    perBandUnits[0] = (perBandUnits[0] + diff) >>> 0;
  }
}

function splitBandUnitsAcrossChannels(units, channelCount, isJointBand) {
  if ((channelCount | 0) === 1) {
    return [units | 0, 0];
  }

  const firstChannel = (units - (units >> 1)) | 0;
  return [firstChannel, isJointBand ? 0 : (units - firstChannel) | 0];
}

function searchGhaIndex(value) {
  return searchPairedScaleIndex(AT5_SFTBL_GHA, 0x3f, value);
}

function searchAmpIndex(value) {
  return searchPairedScaleIndex(AT5_GHA_AMP, 0x0f, value);
}

function quantizeAnalysisPhase(phase) {
  const phaseIndex = Math.floor(phase * AT5_ANALYSIS_PHASE_SCALE + AT5_ANALYSIS_SCALE_DEFAULT) | 0;
  return phaseIndex & AT5_ANALYSIS_QUANTIZED_PHASE_MASK;
}

function encodeFlag1EntryAt5(entries, entryIndex, magnitude, phase, frequency) {
  const scaledMagnitude = magnitude * AT5_ANALYSIS_MAG_SCALE;
  const scaleIndex =
    AT5_ANALYSIS_MAG_THRESH > scaledMagnitude ? 0 : searchGhaIndex(scaledMagnitude);
  const quantizedPhase = quantizeAnalysisPhase(phase);
  const entryOffset = entryIndex * AT5_ANALYSIS_ENTRY_WIDTH;

  entries[entryOffset + 0] = scaleIndex >>> 0;
  entries[entryOffset + 2] = quantizedPhase >>> 0;
  entries[entryOffset + 3] = frequency >>> 0;

  return {
    magnitude: AT5_SFTBL_GHA[scaleIndex] ?? 0,
    phase: quantizedPhase << 6,
  };
}

function encodeFlag0EntriesAt5(entries, entryCount, magnitudes, phases, frequencies) {
  if ((entryCount | 0) <= 0) {
    return;
  }

  let maxMagnitude = Math.abs(magnitudes[0]);
  for (let entryIndex = 0; entryIndex < (entryCount | 0); entryIndex += 1) {
    const entryOffset = entryIndex * AT5_ANALYSIS_ENTRY_WIDTH;
    const magnitude = Math.abs(magnitudes[entryIndex]);
    entries[entryOffset + 3] = frequencies[entryIndex] >>> 0;
    if (magnitude > maxMagnitude) {
      maxMagnitude = magnitude;
    }
  }

  const scaledMagnitude = maxMagnitude * AT5_ANALYSIS_MAG_SCALE;
  const baseIndex = AT5_ANALYSIS_MAG_THRESH > scaledMagnitude ? 0 : searchGhaIndex(scaledMagnitude);
  const baseMagnitude = AT5_SFTBL_GHA[baseIndex] ?? 0;
  const amplitudeBias = AT5_ANALYSIS_K1 * AT5_ANALYSIS_SCALE_DEFAULT;

  for (let entryIndex = 0; entryIndex < (entryCount | 0); entryIndex += 1) {
    const normalizedMagnitude = magnitudes[entryIndex] / baseMagnitude;
    const adjustedMagnitude = normalizedMagnitude - amplitudeBias;

    let amplitudeIndex = 0;
    if (adjustedMagnitude < 0) {
      amplitudeIndex = -1;
    } else if (adjustedMagnitude >= AT5_ANALYSIS_K1) {
      amplitudeIndex = searchAmpIndex(adjustedMagnitude);
    }

    const entryOffset = entryIndex * AT5_ANALYSIS_ENTRY_WIDTH;
    entries[entryOffset + 0] = baseIndex >>> 0;
    entries[entryOffset + 1] = amplitudeIndex >>> 0;
    entries[entryOffset + 2] = quantizeAnalysisPhase(phases[entryIndex]) >>> 0;
  }
}

export function finalizeGeneralEntriesAt5(entries, entryCount, flag) {
  const mode = flag | 0;
  if (mode !== 0 && mode !== 1) {
    return 0;
  }

  let writeIndex = 0;
  for (let entryIndex = 0; entryIndex < (entryCount | 0); entryIndex += 1) {
    const entryOffset = entryIndex * AT5_ANALYSIS_ENTRY_WIDTH;
    if (mode === 0) {
      const baseIndex = entries[entryOffset + 0] | 0;
      const amplitudeIndex = entries[entryOffset + 1] | 0;
      if ((amplitudeIndex + 1) * baseIndex === 0) {
        continue;
      }
    }

    const writeOffset = writeIndex * AT5_ANALYSIS_ENTRY_WIDTH;
    if (writeOffset !== entryOffset) {
      entries[writeOffset + 0] = entries[entryOffset + 0];
      entries[writeOffset + 1] = entries[entryOffset + 1];
      entries[writeOffset + 2] = entries[entryOffset + 2];
      entries[writeOffset + 3] = entries[entryOffset + 3];
    }
    writeIndex += 1;
  }

  for (let entryIndex = 1; entryIndex < writeIndex; entryIndex += 1) {
    const entryOffset = entryIndex * AT5_ANALYSIS_ENTRY_WIDTH;
    const cur0 = entries[entryOffset + 0];
    const cur1 = entries[entryOffset + 1];
    const cur2 = entries[entryOffset + 2];
    const cur3 = entries[entryOffset + 3];
    const curFrequency = cur3 | 0;

    let insertAt = entryIndex - 1;
    while (insertAt >= 0) {
      const prevOffset = insertAt * AT5_ANALYSIS_ENTRY_WIDTH;
      const prevFrequency = entries[prevOffset + 3] | 0;
      if (prevFrequency <= curFrequency) {
        break;
      }

      const shiftedOffset = (insertAt + 1) * AT5_ANALYSIS_ENTRY_WIDTH;
      entries[shiftedOffset + 0] = entries[prevOffset + 0];
      entries[shiftedOffset + 1] = entries[prevOffset + 1];
      entries[shiftedOffset + 2] = entries[prevOffset + 2];
      entries[shiftedOffset + 3] = entries[prevOffset + 3];
      insertAt -= 1;
    }

    const insertOffset = (insertAt + 1) * AT5_ANALYSIS_ENTRY_WIDTH;
    entries[insertOffset + 0] = cur0;
    entries[insertOffset + 1] = cur1;
    entries[insertOffset + 2] = cur2;
    entries[insertOffset + 3] = cur3;
  }

  return writeIndex | 0;
}

function jointBandWindowsMatch(left, right) {
  return (
    !!left &&
    !!right &&
    (left.gateStartValid | 0) === (right.gateStartValid | 0) &&
    (left.gateEndValid | 0) === (right.gateEndValid | 0) &&
    (left.gateStartIdx | 0) === (right.gateStartIdx | 0) &&
    (left.gateEndIdx | 0) === (right.gateEndIdx | 0)
  );
}

function copyWindowedSamples(window, src, analysisState) {
  window.fill(0);

  const span = (analysisState.end - analysisState.start) & 0x3fffffff;
  if (span > 0 && src) {
    window.set(src.subarray(analysisState.start, analysisState.start + span), analysisState.start);
  }
}

export function applyBand0FrequencyLimitAt5(spectrum, freqMask) {
  let lowBandSum = 0;
  for (let bin = 0; bin < AT5_ANALYSIS_BAND0_SPLIT_BIN; bin += 1) {
    lowBandSum += spectrum[bin];
  }

  let highBandSum = 0;
  for (let bin = AT5_ANALYSIS_BAND0_SPLIT_BIN; bin < 0x80; bin += 1) {
    highBandSum += spectrum[bin];
  }

  let ratio = 0;
  if (lowBandSum > 0 && highBandSum > 0) {
    ratio = lowBandSum / highBandSum;
  }

  if (ratio > AT5_ANALYSIS_BAND0_RATIO_LIMIT) {
    for (let bin = AT5_ANALYSIS_BAND0_SPLIT_BIN; bin < AT5_DFT_BINS; bin += 1) {
      freqMask[bin] = 0;
    }
  }
}

function applyFrequencyMask(spectrum, freqMask) {
  for (let bin = 0; bin < AT5_DFT_BINS; bin += 1) {
    spectrum[bin] *= freqMask[bin];
  }
}

function prepareIndependentFrequencyMaskAt5(spectrum, band, freqMask) {
  freqMask.fill(1, 0, AT5_DFT_BINS);
  if ((band | 0) === 0) {
    applyBand0FrequencyLimitAt5(spectrum, freqMask);
  }
  applyFrequencyMask(spectrum, freqMask);
}

function prepareJointFrequencyMaskAt5(spectrumMix, spectrumCh0, spectrumCh1, band, freqMask) {
  freqMask.fill(0, 0, AT5_DFT_BINS);

  for (let bin = 0; bin < AT5_DFT_BINS; bin += 1) {
    const rightPower = spectrumCh1[bin];
    if (!(rightPower > 0)) {
      continue;
    }

    const stereoRatio = spectrumCh0[bin] / rightPower;
    if (stereoRatio > AT5_ANALYSIS_JOINT_RATIO_MIN && AT5_ANALYSIS_JOINT_RATIO_MAX > stereoRatio) {
      freqMask[bin] = 1;
    }
  }

  if ((band | 0) === 0) {
    applyBand0FrequencyLimitAt5(spectrumMix, freqMask);
  }

  applyFrequencyMask(spectrumMix, freqMask);
}

function copyJointAnalysisState(target, source) {
  if (!target || !source) {
    return;
  }

  target.hasStart = source.hasStart | 0;
  target.hasEnd = source.hasEnd | 0;
  target.start = source.start | 0;
  target.end = source.end | 0;
  target.gateStartValid = source.gateStartValid | 0;
  target.gateEndValid = source.gateEndValid | 0;
  target.gateStartIdx = source.gateStartIdx | 0;
  target.gateEndIdx = source.gateEndIdx | 0;
  target.count = source.count | 0;
  target.entries = source.entries;
}

function prepareAnalysisGatesAt5(
  srcList,
  srcBase,
  channelCount,
  bandCount,
  currentSlots,
  jointFlags,
  mixFlags
) {
  for (let band = 0; band < bandCount; band += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const samples = srcList?.[analysisSourceIndex(srcBase, channelIndex, band)] ?? null;
      const analysisState = analysisCtxForSlot(currentSlots[channelIndex], band);
      if (!analysisState || !samples) {
        continue;
      }

      analysisComputeGate(samples, analysisState, AT5_ANALYSIS_GATE_STRIDE, 0);
    }

    if (
      channelCount > 1 &&
      (jointFlags[band] | 0) !== 0 &&
      !jointBandWindowsMatch(
        analysisCtxForSlotConst(currentSlots[0], band),
        analysisCtxForSlotConst(currentSlots[1], band)
      )
    ) {
      jointFlags[band] = 0;
      mixFlags[band] = 0;
    }
  }
}

/**
 * Distribute generalized-harmonic entry budgets across active bands.
 */
export function computeGeneralMaxEntryCountsAt5(options) {
  const { analysisParam, channelCount, bandCount, weightsByCh, bandOrder, jointFlags, work } =
    options ?? {};
  const analysisWork = work && typeof work === "object" ? work : null;
  let maxEntriesByChannel = Array.isArray(analysisWork?.maxEntriesByChannel)
    ? analysisWork.maxEntriesByChannel
    : null;
  if (
    !maxEntriesByChannel ||
    maxEntriesByChannel.length !== AT5_ANALYSIS_MAX_CHANNELS ||
    !(maxEntriesByChannel[0] instanceof Int32Array) ||
    maxEntriesByChannel[0].length !== AT5_ANALYSIS_MAX_BANDS ||
    !(maxEntriesByChannel[1] instanceof Int32Array) ||
    maxEntriesByChannel[1].length !== AT5_ANALYSIS_MAX_BANDS
  ) {
    maxEntriesByChannel = Array.from(
      { length: AT5_ANALYSIS_MAX_CHANNELS },
      () => new Int32Array(AT5_ANALYSIS_MAX_BANDS)
    );
    if (analysisWork) {
      analysisWork.maxEntriesByChannel = maxEntriesByChannel;
    }
  } else {
    maxEntriesByChannel[0].fill(0);
    maxEntriesByChannel[1].fill(0);
  }

  const transformedWeights = reuseF32Array(
    analysisWork?.transformedWeights,
    AT5_ANALYSIS_MAX_BANDS
  );
  const perBandUnits = reuseU32Array(analysisWork?.perBandUnits, AT5_ANALYSIS_MAX_BANDS);
  if (analysisWork) {
    analysisWork.transformedWeights = transformedWeights;
    analysisWork.perBandUnits = perBandUnits;
  }
  let transformedWeightSum = 0;

  for (let band = 0; band < bandCount; band += 1) {
    let combinedWeight = 0;
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      combinedWeight += weightsByCh?.[channelIndex]?.[band] ?? 0;
    }

    const transformedWeight = transformAnalysisWeight(combinedWeight);
    transformedWeights[band] = transformedWeight;
    transformedWeightSum += transformedWeight;
  }

  if (!(transformedWeightSum > 0)) {
    return maxEntriesByChannel;
  }

  const budget = generalAnalysisBudgetAt5(analysisParam);
  const scalableBudget = Math.max(budget - bandCount * 4 - 4, 0) >>> 0;

  for (let band = 0; band < bandCount; band += 1) {
    const weightedShare = Math.floor(
      (scalableBudget * transformedWeights[band]) / transformedWeightSum + 0.5
    );
    let units = (weightedShare | 0) + 4;
    if (units < 4) {
      units = 4;
    }
    if (band < 2) {
      units += 2;
    }
    perBandUnits[band] = (units & ~1) >>> 0;
  }

  rebalanceBandUnits(perBandUnits, budget, bandCount);

  for (let orderIndex = 0; orderIndex < bandCount; orderIndex += 1) {
    const band = bandOrder?.[orderIndex] ?? 0;
    if (band >>> 0 >= bandCount >>> 0) {
      continue;
    }

    const units = Math.min(perBandUnits[band] >>> 0, budget >>> 0);
    const [firstChannel, secondChannel] = splitBandUnitsAcrossChannels(
      units,
      channelCount,
      (jointFlags?.[band] | 0) !== 0
    );

    maxEntriesByChannel[0][band] = clampEntryBudget(firstChannel);
    maxEntriesByChannel[1][band] = clampEntryBudget(secondChannel);
  }

  return maxEntriesByChannel;
}

export function analysisGeneralAt5(
  ctxList,
  srcList,
  srcBase,
  analysisParam,
  chCountIn,
  peakBinsByCh,
  weightsByCh,
  bandOrder,
  work
) {
  const channelCount = clampAnalysisChannelCount(chCountIn);
  if (channelCount <= 0) {
    return;
  }

  const analysisWork = work && typeof work === "object" ? work : null;

  const srcBaseIndex = srcBase | 0;
  const previousSlots = new Array(AT5_ANALYSIS_MAX_CHANNELS).fill(null);
  const currentSlots = new Array(AT5_ANALYSIS_MAX_CHANNELS).fill(null);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelCtx = ctxList?.[channelIndex] ?? null;
    if (!channelCtx?.slots) {
      continue;
    }

    previousSlots[channelIndex] = channelCtx.slots[3] ?? null;
    currentSlots[channelIndex] = channelCtx.slots[4] ?? null;
  }

  const sharedState = currentSlots[0]?.sharedPtr ?? null;
  if (!sharedState) {
    return;
  }

  const entryFlag = sharedState.flag | 0;
  const bandCount = clampAnalysisBandCount(sharedState.bandCount ?? 0);
  const jointFlags = sharedState.jointFlags ?? null;
  const mixFlags = sharedState.mixFlags ?? null;
  if (!(jointFlags instanceof Int32Array) || !(mixFlags instanceof Int32Array)) {
    return;
  }

  prepareAnalysisGatesAt5(
    srcList,
    srcBaseIndex,
    channelCount,
    bandCount,
    currentSlots,
    jointFlags,
    mixFlags
  );

  const maxEntriesByChannel = computeGeneralMaxEntryCountsAt5({
    analysisParam,
    channelCount,
    bandCount,
    weightsByCh,
    bandOrder,
    jointFlags,
    work: analysisWork,
  });

  const window = reuseF32Array(analysisWork?.window, AT5_DFT_N);
  const mixed = reuseF32Array(analysisWork?.mixed, AT5_DFT_N);
  const spectrumMix = reuseF32Array(analysisWork?.spectrumMix, AT5_ANALYSIS_SPECTRUM_SIZE);
  const spectrumCh0 = reuseF32Array(analysisWork?.spectrumCh0, AT5_ANALYSIS_SPECTRUM_SIZE);
  const spectrumCh1 = reuseF32Array(analysisWork?.spectrumCh1, AT5_ANALYSIS_SPECTRUM_SIZE);
  const freqMask = reuseF32Array(analysisWork?.freqMask, AT5_ANALYSIS_SPECTRUM_SIZE);
  const sharedEntries = sharedState.entriesU32;

  let entryCursor = 0;

  for (let orderIndex = 0; orderIndex < bandCount; orderIndex += 1) {
    const band = bandOrder?.[orderIndex] ?? 0;
    if (band >>> 0 >= bandCount >>> 0) {
      continue;
    }

    const isJointBand = (jointFlags[band] | 0) !== 0;
    if (isJointBand && channelCount < 2) {
      continue;
    }

    let source = null;
    let leftSrc = null;
    let rightSrc = null;
    if (isJointBand) {
      leftSrc = srcList?.[analysisSourceIndex(srcBaseIndex, 0, band)] ?? null;
      rightSrc = srcList?.[analysisSourceIndex(srcBaseIndex, 1, band)] ?? null;
      if (!leftSrc || !rightSrc) {
        continue;
      }

      if ((mixFlags[band] | 0) === 0) {
        mixSeqAt5(leftSrc, rightSrc, mixed, AT5_DFT_N);
      } else {
        invmixSeqAt5(leftSrc, rightSrc, mixed, AT5_DFT_N);
      }
      source = mixed;
    }

    const channelLimit = isJointBand ? 1 : channelCount;
    for (let channelIndex = 0; channelIndex < channelLimit; channelIndex += 1) {
      const entryBudget = maxEntriesByChannel[channelIndex][band] | 0;
      if (entryBudget <= 0) {
        continue;
      }

      const stateChannel = isJointBand ? 0 : channelIndex;
      const analysisState = analysisCtxForSlot(currentSlots[stateChannel], band);
      const fallbackState = analysisCtxForSlotConst(previousSlots[stateChannel], band);
      if (!analysisState || !fallbackState) {
        continue;
      }

      source ??= srcList?.[analysisSourceIndex(srcBaseIndex, channelIndex, band)] ?? null;
      analysisPrepareWindow(analysisState, fallbackState);
      copyWindowedSamples(window, source, analysisState);
      dftXAt5(window, AT5_DFT_N, spectrumMix, 0);

      if (isJointBand) {
        dftXAt5(leftSrc, AT5_DFT_N, spectrumCh0, 0);
        dftXAt5(rightSrc, AT5_DFT_N, spectrumCh1, 0);
        prepareJointFrequencyMaskAt5(spectrumMix, spectrumCh0, spectrumCh1, band, freqMask);
      } else {
        prepareIndependentFrequencyMaskAt5(spectrumMix, band, freqMask);
      }

      const peakBin = findPeakBin(spectrumMix, AT5_DFT_BINS);
      peakBinsByCh[channelIndex][band] = peakBin;

      analysisState.entries = sharedEntries.subarray(entryCursor * 4);
      analysisGeneralAt5Sub(
        source,
        analysisState,
        entryFlag,
        peakBin,
        freqMask,
        entryBudget,
        channelCount,
        analysisParam,
        analysisWork
      );

      if (isJointBand) {
        copyJointAnalysisState(analysisCtxForSlot(currentSlots[1], band), analysisState);
      }

      entryCursor += analysisState.count | 0;
      source = null;
    }
  }
}

function selectAnalysisRatioLimit(mode, param) {
  const highThreshold = (mode | 0) === 2 ? 0x16 : 0x12;
  return param > highThreshold ? AT5_ANALYSIS_RATIO_HI : AT5_ANALYSIS_RATIO_LO;
}

function selectAnalysisBufferScale(sampleCount) {
  if ((sampleCount | 0) === AT5_DFT_N) {
    return AT5_ANALYSIS_SCALE_FULL;
  }
  if (sampleCount > 0xdf) {
    return AT5_ANALYSIS_SCALE_0FF;
  }
  if (sampleCount > 0xbf) {
    return AT5_ANALYSIS_SCALE_0DF;
  }
  if (sampleCount > 0x9f) {
    return AT5_ANALYSIS_SCALE_0BF;
  }
  if (sampleCount > 0x7f) {
    return AT5_ANALYSIS_SCALE_09F;
  }
  return AT5_ANALYSIS_SCALE_DEFAULT;
}

function initializeAnalysisBuffer(buf, src, sampleStart, sampleCount) {
  buf.fill(0);
  if (sampleCount > 0) {
    buf.set(src.subarray(sampleStart, sampleStart + sampleCount), sampleStart);
  }

  const scale = selectAnalysisBufferScale(sampleCount);
  for (let sampleIndex = 0; sampleIndex < AT5_DFT_N; sampleIndex += 1) {
    buf[sampleIndex] *= scale;
  }

  return buf;
}

function measureAnalysisWindowPower(buf, sampleStart, sampleEnd, sampleCount) {
  const window = buf.subarray(sampleStart, sampleEnd);
  return checkPowerLevelAt5F32(window, window, sampleCount);
}

function scanSourceGroupPeaks(src, groupPeaks) {
  let dominantGroupIndex = 0;
  let dominantPeak = AT5_ANALYSIS_ZERO;

  for (let group = 0; group < AT5_ANALYSIS_GROUP_COUNT; group += 1) {
    let groupPeak = AT5_ANALYSIS_ZERO;
    const baseIndex = group * AT5_ANALYSIS_GROUP_SIZE;
    const limit = baseIndex + AT5_ANALYSIS_GROUP_SIZE;

    for (let sampleIndex = baseIndex; sampleIndex < limit; sampleIndex += 1) {
      const samplePeak = Math.abs(src[sampleIndex] ?? 0);
      if (samplePeak > groupPeak) {
        groupPeak = samplePeak;
      }
    }

    groupPeaks[group] = groupPeak;
    if (groupPeak > dominantPeak) {
      dominantPeak = groupPeak;
      dominantGroupIndex = group;
    }
  }

  return dominantGroupIndex | 0;
}

function findWeightedPeakBin(buf, spectrum, weights) {
  dftXAt5(buf, AT5_DFT_N, spectrum, 0);
  for (let bin = 0; bin < AT5_DFT_BINS; bin += 1) {
    spectrum[bin] *= weights[bin] ?? 0;
  }
  return findPeakBin(spectrum, AT5_DFT_BINS);
}

function subtractSinusoidFromBuffer(buf, sampleStart, sampleEnd, frequency, phase, magnitude) {
  let phaseAcc = ((sampleStart - 0x81) * frequency + phase) | 0;

  for (let sampleIndex = sampleStart; sampleIndex < sampleEnd; sampleIndex += 4) {
    phaseAcc = (phaseAcc + frequency) | 0;
    buf[sampleIndex + 0] -= magnitude * (AT5_SIN[phaseAcc & AT5_ANALYSIS_PHASE_MASK] ?? 0);

    phaseAcc = (phaseAcc + frequency) | 0;
    buf[sampleIndex + 1] -= magnitude * (AT5_SIN[phaseAcc & AT5_ANALYSIS_PHASE_MASK] ?? 0);

    phaseAcc = (phaseAcc + frequency) | 0;
    buf[sampleIndex + 2] -= magnitude * (AT5_SIN[phaseAcc & AT5_ANALYSIS_PHASE_MASK] ?? 0);

    phaseAcc = (phaseAcc + frequency) | 0;
    buf[sampleIndex + 3] -= magnitude * (AT5_SIN[phaseAcc & AT5_ANALYSIS_PHASE_MASK] ?? 0);
  }
}

function passesLeadingGroupResidualGuard(buf, groupPeaks, dominantGroupIndex) {
  for (let group = 0; group < dominantGroupIndex; group += 1) {
    let residualPeak = AT5_ANALYSIS_ZERO;
    const baseIndex = group * AT5_ANALYSIS_GROUP_SIZE;
    const limit = baseIndex + AT5_ANALYSIS_GROUP_SIZE;

    for (let sampleIndex = baseIndex; sampleIndex < limit; sampleIndex += 1) {
      const samplePeak = Math.abs(buf[sampleIndex]);
      if (samplePeak > residualPeak) {
        residualPeak = samplePeak;
      }
    }

    if (residualPeak > AT5_ANALYSIS_GROUP_SCALE * groupPeaks[group]) {
      return false;
    }
  }

  return true;
}

function scanGeneralCandidatesAt5(
  src,
  sampleStart,
  sampleEnd,
  initialPeakBin,
  weights,
  maxCount,
  flag,
  mode,
  param,
  entries,
  magnitudes,
  phases,
  frequencies,
  work
) {
  const sampleCount = (sampleEnd - sampleStart) | 0;
  const analysisWork = work && typeof work === "object" ? work : null;
  const buf = initializeAnalysisBuffer(
    reuseF32Array(analysisWork?.scanBuf, AT5_DFT_N),
    src,
    sampleStart,
    sampleCount
  );
  const groupPeaks = reuseF32Array(analysisWork?.scanGroupPeaks, AT5_ANALYSIS_GROUP_COUNT);
  const spectrum = reuseF32Array(analysisWork?.scanSpectrum, AT5_ANALYSIS_SPECTRUM_SIZE);
  const dominantGroupIndex = scanSourceGroupPeaks(src, groupPeaks);
  const ratioLimit = selectAnalysisRatioLimit(mode, param);

  let residualPower = measureAnalysisWindowPower(buf, sampleStart, sampleEnd, sampleCount);
  let entryCount = 0;
  let peakBin = initialPeakBin | 0;

  while (peakBin !== -1 && entryCount < (maxCount | 0)) {
    if (entryCount > 0) {
      peakBin = findWeightedPeakBin(buf, spectrum, weights);
      if (peakBin === -1) {
        break;
      }
    }

    const candidate = fineAnalysisAt5(buf, peakBin, sampleStart, sampleEnd);
    if (!candidate) {
      break;
    }

    magnitudes[entryCount] = candidate.magnitude;
    phases[entryCount] = candidate.phase;
    frequencies[entryCount] = candidate.frequency;

    let synthesizedMagnitude = candidate.magnitude;
    let synthesizedPhase = candidate.phase;
    if ((flag | 0) === 1) {
      const encoded = encodeFlag1EntryAt5(
        entries,
        entryCount,
        candidate.magnitude,
        candidate.phase,
        candidate.frequency
      );
      synthesizedMagnitude = encoded.magnitude;
      synthesizedPhase = encoded.phase;
    }

    subtractSinusoidFromBuffer(
      buf,
      sampleStart,
      sampleEnd,
      candidate.frequency,
      synthesizedPhase,
      synthesizedMagnitude
    );

    if (!passesLeadingGroupResidualGuard(buf, groupPeaks, dominantGroupIndex)) {
      break;
    }

    const nextPower = measureAnalysisWindowPower(buf, sampleStart, sampleEnd, sampleCount);
    const ratio = nextPower / residualPower;
    if (nextPower > residualPower) {
      break;
    }

    residualPower = nextPower;
    entryCount += 1;
    if (ratio > ratioLimit) {
      break;
    }
  }

  return entryCount | 0;
}

export function analysisGeneralAt5Sub(
  src,
  state,
  flag,
  initIdx,
  weights,
  maxCount,
  mode,
  param,
  work = null
) {
  if (!state || typeof state !== "object") {
    return;
  }

  const sampleStart = state.start | 0;
  const sampleEnd = state.end | 0;
  const entries = state.entries;

  if (!(entries instanceof Uint32Array)) {
    state.count = 0;
    return;
  }

  const analysisWork = work && typeof work === "object" ? work : null;
  const magnitudes = reuseF32Array(analysisWork?.entryMagnitudes, AT5_ANALYSIS_MAX_ENTRIES);
  const phases = reuseI32Array(analysisWork?.entryPhases, AT5_ANALYSIS_MAX_ENTRIES);
  const frequencies = reuseI32Array(analysisWork?.entryFrequencies, AT5_ANALYSIS_MAX_ENTRIES);
  const entryCount = scanGeneralCandidatesAt5(
    src,
    sampleStart,
    sampleEnd,
    initIdx,
    weights,
    maxCount,
    flag,
    mode,
    param,
    entries,
    magnitudes,
    phases,
    frequencies,
    analysisWork
  );

  if ((flag | 0) === 0) {
    encodeFlag0EntriesAt5(entries, entryCount, magnitudes, phases, frequencies);
  }

  state.count = finalizeGeneralEntriesAt5(entries, entryCount, flag);
}
