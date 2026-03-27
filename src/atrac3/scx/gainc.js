import { AT3_LNGAIN_TABLE } from "../encode-tables.js";
import {
  AT3_GAIN_CONTROL_ENTRY_LIMIT,
  getAt3GainControlCount,
  getAt3GainControlEnd,
  getAt3GainControlGainId,
  getAt3GainControlMaxFirst,
  setAt3GainControlCount,
  setAt3GainControlEntry,
  setAt3GainControlMaxFirst,
} from "./gainc-layout.js";

const GAINC_RATIO_UP_F32 = 1.5;
const GAINC_RATIO_DOWN_F32 = 1.85;
const GAINC_PEAK_LIMIT_F32 = 16384.0;
const GAINC_BLOCK_COUNT = 4;
const GAINC_BAND_COUNT = 64;
const GAINC_FRAME_SAMPLES = 0x200;
const GAINC_GROUP_COUNT = 16;
const GAINC_GROUP_SIZE = 4;
const GAINC_HALF_BAND_COUNT = GAINC_BAND_COUNT >> 1;
const GAINC_NEUTRAL_GAIN_ID = 4;
const GAINC_PEAK_FLOOR = 10;
const GAINC_RATIO_FALLBACK_PEAK = 4;
const GAINC_RATIO_FALLBACK_SCALE = 0.25;
const GAINC_MAX_GAIN = 10;
const LOG10_2 = Math.log10(2.0);

function ensureGaincPlanScratch(scratch) {
  if (!scratch || typeof scratch !== "object") {
    return null;
  }

  let plan = scratch.gaincPlan;
  if (!plan || typeof plan !== "object") {
    plan = {};
    scratch.gaincPlan = plan;
  }

  if (!(plan.accum instanceof Int32Array) || plan.accum.length !== GAINC_HALF_BAND_COUNT + 1) {
    plan.accum = new Int32Array(GAINC_HALF_BAND_COUNT + 1);
  }
  if (!(plan.bandAbsMax instanceof Float32Array) || plan.bandAbsMax.length !== GAINC_BAND_COUNT) {
    plan.bandAbsMax = new Float32Array(GAINC_BAND_COUNT);
  }
  if (!(plan.groupMax instanceof Float32Array) || plan.groupMax.length !== GAINC_GROUP_COUNT) {
    plan.groupMax = new Float32Array(GAINC_GROUP_COUNT);
  }

  if (!Array.isArray(plan.candidatePool)) {
    plan.candidatePool = [];
  }
  if (!Array.isArray(plan.candidates)) {
    plan.candidates = [];
  }
  if (!Array.isArray(plan.upwardCandidates)) {
    plan.upwardCandidates = [];
  }
  if (!Array.isArray(plan.downwardCandidates)) {
    plan.downwardCandidates = [];
  }

  if (!Array.isArray(plan.upwardRunPool)) {
    plan.upwardRunPool = [];
  }
  if (!Array.isArray(plan.downwardRunPool)) {
    plan.downwardRunPool = [];
  }
  if (!Array.isArray(plan.upwardRuns)) {
    plan.upwardRuns = [];
  }
  if (!Array.isArray(plan.downwardRuns)) {
    plan.downwardRuns = [];
  }

  return plan;
}

function gaincSafeLog10(value) {
  let v = value;
  if (v <= 1e-20) {
    v = 1e-20;
  }
  return Math.log10(v);
}

function gaincLog2Round(value) {
  return Math.trunc(gaincSafeLog10(value) / LOG10_2 + 0.5);
}

function clampGainStep(ratio, remaining) {
  return Math.min(Math.max(gaincLog2Round(ratio), 0), remaining);
}

export function lngainofIdAt3(index) {
  if (!Number.isInteger(index) || index < 0 || index >= AT3_LNGAIN_TABLE.length) {
    return -5;
  }
  return AT3_LNGAIN_TABLE[index] | 0;
}

export function idofLngainAt3(value) {
  return AT3_LNGAIN_TABLE.lastIndexOf(value | 0);
}

function applyGainControlSteps(gainSteps, params, endOffset, additive) {
  let cursor = 0;
  const count = getAt3GainControlCount(params);
  for (let index = 0; index < count; index += 1) {
    const gain = lngainofIdAt3(getAt3GainControlGainId(params, index));
    if (gain === -5) {
      return -1;
    }

    const finalEnd = getAt3GainControlEnd(params, index) + endOffset;
    while (cursor <= finalEnd) {
      gainSteps[cursor] = additive ? gainSteps[cursor] + gain : gain;
      cursor += 1;
    }
  }

  return 0;
}

