import { AT5_SFTBL } from "../tables/decode.js";
import { AT5_ISPS, AT5_NSPS } from "../tables/unpack.js";
import { AT5_BANDS_MAX } from "./constants.js";

const AT5_BASE_MAX_QUANT_MODE_STEREO_CUTOFFS = [4, 5, 11, 15, 19];
const AT5_BASE_MAX_QUANT_MODE_MULTI_CUTOFFS = [4, 5, 7, 13, 15];
const AT5_IDSF_SCALE = 0.891265869140625;
const AT5_IDSF_THRESHOLD = 0.02785205841064453;

function at5BaseMaxQuantModeFromCutoffs(mode, cutoffs) {
  let baseMaxQuantMode = 2;
  for (const cutoff of cutoffs) {
    if (mode < cutoff) {
      return baseMaxQuantMode;
    }
    baseMaxQuantMode += 1;
  }
  return 7;
}

/**
 * Maps the ATRAC3plus core mode to the baseline quant-mode ceiling used during
 * the initial bitalloc bootstrap before per-band boosts are applied.
 */
export function at5BaseMaxQuantModeForCoreMode(coreMode, channelCount, isMode4Block) {
  const mode = coreMode | 0;
  if ((channelCount | 0) === 2) {
    return at5BaseMaxQuantModeFromCutoffs(mode, AT5_BASE_MAX_QUANT_MODE_STEREO_CUTOFFS);
  }
  if ((isMode4Block | 0) !== 0) {
    return 7;
  }
  return at5BaseMaxQuantModeFromCutoffs(mode, AT5_BASE_MAX_QUANT_MODE_MULTI_CUTOFFS);
}

function gainRecordHasLargeLevelRange(record) {
  const count = Math.max(0, Math.min(record?.entries | 0, 7));
  let minv = 6;
  let maxv = 6;
  for (let i = 0; i < count; i += 1) {
    const value = record?.levels?.[i] ?? 6;
    if (value > maxv) {
      maxv = value;
    }
    if (value < minv) {
      minv = value;
    }
  }
  return maxv - minv > 3;
}

export function computeGainRecordRangeFlag(currentBuffer, previousBuffer) {
  const currentRecords = currentBuffer?.records;
  const previousRecords = previousBuffer?.records;
  if (
    gainRecordHasLargeLevelRange(currentRecords?.[0]) ||
    gainRecordHasLargeLevelRange(currentRecords?.[1])
  ) {
    return 0;
  }
  if (
    gainRecordHasLargeLevelRange(previousRecords?.[0]) ||
    gainRecordHasLargeLevelRange(previousRecords?.[1])
  ) {
    return 1;
  }
  return -1;
}

function withActiveGainRecords(channel, compare) {
  const records = channel?.gain?.records;
  const baseRecords = channel?.block0?.gain?.records;
  if (!records || !baseRecords) {
    return 0;
  }

  const count = channel.gain.activeCount >>> 0;
  for (let i = 0; i < count; i += 1) {
    if (!compare(records[i], baseRecords[i])) {
      return 0;
    }
  }
  return 1;
}

function gainCountsEqual(record, baseRecord) {
  return ((record?.entries ?? 0) | 0) === ((baseRecord?.entries ?? 0) | 0);
}

export function gainLevelsEqual(record, baseRecord) {
  const entries = record?.entries >>> 0;
  const baseEntries = baseRecord?.entries >>> 0;
  const levels = record?.levels;
  const baseLevels = baseRecord?.levels ?? levels;

  for (let i = 0; i < entries; i += 1) {
    const expected = i < baseEntries ? (baseLevels?.[i] ?? 7) : 7;
    if ((levels?.[i] ?? 0) >>> 0 !== expected >>> 0) {
      return false;
    }
  }

  return true;
}

export function gainLocationPrefixEqual(record, baseRecord) {
  const entries = record?.entries >>> 0;
  if (entries === 0) {
    return true;
  }

  const baseEntries = baseRecord?.entries >>> 0;
  const locations = record.locations;
  const baseLocations = baseRecord?.locations ?? locations;
  const prefix = Math.min(entries, baseEntries);
  for (let i = 0; i < prefix; i += 1) {
    if (locations[i] >>> 0 !== baseLocations[i] >>> 0) {
      return false;
    }
  }

  return true;
}

