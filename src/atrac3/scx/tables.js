/**
 * ATRAC3 SCX table lookups and scalar-index helpers.
 */
import { CodecError } from "../../common/errors.js";
import {
  AT3_IDWL_NSTEPS_TABLE,
  AT3_IDWL_WINDOW_LENGTH_BY_IDX,
  AT3_ID_TWIDDLE_OFFSET_TABLE,
  AT3_IDSCFOF_THRESHOLD,
  AT3_ID_SCALEFACTOR_TABLE,
  AT3_ID_TIME_DIVISOR_BY_IDX,
  AT3_ID_TIME_FACTOR_BY_ID,
  AT3_IQT_ISP_OFFSET_TABLE,
  AT3_IQT_NSPS_TABLE,
  AT3_SCFOF_OVERFLOW_SCALE,
  AT3_TFOF_ID_ZERO,
} from "../encode-tables.js";

export const AT3_NBITS_ERROR = -32768;

const AT3_IQT_FILTER_BAND_THRESHOLDS = [7, 11, 15, 19, 25];

function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new CodecError(`${name} must be an integer`);
  }
  return value;
}

function lookupTableValue(table, index, name) {
  assertInteger(index, name);
  return index >= 0 && index < table.length ? table[index] : -1;
}

function findScaleFactorIndex(value, nanIndex = 0) {
  if (Number.isNaN(value)) {
    return nanIndex;
  }

  let low = 0;
  let high = AT3_ID_SCALEFACTOR_TABLE.length - 1;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (AT3_ID_SCALEFACTOR_TABLE[mid] <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Maps a quant-band index to its first spectrum sample.
 */
export function spectrumOffsetForQuantBandAt3(quantBand) {
  return lookupTableValue(AT3_IQT_ISP_OFFSET_TABLE, quantBand, "quantBand");
}

/**
 * Returns the number of spectrum samples covered by a quant band.
 */
export function spectrumSampleCountForQuantBandAt3(quantBand) {
  return lookupTableValue(AT3_IQT_NSPS_TABLE, quantBand, "quantBand");
}

export function windowLengthForWordLengthIndexAt3(wordLengthIndex) {
  return lookupTableValue(AT3_IDWL_WINDOW_LENGTH_BY_IDX, wordLengthIndex, "wordLengthIndex");
}

export function quantStepCountForWordLengthIndexAt3(wordLengthIndex) {
  return lookupTableValue(AT3_IDWL_NSTEPS_TABLE, wordLengthIndex, "wordLengthIndex");
}

/**
 * Maps a twiddle selector to the tone span it covers in the spectrum.
 */
export function toneWidthForTwiddleIdAt3(twiddleId) {
  return lookupTableValue(AT3_ID_TWIDDLE_OFFSET_TABLE, twiddleId, "twiddleId");
}

export function scaleFactorValueForIndexAt3(scaleFactorIndex) {
  const idx = assertInteger(scaleFactorIndex, "scaleFactorIndex");
  if (idx >= 0 && idx <= 0x3f) {
    return AT3_ID_SCALEFACTOR_TABLE[idx];
  }

  const scale = AT3_SCFOF_OVERFLOW_SCALE[0];
  const last = AT3_ID_SCALEFACTOR_TABLE[0x3f];
  return scale * last;
}

/**
 * Threshold used when zeroing non-tone coefficients for a band profile and word length.
 */
export function zeroThresholdForWordLengthIndexAt3(profileId, wordLengthIndex) {
  assertInteger(profileId, "profileId");
  assertInteger(wordLengthIndex, "wordLengthIndex");
  if (profileId === 0) {
    return AT3_TFOF_ID_ZERO[0];
  }

  if (wordLengthIndex < 0 || wordLengthIndex >= AT3_ID_TIME_DIVISOR_BY_IDX.length) {
    return Number.NaN;
  }

  const clampedProfileId = Math.max(0, Math.min(12, profileId));
  return AT3_ID_TIME_FACTOR_BY_ID[clampedProfileId] / AT3_ID_TIME_DIVISOR_BY_IDX[wordLengthIndex];
}

export function filterBandForQuantBandAt3(quantBand) {
  const band = assertInteger(quantBand, "quantBand");
  const idx = AT3_IQT_FILTER_BAND_THRESHOLDS.findIndex((limit) => band <= limit);
  return idx === -1 ? AT3_IQT_FILTER_BAND_THRESHOLDS.length : idx;
}

export function scaleFactorIndexForAbsValueAt3(absValue) {
  return findScaleFactorIndex(absValue, AT3_ID_SCALEFACTOR_TABLE.length - 1);
}

export function scaleFactorIndexForValueAt3(value) {
  const threshold = AT3_IDSCFOF_THRESHOLD[0];
  const input = value < threshold ? -value : value;
  return findScaleFactorIndex(input);
}
