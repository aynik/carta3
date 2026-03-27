import { dftVAt5 } from "../dft.js";

import { getGaincBandHistory } from "./history.js";
import { fmaF32 } from "./fp.js";

export * from "./point-layout.js";
export { getGaincBandHistory, sharedAuxU32View } from "./history.js";

function absI32(v) {
  return v < 0 ? -v : v;
}

const AT5_GAINC_DFT_INPUT_COUNT = 0x10;
const AT5_GAINC_DFT_OUTPUT_COUNT = 9;

const GA_INC_HALF_HANNWIN = new Float32Array([
  0.009607359766960144, 0.08426519483327866, 0.22221487760543823, 0.40245485305786133,
  0.5975451469421387, 0.7777851223945618, 0.9157348275184631, 0.9903926253318787,
]);

const GA_INC_EPS = 9.99999993922529e-9;
const GA_INC_INV7 = 0.1428571492433548;
const GA_INC_SCALE = 0.1803368777036667;
const GA_INC_DFT_INPUT = new Float32Array(AT5_GAINC_DFT_INPUT_COUNT);
const GA_INC_DFT_OUTPUT = new Float32Array(AT5_GAINC_DFT_OUTPUT_COUNT);
const GA_INC_DFT_SCRATCH = new Float32Array(0x100);
const GAINC_STEREO_RATIO_LOW = 0.5;
const GAINC_STEREO_RATIO_HIGH = 2.0;
const GAINC_STEREO_SOURCE_AUX_OFFSET = 0xf1;

function gaincMaxAbs4(src, start) {
  let maxv = Math.abs(src[start + 0]);
  for (let i = 1; i < AT5_GAINC_WINDOW_F32_PER_BLOCK; i += 1) {
    const v = Math.abs(src[start + i]);
    if (v > maxv) {
      maxv = v;
    }
  }
  return maxv;
}

function gaincWindowHasActivity(analysis, offset) {
  return (
    analysis[offset + 0] !== 0 ||
    analysis[offset + 1] !== 0 ||
    analysis[offset + 2] !== 0 ||
    analysis[offset + 3] !== 0
  );
}

function gaincComputeScaleFactor(timewin16) {
  const dftIn = GA_INC_DFT_INPUT;
  for (let i = 0; i < 8; i += 1) {
    const w = GA_INC_HALF_HANNWIN[i];
    dftIn[i] = timewin16[i] * w;
    dftIn[15 - i] = timewin16[15 - i] * w;
  }

  const dftOut = GA_INC_DFT_OUTPUT;
  dftVAt5(dftIn, 1, AT5_GAINC_DFT_INPUT_COUNT, dftOut, 0, GA_INC_DFT_SCRATCH);

  let sumLogs = 0.0;
  const sq7 = dftOut[7] * dftOut[7];
  let sumSq = fmaF32(dftOut[0], dftOut[0], sq7);
  for (let i = 1; i < 7; i += 1) {
    const logArg = dftOut[i] + GA_INC_EPS;
    sumLogs = sumLogs + Math.log(logArg);
    sumSq = fmaF32(dftOut[i], dftOut[i], sumSq);
  }

  const rootLd = Math.sqrt(sumSq);
  let logRoot = 0.0;
  if (!Number.isNaN(rootLd)) {
    logRoot = Math.log(rootLd + GA_INC_EPS);
  } else {
    const rootF = Math.sqrt(sumSq);
    logRoot = Math.log(rootF + GA_INC_EPS);
  }

  const log0 = Math.log(dftOut[0] + GA_INC_EPS);
  const log7 = Math.log(dftOut[7] + GA_INC_EPS);

  const t0 = log7 + sumLogs;
  const num0 = fmaF32(-t0, GA_INC_INV7, logRoot);
  const den0 = logRoot - log0 + GA_INC_EPS;
  const term0 = num0 / den0 + GA_INC_EPS;

  const sumSb = sumLogs + log0;
  const num1 = fmaF32(-sumSb, GA_INC_INV7, logRoot);
  const den1 = logRoot - log7 + GA_INC_EPS;
  const term1 = num1 / den1 + GA_INC_EPS;

  const logTerm0 = Math.log(term0);
  const logTerm1 = Math.log(term1);

  const cand0 = logTerm0 * GA_INC_SCALE + 1.0;
  const cand1 = logTerm1 * GA_INC_SCALE + 1.0;

  let chosen = cand0;
  if (cand1 > chosen) {
    chosen = cand1;
  }

  if (!(chosen > 1.0)) {
    return 1.0;
  }
  return chosen;
}

