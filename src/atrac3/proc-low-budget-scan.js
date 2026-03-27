import { AT3_DBA_BAND_THRESHOLDS, AT3_SFB_OFFSETS, AT3_SFB_WIDTHS } from "./encode-tables.js";
import { AT3ENC_PROC_ACTIVE_BANDS_WORD, AT3ENC_PROC_BAND_COUNT } from "./proc-layout.js";
import { resolveNontoneQuantMode } from "./proc-quant-modes.js";
import {
  estimateGroupIdsf,
  groupIdsfEstimateFromMagKey,
  readSpectrumMaxKey,
} from "./proc-quant-scale.js";

const LOW_BUDGET_LEFT_DOMINANCE_MARGIN = 0xf00;
const LOW_BUDGET_RIGHT_DOMINANCE_MARGIN = 0x1400;
const MONO_BAND_LIMIT_WIDE_THRESHOLD = 0x10;
const MONO_BAND_LIMIT_NARROW_THRESHOLD = 8;
const MONO_BAND_LIMIT_WIDE_BAND_CUTOFF = 0x15;
const MONO_BAND_LIMIT_FULL_EXTENSION_BAND = 0x1a;
const MONO_BAND_LIMIT_FULL_EXTENSION = 0x1c;

export const LOW_BUDGET_BAND_HEADER_BITS = 3;
export const LOW_BUDGET_HIGH_BUDGET_TONE_COST = 0x20;
export const LOW_BUDGET_TIGHT_MODE_SHIFT = 11;
export const LOW_BUDGET_DEFAULT_MODE_SHIFT = 10;
export const LOW_BUDGET_TIGHT_MODE_SHIFT_BUDGET = 6;

/** Estimates one band's coarse planning cost from the current group IDSF trail. */
export function estimateBandBits(mode, idsfSel, band, groupIdsf) {
  const quantMode = resolveNontoneQuantMode(mode);
  const width = AT3_SFB_WIDTHS[band] | 0;
  let bits = width * quantMode.bitsPerSpec + 0x3c;
  const thresh = (idsfSel - (quantMode.step | 0)) | 0;
  const skip = quantMode.skipBits | 0;
  const groupStart = AT3_SFB_OFFSETS[band] >> 2;
  const groupEnd = AT3_SFB_OFFSETS[band + 1] >> 2;

  for (let group = groupStart; group < groupEnd; group += 1) {
    if ((groupIdsf[group] | 0) < thresh) {
      bits -= skip;
    }
  }

  return bits | 0;
}

/** Measures one band's peak and accumulated group IDSF values. */
export function measureLowBudgetBandIdsf(band, groupIdsf, spectrumU32 = null) {
  let bandPeak = 0;
  let bandTotal = 0;
  let bandOver7Count = 0;
  const groupStart = AT3_SFB_OFFSETS[band] >> 2;
  const groupEnd = AT3_SFB_OFFSETS[band + 1] >> 2;

  for (let group = groupStart; group < groupEnd; group += 1) {
    const idsf =
      spectrumU32 === null
        ? groupIdsf[group]
        : groupIdsfEstimateFromMagKey(readSpectrumMaxKey(spectrumU32, group * 4)) >>> 0;
    if (spectrumU32 !== null) {
      groupIdsf[group] = idsf;
    }

    bandTotal += idsf;
    if (bandPeak < idsf) {
      bandPeak = idsf;
    }
    bandOver7Count += idsf > 7 ? 1 : 0;
  }

  return { bandPeak, bandTotal, bandOver7Count };
}

function resolveMonoBandLimitThreshold(band) {
  const bandStart = AT3_SFB_OFFSETS[band];
  const startsInUpperHalfOf256Window = bandStart % 256 >= 128;
  return band <= MONO_BAND_LIMIT_WIDE_BAND_CUTOFF && startsInUpperHalfOf256Window
    ? MONO_BAND_LIMIT_WIDE_THRESHOLD
    : MONO_BAND_LIMIT_NARROW_THRESHOLD;
}