export function at5GainCountsEqualToBase(channel) {
  return withActiveGainRecords(channel, gainCountsEqual);
}

export function at5GainIdlevLevelsEqualToBase(channel) {
  return withActiveGainRecords(channel, gainLevelsEqual);
}

export function at5GainIdlocPrefixEqualToBase(channel) {
  return withActiveGainRecords(channel, gainLocationPrefixEqual);
}

export function countNonEmptyGainRecords(buffer, recordCount) {
  const records = buffer?.records;
  let effective = recordCount | 0;
  for (let i = (recordCount | 0) - 1; i >= 0; i -= 1) {
    if ((records?.[i]?.entries | 0) !== 0) {
      break;
    }
    effective = i;
  }
  return effective | 0;
}

export function countPackedGainRecords(buffer, activeCount) {
  const records = buffer?.records;
  let packedCount = activeCount | 0;

  for (let i = (activeCount | 0) - 1; i > 0; i -= 1) {
    const current = records?.[i];
    const previous = records?.[i - 1];
    const entryCount = current?.entries | 0;
    if (entryCount !== (previous?.entries | 0)) {
      break;
    }

    let matchesPrevious = true;
    for (let j = 0; j < entryCount; j += 1) {
      if (
        (current?.locations?.[j] | 0) !== (previous?.locations?.[j] | 0) ||
        (current?.levels?.[j] | 0) !== (previous?.levels?.[j] | 0)
      ) {
        matchesPrevious = false;
        break;
      }
    }
    if (!matchesPrevious) {
      break;
    }
    packedCount = i | 0;
  }

  return packedCount | 0;
}

function maxAbsInBandSpectrum(quantizedSpectrum, start, count) {
  let maxv = 0;
  for (let i = 0; i < (count | 0); i += 1) {
    const value = Math.abs(quantizedSpectrum[start + i]);
    if (value > maxv) {
      maxv = value;
    }
  }
  return maxv;
}

/**
 * Derives per-band scale-factor indices and peak magnitudes from one
 * quantized spectrum buffer so the early bitalloc passes can seed both band
 * energy and band scaling.
 */
export function deriveScalefactorsFromSpectrumAt5(
  quantizedSpectrum,
  scaleFactorIndicesOut,
  bandPeaksOut,
  count
) {
  const nBands = Math.max(0, Math.min(count | 0, AT5_BANDS_MAX));
  for (let band = 0; band < nBands; band += 1) {
    const start = AT5_ISPS[band] >>> 0;
    const nsps = AT5_NSPS[band] >>> 0;
    const maxAbs = maxAbsInBandSpectrum(quantizedSpectrum, start, nsps);
    bandPeaksOut[band] = maxAbs;

    const target = maxAbs * AT5_IDSF_SCALE;
    if (target < AT5_IDSF_THRESHOLD) {
      scaleFactorIndicesOut[band] = 0;
      continue;
    }

    let low = 1;
    let high = 0x3f;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((AT5_SFTBL[mid] ?? 0) > target) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    scaleFactorIndicesOut[band] = low | 0;
  }

  scaleFactorIndicesOut.fill(0, nBands);
  bandPeaksOut.fill(0, nBands);
}

/**
 * Normalizes each active band in place by its chosen IDSF scale so later
 * HCSPEC and budget passes operate on the same per-band coefficient range.
 */
export function normalizeSpectrumAt5(quantizedSpectrum, idsfValues, count) {
  const nBands = count | 0;
  for (let band = 0; band < nBands; band += 1) {
    const scale = Math.fround(1.0 / (AT5_SFTBL[idsfValues[band] >>> 0] ?? 1)); // Required rounding
    const start = AT5_ISPS[band] >>> 0;
    const end = AT5_ISPS[band + 1] >>> 0;
    for (let i = start; i < end; i += 1) {
      quantizedSpectrum[i] = quantizedSpectrum[i] * scale;
    }
  }
}