/** Builds the synthesis gain window from the previous and current gain records. */
export function gaincWindow(sampleCount, previousParams, currentParams, out) {
  const gainSteps = new Int32Array(GAINC_BAND_COUNT);
  if (applyGainControlSteps(gainSteps, currentParams, GAINC_HALF_BAND_COUNT, false) === -1) {
    return -1;
  }
  if (applyGainControlSteps(gainSteps, previousParams, 0, true) === -1) {
    return -1;
  }

  let outPos = (sampleCount | 0) - 1;
  let prevGain = 0;

  for (let band = GAINC_BAND_COUNT - 1; band >= 0; band -= 1) {
    const step = gainSteps[band] | 0;
    const curGain = -step;

    if (curGain === prevGain) {
      const gain = step > 0 ? 1 / (1 << (step & 31)) : 1 << (-step & 31);
      for (let index = 0; index < 8; index += 1) {
        out[outPos] = gain;
        outPos -= 1;
      }
    } else {
      let acc = prevGain * 7;
      for (let index = 1; index <= 8; index += 1) {
        out[outPos] = Math.pow(2, (curGain * index + acc) / 8);
        outPos -= 1;
        acc -= prevGain;
      }
    }

    prevGain = curGain;
  }

  return 0;
}

function measureBandPeak(spec, start, width) {
  let maxVal = 0;
  for (let index = 0; index < width; index += 1) {
    const value = Math.abs(spec[start + index]);
    if (value > maxVal) {
      maxVal = value;
    }
  }
  return maxVal;
}

function writeGainControlRuns(accum, outParam) {
  let outCount = 0;
  let committedCount = 0;
  for (let band = 0; band < GAINC_HALF_BAND_COUNT; band += 1) {
    if (accum[band] === accum[band + 1]) {
      continue;
    }

    const gainId = idofLngainAt3(accum[band] - accum[GAINC_HALF_BAND_COUNT]);
    if (gainId === -1) {
      return -1;
    }

    setAt3GainControlEntry(outParam, outCount, band, gainId);
    outCount += 1;
    if (gainId !== GAINC_NEUTRAL_GAIN_ID) {
      committedCount = outCount;
    }
  }

  setAt3GainControlCount(outParam, committedCount);
  return committedCount <= AT3_GAIN_CONTROL_ENTRY_LIMIT ? 0 : -1;
}