function prepareGaincScaleWindowsAt5({
  analysis,
  newAbs,
  scaleFactors,
  windowBlocks,
  analysisAbsOffsetF32,
  analysisTimewinOffsetF32,
  windowF32PerBlock,
}) {
  let maxAbsIdx = 0;
  let maxAbsVal = 0.0;
  const absBase = analysisAbsOffsetF32 | 0;
  const blockCount = windowBlocks | 0;
  const windowStride = windowF32PerBlock | 0;

  for (let i = 0; i < blockCount; i += 1) {
    const v = gaincMaxAbs4(analysis, absBase + i * windowStride);
    newAbs[i] = v;
    if (v > maxAbsVal) {
      maxAbsVal = v;
      maxAbsIdx = i;
    }
  }

  scaleFactors.fill(0);
  const timewinBase = analysisTimewinOffsetF32 | 0;
  // Keep the extracted mixed-domain gate: the rolling history comes from the
  // time-domain windows while the current slot advances from the abs window.
  let oldestRecentActivity = gaincWindowHasActivity(analysis, timewinBase);
  let middleRecentActivity = gaincWindowHasActivity(analysis, timewinBase + windowStride);
  let newestRecentActivity = gaincWindowHasActivity(analysis, timewinBase + windowStride * 2);

  for (let i = 0; i < blockCount; i += 1) {
    const currentAbsActivity = gaincWindowHasActivity(analysis, absBase + i * windowStride);
    scaleFactors[i + 1] =
      oldestRecentActivity || middleRecentActivity || newestRecentActivity || currentAbsActivity
        ? gaincComputeScaleFactor(
            analysis.subarray(timewinBase + i * windowStride, timewinBase + i * windowStride + 16)
          )
        : 1.0;

    oldestRecentActivity = middleRecentActivity;
    middleRecentActivity = newestRecentActivity;
    newestRecentActivity = currentAbsActivity;
  }

  return {
    maxAbsIdx: maxAbsIdx | 0,
    maxAbsVal,
  };
}

function sumSpectrumEnergy(spec, spectrumOffset, spectrumCount) {
  let sum = 0.0;
  for (let i = 0; i < (spectrumCount | 0); i += 4) {
    const base = spectrumOffset + i;
    const a = spec[base + 0];
    const b = spec[base + 1];
    const c = spec[base + 2];
    const d = spec[base + 3];
    sum = sum + a * a + b * b + c * c + d * d;
  }
  return sum;
}

function gaincStereoRatioOutOfMirrorRange(value) {
  return value > GAINC_STEREO_RATIO_HIGH || value < GAINC_STEREO_RATIO_LOW;
}

function gaincStereoSourceChannel(auxU32, band) {
  return auxU32 !== null && auxU32[GAINC_STEREO_SOURCE_AUX_OFFSET + band] >>> 0 === 1 ? 1 : 0;
}

function copyGainRecordShape(dst, src) {
  dst.entries = src.entries >>> 0;
  dst.locations.set(src.locations);
  dst.levels.set(src.levels);
}

function copyGainLevelBounds(dstHistory, srcHistory) {
  dstHistory.gainLevelBounds[0] = srcHistory.gainLevelBounds[0];
  dstHistory.gainLevelBounds[1] = srcHistory.gainLevelBounds[1];
}