function resolveMonoBandLimitExtension(band) {
  return band > MONO_BAND_LIMIT_FULL_EXTENSION_BAND
    ? Math.min(band + 2, AT3ENC_PROC_BAND_COUNT)
    : MONO_BAND_LIMIT_FULL_EXTENSION;
}

/**
 * Performs the first coarse band scan for low-budget planning.
 *
 * The caller provides reusable scratch arrays so the later tone and payload
 * passes can keep mutating the same coarse state instead of rebuilding it.
 */
export function scanLowBudgetBandPeaks(
  layer,
  { bandLimit, bitBudget, usesIndependentCoding, groupIdsf, bandSum, bandSelectors }
) {
  estimateGroupIdsf(layer.spectrum, groupIdsf);

  let over7Total = 0;
  let over7TotalWithinLimit = 0;
  let sumTotal = 0;
  let strongestBandPeak = 0;

  for (let band = 0; band < AT3ENC_PROC_BAND_COUNT; band += 1) {
    let { bandPeak, bandTotal, bandOver7Count } = measureLowBudgetBandIdsf(band, groupIdsf);
    over7Total += bandOver7Count;

    if (bandPeak > strongestBandPeak) {
      strongestBandPeak = bandPeak;
      if (usesIndependentCoding && bitBudget > over7Total * resolveMonoBandLimitThreshold(band)) {
        bandLimit = Math.max(bandLimit, resolveMonoBandLimitExtension(band));
      }
    } else if (bandPeak < 3 || bandTotal < AT3_DBA_BAND_THRESHOLDS[band]) {
      bandPeak = 0;
      bandTotal = 0;
    }

    if (band + 1 === bandLimit) {
      over7TotalWithinLimit = over7Total;
    }

    sumTotal += bandTotal;
    bandSum[band] = bandTotal;
    bandSelectors[band] = bandPeak;
  }

  return {
    bandLimit,
    sumTotal,
    over7TotalWithinLimit,
  };
}

/**
 * Drops dominated coarse bands, reclaims trailing band headers, and measures
 * the surviving low-budget layout before the concrete payload fitter runs.
 */
export function pruneAndMeasureLowBudgetBands(
  procWords,
  bandModes,
  bandSelectors,
  bandMetrics,
  groupIdsf,
  bandLimit,
  availableBits
) {
  const candidateLastBand = bandLimit - 1;
  let estimatedBits = 0;
  let activeWidth = 0;
  let mode7Width = 0;

  for (let band = 0; band < bandLimit; band += 1) {
    const mode = bandModes[band];
    if (mode === 0) {
      continue;
    }

    const bandMetric = bandMetrics[band + 1];
    const leftBandDominates =
      band >= 2 && bandMetrics[band] > bandMetric + LOW_BUDGET_LEFT_DOMINANCE_MARGIN;
    const rightBandDominates =
      band < candidateLastBand &&
      bandMetrics[band + 2] > bandMetric + LOW_BUDGET_RIGHT_DOMINANCE_MARGIN;
    if (leftBandDominates || rightBandDominates) {
      bandModes[band] = 0;
      continue;
    }

    const bandWidth = AT3_SFB_WIDTHS[band];
    activeWidth += bandWidth;
    if (mode === 7) {
      mode7Width += bandWidth;
    }
    estimatedBits += estimateBandBits(mode, bandSelectors[band], band, groupIdsf);
  }

  let activeBands = bandLimit;
  while (activeBands > 1 && bandModes[activeBands - 1] === 0) {
    availableBits += LOW_BUDGET_BAND_HEADER_BITS;
    activeBands -= 1;
  }
  procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = activeBands;

  return {
    estimatedBits,
    activeWidth,
    mode7Width,
    activeBands,
    availableBits,
  };
}