function planGainControlBlock(spec, len, prevParam, outParam, scratch = null) {
  const plan = ensureGaincPlanScratch(scratch);
  const accum = plan?.accum ?? new Int32Array(GAINC_HALF_BAND_COUNT + 1);
  accum.fill(0);
  const bandStride = Math.trunc(len / GAINC_BAND_COUNT);
  const half = Math.trunc(len / 2);
  const bandAbsMax = plan?.bandAbsMax ?? new Float32Array(GAINC_BAND_COUNT);
  const groupMax = plan?.groupMax ?? new Float32Array(GAINC_GROUP_COUNT);
  groupMax.fill(0);
  let base = half;
  let maxFirst = 0;
  for (let band = 0; band < GAINC_BAND_COUNT; band += 1) {
    const maxVal = bandStride > 0 ? measureBandPeak(spec, base, bandStride) : 0;
    bandAbsMax[band] = maxVal;
    const groupIndex = band >> 2;
    if (maxVal > groupMax[groupIndex]) {
      groupMax[groupIndex] = maxVal;
    }
    if (band < GAINC_HALF_BAND_COUNT && maxVal > maxFirst) {
      maxFirst = maxVal;
    }
    base += bandStride;
  }

  setAt3GainControlMaxFirst(outParam, maxFirst);
  const prevCount = getAt3GainControlCount(prevParam);
  let maxGain = 0;
  for (let index = 0; index < prevCount; index += 1) {
    const gain = lngainofIdAt3(getAt3GainControlGainId(prevParam, index));
    if (gain === -5) {
      return -1;
    }
    if (gain > maxGain) {
      maxGain = gain;
    }
  }

  const maxWindow =
    bandStride > 0
      ? measureBandPeak(spec, half - bandStride * GAINC_GROUP_SIZE, bandStride * GAINC_GROUP_SIZE)
      : 0;
  const candidatePool = plan?.candidatePool ?? null;
  const candidates = plan?.candidates ?? [];
  let candidateCount = 0;
  let peak = getAt3GainControlMaxFirst(prevParam);
  for (let bandIndex = 0; bandIndex < GAINC_HALF_BAND_COUNT; bandIndex += 1) {
    peak = Math.max(peak, bandAbsMax[bandIndex]);
    const next = bandAbsMax[bandIndex + 1];
    if (next <= GAINC_PEAK_FLOOR || next <= GAINC_RATIO_UP_F32 * peak) {
      continue;
    }

    const ratio =
      peak > GAINC_RATIO_FALLBACK_PEAK ? next / peak : next * GAINC_RATIO_FALLBACK_SCALE;
    let candidate = candidatePool?.[candidateCount] ?? null;
    if (!candidate) {
      candidate = { index: 0, end: 0, ratio: 0, score: 0 };
      if (candidatePool) {
        candidatePool[candidateCount] = candidate;
      }
    }
    candidate.index = bandIndex;
    candidate.end = bandIndex;
    candidate.ratio = ratio;
    candidate.score = gaincSafeLog10(ratio);
    candidates[candidateCount] = candidate;
    candidateCount += 1;
  }

  peak = bandAbsMax[GAINC_BAND_COUNT - 1];
  for (
    let groupIndex = GAINC_GROUP_COUNT - 1;
    groupIndex >= GAINC_GROUP_COUNT >> 1;
    groupIndex -= 1
  ) {
    peak = Math.max(peak, groupMax[groupIndex]);
  }
  for (let groupIndex = (GAINC_GROUP_COUNT >> 1) - 1; groupIndex >= 0; groupIndex -= 1) {
    peak = Math.max(peak, groupMax[groupIndex]);
    const baseValue = groupIndex === 0 ? maxWindow : groupMax[groupIndex - 1];
    if (baseValue <= GAINC_PEAK_FLOOR || baseValue <= GAINC_RATIO_DOWN_F32 * peak) {
      continue;
    }

    const ratio =
      peak > GAINC_RATIO_FALLBACK_PEAK ? baseValue / peak : baseValue * GAINC_RATIO_FALLBACK_SCALE;
    let candidate = candidatePool?.[candidateCount] ?? null;
    if (!candidate) {
      candidate = { index: 0, end: 0, ratio: 0, score: 0 };
      if (candidatePool) {
        candidatePool[candidateCount] = candidate;
      }
    }
    candidate.index = GAINC_HALF_BAND_COUNT + groupIndex;
    candidate.end = groupIndex === 0 ? 1 : groupIndex * GAINC_GROUP_SIZE;
    candidate.ratio = ratio;
    candidate.score = gaincSafeLog10(ratio);
    candidates[candidateCount] = candidate;
    candidateCount += 1;
  }

  candidates.length = candidateCount;

  const upwardCandidates = plan?.upwardCandidates ?? [];
  upwardCandidates.length = 0;
  const downwardCandidates = plan?.downwardCandidates ?? [];
  downwardCandidates.length = 0;
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const candidateLimit = Math.min(candidateCount, AT3_GAIN_CONTROL_ENTRY_LIMIT);
  for (let i = 0; i < candidateLimit; i += 1) {
    const candidate = candidates[i];
    (candidate.index < GAINC_HALF_BAND_COUNT ? upwardCandidates : downwardCandidates).push(
      candidate
    );
  }
  upwardCandidates.sort((left, right) => left.index - right.index);
  downwardCandidates.sort((left, right) => right.index - left.index);

  const upwardRuns = plan?.upwardRuns ?? [];
  upwardRuns.length = 0;
  const upwardRunPool = plan?.upwardRunPool ?? null;
  let upwardRunCount = 0;
  for (const { end, ratio } of upwardCandidates) {
    const step = clampGainStep(ratio, GAINC_MAX_GAIN - maxGain);
    maxGain += step;
    if (step <= 0) {
      continue;
    }

    let run = upwardRunPool?.[upwardRunCount] ?? null;
    if (!run) {
      run = { end: 0, gain: 0 };
      if (upwardRunPool) {
        upwardRunPool[upwardRunCount] = run;
      }
    }
    run.end = end;
    run.gain = step;
    upwardRuns[upwardRunCount] = run;
    upwardRunCount += 1;
    if (upwardRunCount >= AT3_GAIN_CONTROL_ENTRY_LIMIT) {
      break;
    }
  }
  upwardRuns.length = upwardRunCount;

  const downwardRuns = plan?.downwardRuns ?? [];
  downwardRuns.length = 0;
  const downwardRunPool = plan?.downwardRunPool ?? null;
  let downwardRunCount = 0;
  if (upwardRuns.length > 0 || prevCount > 0) {
    const limitGain = Math.min(maxGain, GAINC_NEUTRAL_GAIN_ID);
    let downSum = 0;
    for (const { end, ratio } of downwardCandidates) {
      const step = clampGainStep(ratio, limitGain - downSum);
      downSum += step;
      if (step > 0 && upwardRuns.length < AT3_GAIN_CONTROL_ENTRY_LIMIT) {
        let run = downwardRunPool?.[downwardRunCount] ?? null;
        if (!run) {
          run = { end: 0, gain: 0 };
          if (downwardRunPool) {
            downwardRunPool[downwardRunCount] = run;
          }
        }
        run.end = end;
        run.gain = step;
        downwardRuns[downwardRunCount] = run;
        downwardRunCount += 1;
      }

      if (upwardRuns.length + downwardRunCount >= AT3_GAIN_CONTROL_ENTRY_LIMIT) {
        break;
      }
    }
  }
  downwardRuns.length = downwardRunCount;

  const minId = lngainofIdAt3(0);
  let downOffset = 0;
  for (let index = downwardRuns.length - 1; index >= 0; index -= 1) {
    downOffset = Math.min(downOffset + downwardRuns[index].gain, -minId);
    downwardRuns[index].gain = downOffset;
  }

  const maxId = lngainofIdAt3(0x0f);
  if (maxId === -5) {
    return -1;
  }

  let upOffset = 0;
  for (let index = upwardRuns.length - 1; index >= 0; index -= 1) {
    upOffset = Math.min(upOffset + upwardRuns[index].gain, maxId + downOffset);
    upwardRuns[index].gain = upOffset;
  }

  let pos = 0;
  for (const { end, gain } of upwardRuns) {
    while (pos <= end) {
      accum[pos] += gain;
      pos += 1;
    }
  }

  pos = GAINC_HALF_BAND_COUNT;
  for (const { end, gain } of downwardRuns) {
    while (pos >= end) {
      accum[pos] += gain;
      pos -= 1;
    }
  }

  return writeGainControlRuns(accum, outParam);
}