function mirrorStereoBandState(curBufs, band, auxU32, leftHistory, rightHistory) {
  const leftRecord = curBufs[0]?.records?.[band] ?? null;
  const rightRecord = curBufs[1]?.records?.[band] ?? null;
  if (!(leftRecord && rightRecord)) {
    return;
  }

  if (gaincStereoSourceChannel(auxU32, band) === 1) {
    copyGainRecordShape(leftRecord, rightRecord);
    copyGainLevelBounds(leftHistory, rightHistory);
    return;
  }

  copyGainRecordShape(rightRecord, leftRecord);
  copyGainLevelBounds(rightHistory, leftHistory);
}

function applyStereoCorrelationAdjustmentAt5({
  band,
  channels,
  corrStartBand,
  channelBlocks,
  analysisPtrs,
  curBufs,
  auxU32,
  spectrumCount,
  analysisFreqOffsetF32,
  bandsMax,
}) {
  if ((channels | 0) !== 2 || (band | 0) < (corrStartBand | 0)) {
    return;
  }

  const leftBlock = channelBlocks[0] ?? null;
  const rightBlock = channelBlocks[1] ?? null;
  if (!(leftBlock && rightBlock)) {
    return;
  }

  const leftHistory = getGaincBandHistory(leftBlock, band);
  const rightHistory = getGaincBandHistory(rightBlock, band);
  if (!(leftHistory && rightHistory)) {
    return;
  }

  const leftSpectrum = analysisPtrs[band] ?? null;
  const rightSpectrum = analysisPtrs[(bandsMax | 0) + band] ?? null;
  if (!(leftSpectrum instanceof Float32Array) || !(rightSpectrum instanceof Float32Array)) {
    return;
  }
  const spectrumOffset = analysisFreqOffsetF32 | 0;
  const leftEnergy = sumSpectrumEnergy(leftSpectrum, spectrumOffset, spectrumCount);
  const rightEnergy = sumSpectrumEnergy(rightSpectrum, spectrumOffset, spectrumCount);

  const denom = leftHistory.stereoBandEnergy * rightEnergy;
  let ratio = -1.0;
  if (denom !== 0) {
    ratio = (rightHistory.stereoBandEnergy * leftEnergy) / denom;

    if (
      !gaincStereoRatioOutOfMirrorRange(leftHistory.stereoBandEnergyRatio) &&
      !gaincStereoRatioOutOfMirrorRange(ratio)
    ) {
      mirrorStereoBandState(curBufs, band, auxU32, leftHistory, rightHistory);
    }
  }

  leftHistory.stereoBandEnergyRatio = ratio;
  leftHistory.stereoBandEnergy = leftEnergy;
  rightHistory.stereoBandEnergy = rightEnergy;
}

const AT5_GAINC_BANDS_MAX = 0x10;
const AT5_GAINC_SPECTRUM_F32_COUNT = 0x80;
const AT5_GAINC_WINDOW_BLOCKS = 0x20;
const AT5_GAINC_WINDOW_F32_PER_BLOCK = 4;

const AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32 = 0x400 / 4;
const AT5_GAINC_ANALYSIS_TIMEWIN_OFFSET_F32 = 0x7d0 / 4;
const AT5_GAINC_ANALYSIS_ABS_OFFSET_F32 = 0x800 / 4;

export {
  absI32,
  applyStereoCorrelationAdjustmentAt5,
  prepareGaincScaleWindowsAt5,
  AT5_GAINC_BANDS_MAX,
  AT5_GAINC_SPECTRUM_F32_COUNT,
  AT5_GAINC_WINDOW_BLOCKS,
  AT5_GAINC_WINDOW_F32_PER_BLOCK,
  AT5_GAINC_ANALYSIS_FREQ_OFFSET_F32,
  AT5_GAINC_ANALYSIS_TIMEWIN_OFFSET_F32,
  AT5_GAINC_ANALYSIS_ABS_OFFSET_F32,
};
