import { addSeqAt5, subSeqAt5, synthesisWavAt5 } from "../dsp.js";
import { AT5_WIN } from "../tables/decode.js";

import { analysisCtxForSlotConst } from "./ctx.js";

const AT5_GHWAVE_BAND_STRIDE = 16;
const AT5_GHWAVE_HALF_SAMPLES = 128;
const AT5_GHWAVE_MAX_CHANNELS = 2;
const AT5_GHWAVE_MAX_BANDS = 16;

function clampGhwaveChannelCount(channelCount) {
  return Math.min(Math.max(channelCount | 0, 0), AT5_GHWAVE_MAX_CHANNELS);
}

function clampGhwaveBandCount(bandCount) {
  return Math.min(Math.max(bandCount | 0, 0), AT5_GHWAVE_MAX_BANDS);
}

function ensureResidualBuffer(buffer) {
  return buffer instanceof Float32Array && buffer.length >= AT5_GHWAVE_HALF_SAMPLES
    ? buffer
    : new Float32Array(AT5_GHWAVE_HALF_SAMPLES);
}

function shouldSkipResidualBand(previousAnalysis, currentAnalysis, requirePrevEntries) {
  const previousCount = previousAnalysis?.count | 0;
  const currentCount = currentAnalysis?.count | 0;

  if (requirePrevEntries) {
    return previousCount <= 0;
  }
  return previousCount <= 0 && currentCount <= 0;
}

function analysesOverlap(previousAnalysis, currentAnalysis) {
  if ((currentAnalysis?.count | 0) <= 0) {
    return false;
  }

  const previousEnd = previousAnalysis?.end | 0;
  const currentStart = currentAnalysis?.start | 0;
  return ((previousEnd - AT5_GHWAVE_HALF_SAMPLES) | 0) >= currentStart;
}

function applyLeadingOverlapWindow(buffer) {
  for (let sampleIndex = 0; sampleIndex < AT5_GHWAVE_HALF_SAMPLES; sampleIndex += 1) {
    buffer[sampleIndex] *= AT5_WIN[sampleIndex] ?? 0;
  }
}

function applyTrailingOverlapWindow(buffer) {
  const offset = AT5_GHWAVE_HALF_SAMPLES;
  for (let sampleIndex = 0; sampleIndex < AT5_GHWAVE_HALF_SAMPLES; sampleIndex += 1) {
    buffer[sampleIndex] *= AT5_WIN[offset + sampleIndex] ?? 0;
  }
}

function applyResidualOverlapWindows(
  previousAnalysis,
  currentAnalysis,
  previousBuffer,
  currentBuffer
) {
  const previousCount = previousAnalysis?.count | 0;
  const currentCount = currentAnalysis?.count | 0;

  if (previousCount <= 0) {
    if (currentCount > 0 && ((currentAnalysis?.hasStart ?? 0) | 0) === 0) {
      applyLeadingOverlapWindow(currentBuffer);
    }
    return;
  }

  if (!analysesOverlap(previousAnalysis, currentAnalysis)) {
    if (previousCount > 0 && ((previousAnalysis?.hasEnd ?? 0) | 0) === 0) {
      applyTrailingOverlapWindow(previousBuffer);
    }
    if (currentCount > 0 && ((currentAnalysis?.hasStart ?? 0) | 0) === 0) {
      applyLeadingOverlapWindow(currentBuffer);
    }
    return;
  }

  applyTrailingOverlapWindow(previousBuffer);
  applyLeadingOverlapWindow(currentBuffer);
}

function renderResidualHalf(analysis, buffer, offset, mode, mixFlag, channelIndex) {
  if (!analysis) {
    return;
  }

  synthesisWavAt5(
    {
      hasLeftFade: analysis.hasStart | 0,
      hasRightFade: analysis.hasEnd | 0,
      leftIndex: analysis.start | 0,
      rightIndex: analysis.end | 0,
      entryCount: analysis.count | 0,
      entries: analysis.entries instanceof Uint32Array ? analysis.entries : null,
    },
    buffer,
    offset,
    AT5_GHWAVE_HALF_SAMPLES,
    mode,
    mixFlag,
    channelIndex
  );
}

function mixFlagForBand(globalState, band) {
  return globalState?.mixFlags?.[band] ?? 0;
}

function subtractResidualFromBandSpectrum(analysisPtrs, spectrumIndex, residualSum) {
  const spectrum = analysisPtrs?.[spectrumIndex] ?? null;
  if (!(spectrum instanceof Float32Array)) {
    return;
  }

  subSeqAt5(spectrum, residualSum, spectrum, AT5_GHWAVE_HALF_SAMPLES);
}

export function at5GhwaveApplySynthesisResidual(options) {
  const {
    analysisPtrs,
    analysisBase,
    channelCount,
    bandCount,
    p20Slots,
    p24Slots,
    baseGlobal,
    global,
    baseFlag,
    curFlag,
    requirePrevEntries = false,
    tmpPrev = null,
    tmpCur = null,
    tmpSum = null,
  } = options ?? {};
  if (
    !Array.isArray(analysisPtrs) ||
    !Array.isArray(p20Slots) ||
    !Array.isArray(p24Slots) ||
    !global
  ) {
    return;
  }

  const base = analysisBase | 0;
  const channels = clampGhwaveChannelCount(channelCount);
  const bands = clampGhwaveBandCount(bandCount);
  const previousBuffer = ensureResidualBuffer(tmpPrev);
  const currentBuffer = ensureResidualBuffer(tmpCur);
  const residualSum = ensureResidualBuffer(tmpSum);

  for (let band = 0; band < bands; band += 1) {
    const previousMixFlag = mixFlagForBand(baseGlobal, band);
    const currentMixFlag = mixFlagForBand(global, band);

    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const previousAnalysis = analysisCtxForSlotConst(p20Slots[channelIndex], band);
      const currentAnalysis = analysisCtxForSlotConst(p24Slots[channelIndex], band);

      if (shouldSkipResidualBand(previousAnalysis, currentAnalysis, requirePrevEntries)) {
        continue;
      }

      renderResidualHalf(
        previousAnalysis,
        previousBuffer,
        AT5_GHWAVE_HALF_SAMPLES,
        baseFlag,
        previousMixFlag,
        channelIndex
      );
      renderResidualHalf(currentAnalysis, currentBuffer, 0, curFlag, currentMixFlag, channelIndex);

      applyResidualOverlapWindows(previousAnalysis, currentAnalysis, previousBuffer, currentBuffer);
      addSeqAt5(previousBuffer, currentBuffer, residualSum, AT5_GHWAVE_HALF_SAMPLES);

      subtractResidualFromBandSpectrum(
        analysisPtrs,
        base + channelIndex * AT5_GHWAVE_BAND_STRIDE + band,
        residualSum
      );
    }
  }
}