function gainDiffForBlock(block) {
  const count = getAt3GainControlCount(block);
  if (count === 0) {
    return 0;
  }

  let minGainId = GAINC_NEUTRAL_GAIN_ID;
  let maxGainId = 0;
  let prefixMaxGainId = 0;
  for (let index = 0; index < count; index += 1) {
    const gainId = getAt3GainControlGainId(block, index);
    if (gainId > maxGainId) {
      maxGainId = gainId;
    }
    if (index === 0 || gainId < minGainId) {
      minGainId = Math.min(minGainId, gainId);
      prefixMaxGainId = maxGainId;
    }
  }

  return prefixMaxGainId - minGainId;
}

function sampleWindowExceedsPeakLimit(spec, sampleCount, repeatCount) {
  const start = Math.trunc(sampleCount / 2);
  const total = (repeatCount + 1) * Math.trunc(sampleCount / 64);
  const end = start + total;
  for (let index = start; index < end; index += 1) {
    if (Math.abs(spec[index]) > GAINC_PEAK_LIMIT_F32) {
      return true;
    }
  }

  return false;
}

function insertRepeatGain(block, repeatCount) {
  const id = idofLngainAt3(1);
  if (id === -1) {
    return -1;
  }
  setAt3GainControlCount(block, 1);
  setAt3GainControlEntry(block, 0, repeatCount, id);
  return 0;
}

function insertRepeatGainIfEligible(specs, dst, src) {
  if (getAt3GainControlCount(src[0]) !== 0 || gainDiffForBlock(src[1]) <= 1) {
    return 0;
  }

  if (
    getAt3GainControlCount(dst[0]) !== 0 ||
    getAt3GainControlMaxFirst(dst[0]) > GAINC_PEAK_LIMIT_F32
  ) {
    return 0;
  }

  const repeatCount = getAt3GainControlEnd(src[1], 0);
  if (sampleWindowExceedsPeakLimit(specs[0], GAINC_FRAME_SAMPLES, repeatCount)) {
    return 0;
  }

  return insertRepeatGain(src[0], repeatCount);
}

/** Plans gain-control metadata for the four ATRAC3 quarter-frame blocks. */
export function gaincontrolAt3(specs, dstParams, srcParams, scratch = null) {
  for (let i = 0; i < GAINC_BLOCK_COUNT; i += 1) {
    if (
      planGainControlBlock(specs[i], GAINC_FRAME_SAMPLES, dstParams[i], srcParams[i], scratch) ===
      -1
    ) {
      return -1;
    }
  }

  return insertRepeatGainIfEligible(specs, dstParams, srcParams);
}
