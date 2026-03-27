import {
  AT5_SF_ADJUST_BAND_START_BY_MODE,
  AT5_SF_ADJ_K_HI_0,
  AT5_SF_ADJ_K_HI_1,
  AT5_SF_ADJ_K_LO_0,
  AT5_SF_ADJ_K_LO_1,
} from "../tables/encode-init.js";
import {
  AT5_SBA_OFFSET_WEIGHT_DEFAULT,
  AT5_SBA_OFFSET_WEIGHT_HI_MODE,
  AT5_SBA_OFFSET_WEIGHT_POS,
  AT5_SECOND_BIT_OFFSET_INIT,
  AT5_SECOND_BIT_OFFSET_MAX,
  AT5_SECOND_BIT_OFFSET_MIN,
  AT5_SECOND_BIT_STEP,
  AT5_SECOND_BIT_STEP_HALF,
  AT5_ZBA_WCFX_TABLE_A,
  AT5_ZBA_WCFX_TABLE_B,
  AT5_ZBA_WCFX_TABLE_C,
  AT5_ZBA_WCFX_TABLE_D,
} from "../tables/encode-bitalloc.js";
import { at5RoundHalfUp } from "./primitives.js";
import { runtimeCurrentBuffer, runtimePreviousBuffer } from "./runtime.js";

const AT5_DIRECT_BITALLOC_FLAG_MASK = 0x7c;

function sumAbsRange(spec, start, end) {
  let sum = 0;
  for (let i = start | 0; i < (end | 0); i += 1) {
    sum += Math.abs(spec[i]);
  }
  return sum;
}

function gainRecordHasWideLevels(record) {
  const count = Math.max(0, Math.min(record?.entries | 0, 7));
  for (let i = 0; i < count; i += 1) {
    const level = record?.levels?.[i] ?? 6;
    if (level < 5 || level > 7) {
      return true;
    }
  }
  return false;
}

function gainBufferHasWideLevels(buffer) {
  return (
    gainRecordHasWideLevels(buffer?.records?.[0]) || gainRecordHasWideLevels(buffer?.records?.[1])
  );
}

export function gainRecordRangeFlag(runtimeChannel) {
  return gainBufferHasWideLevels(runtimeCurrentBuffer(runtimeChannel)) ||
    gainBufferHasWideLevels(runtimePreviousBuffer(runtimeChannel))
    ? 1
    : 0;
}

export function firstGainRecordHasWideLevels(runtimeChannel) {
  return gainRecordHasWideLevels(runtimeCurrentBuffer(runtimeChannel)?.records?.[0]);
}

export function computeBitallocMode(spec, gainRangeFlag) {
  const low16Energy = sumAbsRange(spec, 0, 0x10);
  const midBandAverage = sumAbsRange(spec, 0x10, 0x80) / 112;
  const highBandAverage = sumAbsRange(spec, 0x80, 0x100) * 0.0078125;
  const lowVsMid = midBandAverage > 0 ? (low16Energy * 0.0625) / midBandAverage : 1;
  const lowVsHigh = highBandAverage > 0 ? (low16Energy * 0.0625) / highBandAverage : 1;

  let mode = lowVsMid > 4 ? 2 : 1;
  if ((gainRangeFlag | 0) === 0) {
    mode += 1;
  }
  if (lowVsHigh > 8) {
    mode += 2;
  } else if (lowVsHigh > 4) {
    mode += 1;
  }
  if (mode < 2 && lowVsHigh > 1) {
    mode = 2;
  }

  return mode | 0;
}

export function equalizedStereoBitallocMode(leftMode, rightMode) {
  return Math.abs((leftMode | 0) - (rightMode | 0)) === 1
    ? Math.max(leftMode | 0, rightMode | 0)
    : null;
}

export function computeBandScale(maxAbs, spec, start, count) {
  if (!(maxAbs > 0) || (count | 0) <= 0) {
    return 1;
  }

  const sum = sumAbsRange(spec, start, start + count);
  return sum > 0 ? ((count | 0) * maxAbs) / sum : 1;
}

export function sfAdjustConfigForCoreMode(coreMode, channelCount) {
  const mode = coreMode | 0;
  const channels = channelCount | 0;
  const useWideAdjust = (channels === 2 && mode <= 0x17) || (channels === 1 && mode === 0x09);

  return {
    startBand: (AT5_SF_ADJUST_BAND_START_BY_MODE[mode] ?? 0) | 0,
    kHi: useWideAdjust ? AT5_SF_ADJ_K_HI_1 : AT5_SF_ADJ_K_HI_0,
    kLo: useWideAdjust ? AT5_SF_ADJ_K_LO_1 : AT5_SF_ADJ_K_LO_0,
    stepLimit: useWideAdjust ? 10 : 5,
  };
}

export function hasAllGainRecordsInPrefix(runtimeChannel, count) {
  const records = runtimeCurrentBuffer(runtimeChannel)?.records ?? null;
  const limit = Math.max(0, Math.min(count | 0, 8));
  for (let i = 0; i < limit; i += 1) {
    if ((records?.[i]?.entries | 0) === 0) {
      return false;
    }
  }
  return true;
}

export function allowsExtraBitallocBoost(coreMode, channelCount) {
  return (
    ((channelCount | 0) === 2 && (coreMode | 0) >= 0x0b && (coreMode | 0) <= 0x13) ||
    ((channelCount | 0) === 1 && (coreMode | 0) === 9)
  );
}

export function selectWcfxTable(coreMode, channelCount) {
  const mode = coreMode | 0;
  if ((channelCount | 0) === 2) {
    if (mode < 0x13) return AT5_ZBA_WCFX_TABLE_A;
    if (mode < 0x17) return AT5_ZBA_WCFX_TABLE_B;
    if (mode < 0x19) return AT5_ZBA_WCFX_TABLE_C;
    return AT5_ZBA_WCFX_TABLE_D;
  }

  if (mode < 0x0d) return AT5_ZBA_WCFX_TABLE_A;
  if (mode < 0x13) return AT5_ZBA_WCFX_TABLE_B;
  if (mode < 0x17) return AT5_ZBA_WCFX_TABLE_C;
  return AT5_ZBA_WCFX_TABLE_D;
}

function remap48kBitallocBand(sampleRate, band) {
  return sampleRate === 48000 && band >= 0x12 && band < 0x1f ? band + 1 : band;
}

export function usesDirectBitallocScaling(encodeFlags) {
  return (encodeFlags & AT5_DIRECT_BITALLOC_FLAG_MASK) !== 0;
}

export function selectNegativeBitallocOffsetWeights(channelCount, coreMode) {
  return ((channelCount | 0) === 1 && (coreMode | 0) > 0x16) ||
    ((channelCount | 0) === 2 && (coreMode | 0) > 0x1a)
    ? AT5_SBA_OFFSET_WEIGHT_HI_MODE
    : AT5_SBA_OFFSET_WEIGHT_DEFAULT;
}

export function createBitallocOffsetState(channelCount, sampleRate, encodeFlags, coreMode) {
  return {
    channelCount,
    sampleRate,
    encodeFlags,
    posWeights: AT5_SBA_OFFSET_WEIGHT_POS,
    negWeights: selectNegativeBitallocOffsetWeights(channelCount, coreMode),
  };
}

export function clampBitallocOffset(offset) {
  return Math.max(AT5_SECOND_BIT_OFFSET_MIN, Math.min(offset, AT5_SECOND_BIT_OFFSET_MAX));
}

export function searchBitallocOffset(
  bitLimit,
  minimumAcceptedBits,
  startsAboveBudget,
  maxIterations,
  measureBitsAtOffset
) {
  const bitBudget = bitLimit | 0;
  const acceptedBitFloor = Number(minimumAcceptedBits);
  let stepSize = AT5_SECOND_BIT_STEP;
  let offset = startsAboveBudget ? AT5_SECOND_BIT_OFFSET_INIT : AT5_SECOND_BIT_STEP;
  let previousDirection = startsAboveBudget ? -1 : 1;

  for (let iteration = 0; iteration < (maxIterations | 0); iteration += 1) {
    const totalBits = measureBitsAtOffset(offset, iteration);
    const hitLowerBound = offset <= AT5_SECOND_BIT_OFFSET_MIN;
    const withinAcceptedWindow =
      totalBits <= bitBudget &&
      (totalBits > acceptedBitFloor || offset >= AT5_SECOND_BIT_OFFSET_MAX);
    if (hitLowerBound || withinAcceptedWindow) {
      return clampBitallocOffset(offset);
    }

    const direction = totalBits < bitBudget ? 1 : -1;
    if (direction !== previousDirection) {
      stepSize *= AT5_SECOND_BIT_STEP_HALF;
    }
    offset += direction * stepSize;
    previousDirection = direction;
  }

  return clampBitallocOffset(offset);
}

function bitallocOffsetWeightForBand(weights, sampleRate, band) {
  return (
    weights[remap48kBitallocBand(sampleRate | 0, band | 0)] ?? weights[weights.length - 1] ?? 1
  );
}

export function bitallocOffsetTargetMode(quantModeBase, band, offset, bitallocOffsetState) {
  if (offset > 0 && usesDirectBitallocScaling(bitallocOffsetState.encodeFlags)) {
    return quantModeBase + offset;
  }

  const weights = offset > 0 ? bitallocOffsetState.posWeights : bitallocOffsetState.negWeights;
  return (
    quantModeBase +
    bitallocOffsetWeightForBand(weights, bitallocOffsetState.sampleRate, band) * offset
  );
}

export function quantModeForBitallocOffset(
  isActive,
  maxMode,
  quantModeBase,
  band,
  offset,
  bitallocOffsetState,
  floatRound = false
) {
  if (!isActive) {
    return 0;
  }

  let desiredMode = bitallocOffsetTargetMode(quantModeBase ?? 0, band, offset, bitallocOffsetState);
  if (floatRound) {
    desiredMode = Math.fround(desiredMode);
  }

  return Math.max(1, Math.min(at5RoundHalfUp(desiredMode), maxMode | 0));
}
