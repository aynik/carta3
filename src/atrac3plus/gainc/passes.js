import { AT5_LNGAIN } from "../tables/decode.js";
import { LOG2E_F32, fGt, fLt, pow2Int } from "./fp.js";

const SLOTS = 0x20;
const MAX_POINTS = 7;
const MAX_ATTACK_EVENTS = MAX_POINTS - 1;
const MAX_RELEASE_EVENTS = MAX_POINTS;
const CURVE_WORDS = 0x21;
const ATTACK_STALE_PEAK_CLAMP_START = 0x19;
const RELEASE_PEAK_HISTORY_INDEX = 0x80;
const AT5_GAINC_STRONG_CHANGE_RATIO = 4;

export function at5GaincPow2FromCurveVal(value) {
  const shift = Math.abs(value) & 31;
  const base = 1 << shift;
  return value < 0 ? 1 / base : base;
}

export function at5GaincMapToGainSel(curveVal) {
  let best = -1;
  for (let i = 0; i < AT5_LNGAIN.length; i++) {
    if (AT5_LNGAIN[i] <= curveVal) best = i;
  }
  return best;
}

export function at5GaincBuildNormalizedCurve(
  attackOut,
  attackEvents,
  releaseOut,
  releaseEvents,
  out
) {
  out.fill(0);
  const aCnt = Math.min(Math.max(0, attackEvents | 0), MAX_POINTS);
  const rCnt = Math.min(Math.max(0, releaseEvents | 0), MAX_POINTS);

  let attackBits = 0;
  for (let i = 0; i < aCnt; i++) attackBits += attackOut?.len?.[i] | 0;
  let cursor = 0;
  for (let i = 0; i < aCnt; i++) {
    const pos = attackOut?.idx?.[i + 1] | 0;
    if (cursor <= pos) {
      out[cursor] += attackBits;
      cursor = Math.min(pos + 1, CURVE_WORDS);
      if (cursor < CURVE_WORDS) {
        out[cursor] -= attackBits;
      }
    }
    attackBits -= attackOut?.len?.[i] | 0;
  }

  let releaseBits = 0;
  for (let i = 0; i < rCnt; i++) releaseBits += releaseOut?.len?.[i] | 0;
  cursor = SLOTS;
  for (let i = 0; i < rCnt; i++) {
    const pos = releaseOut?.idx?.[i + 1] | 0;
    if (pos <= cursor) {
      const releaseStart = Math.max(pos, 0);
      out[releaseStart] += releaseBits;
      if (cursor + 1 < CURVE_WORDS) {
        out[cursor + 1] -= releaseBits;
      }
      cursor = releaseStart - 1;
    }
    releaseBits -= releaseOut?.len?.[i] | 0;
  }

  let curveLevel = 0;
  for (let i = 0; i < CURVE_WORDS; i++) out[i] = curveLevel += out[i];

  const tail = out[SLOTS];
  for (let i = 0; i < CURVE_WORDS; i++) out[i] -= tail;
  return out;
}

export function at5GaincSpikeCount(window) {
  if (!(window instanceof Float32Array) || window.length < 64) return 0;

  let threshold = window[SLOTS - 1];
  if (fLt(threshold, window[SLOTS])) threshold = window[SLOTS];

  let direction = 0;
  let seenDirection = 0;
  let span = 3;
  let spikes = 0;

  for (let slot = 1; slot < SLOTS; slot += 1) {
    const value = window[SLOTS + slot];
    const risingFast =
      fGt(value, threshold) && fGt(value, threshold * AT5_GAINC_STRONG_CHANGE_RATIO);
    const fallingFast =
      !Number.isNaN(threshold) &&
      !Number.isNaN(value) &&
      threshold >= value * AT5_GAINC_STRONG_CHANGE_RATIO;

    if (risingFast) {
      threshold = value;
      if (direction === 1) {
        span = 0;
      } else if (seenDirection !== 1 && span > 2) {
        seenDirection = 1;
        direction = 1;
        spikes += 1;
        span = 1;
        continue;
      } else {
        direction = 1;
        span = 0;
      }
    } else if (fGt(value, threshold)) {
      threshold = value;
    } else if (fallingFast) {
      threshold = value;
      if (direction === 2) {
        // Keep the current falling run alive without counting another spike.
      } else if (seenDirection === 2) {
        direction = 2;
        span = 0;
      } else {
        seenDirection = 2;
        direction = 2;
        spikes += 1;
        span = 1;
        continue;
      }
    }

    span += 1;
  }
  return spikes;
}

function gainRiseRatio(candidateValue, peakValue) {
  return peakValue > 4 ? candidateValue / peakValue : candidateValue * 0.25;
}

function resolveGainStepBits(output, eventIndex, ratio, useFrac, roundNearest = true) {
  const log2v = Math.log(ratio) * LOG2E_F32;
  if (!useFrac) {
    return Math.trunc(roundNearest ? log2v + 0.5 : log2v);
  }

  const prevFrac = eventIndex !== 0 && !(log2v < 2) ? (output.frac[eventIndex - 1] ?? 0) : 0.5;
  const nbits = Math.trunc(log2v + prevFrac);
  output.frac[eventIndex] = log2v - nbits;
  return nbits;
}

export function attackPassAt5({
  count,
  step,
  roundDownCarry = 0,
  totalBits = 0,
  bitLimit = 0,
  usedBits = 0,
  values,
  currentPeak,
  peakLimit,
  scale,
  output,
  withFrac,
}) {
  let attackPeak = currentPeak;
  let peakLimitValue = peakLimit;
  let eventCount = 0;
  let nextRoundDownCarry = roundDownCarry | 0;
  let nextTotalBits = totalBits | 0;
  let nextUsedBits = usedBits | 0;
  const useFrac = withFrac !== 0;

  if (count <= 0) {
    return {
      eventCount,
      roundDownCarry: nextRoundDownCarry,
      totalBits: nextTotalBits,
      usedBits: nextUsedBits,
    };
  }

  for (let scanIndex = 0; scanIndex < count && eventCount < MAX_ATTACK_EVENTS; scanIndex += step) {
    const scanValue = values[scanIndex] ?? 0;
    if (scanValue > attackPeak) {
      attackPeak = scanValue;
    }

    if (eventCount === 0 && !(peakLimitValue < 0)) {
      if (scanValue > peakLimitValue) {
        peakLimitValue = scanValue;
      }
      if (scanIndex > ATTACK_STALE_PEAK_CLAMP_START && attackPeak > peakLimitValue) {
        attackPeak = peakLimitValue;
      }
    }

    const candidateIndex = (scanIndex + step) | 0;
    const candidateValue = values[candidateIndex] ?? 0;
    if (!(candidateValue > scale * attackPeak)) {
      continue;
    }

    const hadRoundDownCarry = nextRoundDownCarry !== 0;
    const bitCount = resolveGainStepBits(
      output,
      eventCount,
      gainRiseRatio(candidateValue, attackPeak),
      useFrac,
      !hadRoundDownCarry
    );
    if (hadRoundDownCarry) {
      nextRoundDownCarry = 0;
    }
    if (bitCount <= 0) {
      continue;
    }

    const writtenBits = Math.min(nextUsedBits + bitCount, bitLimit) - nextUsedBits;
    output.len[eventCount] = writtenBits;
    output.idx[eventCount + 1] = candidateIndex - 1;
    nextUsedBits += writtenBits;
    nextTotalBits += writtenBits;
    eventCount += 1;
  }

  return {
    eventCount,
    roundDownCarry: nextRoundDownCarry,
    totalBits: nextTotalBits,
    usedBits: nextUsedBits,
  };
}

export function releasePassAt5({
  count,
  step,
  baseEventCount = 0,
  initReleaseFlag,
  usedBits = 0,
  bitLimit = 0,
  currentPeak = 0,
  values,
  positionHints,
  scale,
  output,
  withFrac,
}) {
  let releasePeak = currentPeak;
  let eventCount = 0;
  let nextUsedBits = usedBits | 0;
  let nextCurrentPeak = releasePeak;
  const useFrac = withFrac !== 0;

  if (SLOTS <= count) {
    return {
      eventCount,
      usedBits: nextUsedBits,
      currentPeak: nextCurrentPeak,
    };
  }

  for (
    let scanIndex = SLOTS;
    scanIndex > count && baseEventCount + eventCount < MAX_RELEASE_EVENTS;
    scanIndex -= step
  ) {
    const scanValue = values[scanIndex] ?? 0;
    if (scanValue > releasePeak) {
      releasePeak =
        scanIndex === SLOTS && initReleaseFlag === 0
          ? (values[RELEASE_PEAK_HISTORY_INDEX] ?? 0)
          : scanValue;
    }

    const candidateValue = values[(scanIndex - 1) | 0] ?? 0;
    if (!(candidateValue > scale * releasePeak)) {
      continue;
    }

    const bitCount = resolveGainStepBits(
      output,
      eventCount,
      gainRiseRatio(candidateValue, releasePeak),
      useFrac
    );
    if (bitCount <= 0) {
      continue;
    }

    let releaseIndex = scanIndex;
    for (let probeIndex = scanIndex - 1; probeIndex > scanIndex - step; probeIndex -= 1) {
      if (scanValue < (positionHints[probeIndex] ?? 0)) {
        break;
      }
      releaseIndex = probeIndex;
    }

    const writtenBits = Math.min(nextUsedBits + bitCount, bitLimit) - nextUsedBits;
    output.len[eventCount] = writtenBits;
    output.idx[eventCount + 1] = releaseIndex;
    nextUsedBits += writtenBits;

    if (eventCount === 0) {
      nextCurrentPeak = releasePeak;
    }
    eventCount += 1;
  }

  return {
    eventCount,
    usedBits: nextUsedBits,
    currentPeak: nextCurrentPeak,
  };
}

export function evaluateCurveRaiseCandidateAt5(
  mode,
  range,
  runCandidates,
  vals,
  idxs,
  diffs,
  curveAdjustments,
  totalEventCount = 0,
  gainBase = 0,
  minAll = 0,
  threshold
) {
  const rangeStart = range.start | 0;
  const rangeEnd = range.end | 0;
  const rangePeak = range.value ?? range.rangeValue ?? 0;

  const leftScale = pow2Int(idxs[rangeStart - 1]);
  const rightScale = pow2Int(idxs[rangeStart]);
  const leadingEdgeRatio = ((vals[rangeStart - 1] ?? 0) * leftScale) / (rightScale * rangePeak);

  let trailingEdgeRatio;
  if (rangeEnd > SLOTS) {
    trailingEdgeRatio = (vals[rangeEnd] ?? 0) / rangePeak;
  } else {
    trailingEdgeRatio =
      (pow2Int(idxs[rangeEnd]) * (vals[rangeEnd] ?? 0)) / (rangePeak * pow2Int(idxs[rangeEnd - 1]));
  }

  const limitingRatio = trailingEdgeRatio > leadingEdgeRatio ? leadingEdgeRatio : trailingEdgeRatio;
  const scaledGainRatio = limitingRatio / gainBase;

  let gainBits = 0;
  if (scaledGainRatio > 0 && Number.isFinite(scaledGainRatio)) {
    const log2ScaledGain = Math.log(scaledGainRatio) * LOG2E_F32;
    if (Number.isFinite(log2ScaledGain)) gainBits = Math.trunc(log2ScaledGain);
  }

  if (mode === 0 && rangePeak + rangePeak > threshold) gainBits = 0;
  if (gainBits === 1 && rangePeak < 5 && minAll < 100) gainBits = 0;

  if (gainBits > 0) {
    let candidateEventCount = totalEventCount;
    if ((diffs[rangeStart - 1] | 0) === 0) candidateEventCount += 1;
    if (rangeEnd <= 0x20 && (diffs[rangeEnd - 1] | 0) === 0) candidateEventCount += 1;

    if (candidateEventCount <= 7) {
      curveAdjustments.push({
        scaledGainRatio,
        start: rangeStart,
        end: rangeEnd,
        span: rangeEnd - rangeStart,
        gainBits,
        rangeValue: rangePeak,
      });

      if (rangeEnd <= SLOTS) {
        for (let i = rangeStart; i < rangeEnd; i += 1) idxs[i] += gainBits;
        diffs[rangeStart - 1] = idxs[rangeStart - 1] - idxs[rangeStart];
        diffs[rangeEnd - 1] = idxs[rangeEnd - 1] - idxs[rangeEnd];
      } else {
        for (let i = rangeStart; i <= SLOTS; i += 1) idxs[i] += gainBits;
        diffs[rangeStart - 1] = idxs[rangeStart - 1] - idxs[rangeStart];
      }
      totalEventCount = candidateEventCount;
    }
  }

  if (totalEventCount <= 6 && rangeStart < SLOTS && rangeEnd - rangeStart > 7) {
    runCandidates.push({
      start: rangeStart,
      end: rangeEnd,
      value: rangePeak,
      mode: gainBits > 0 ? 0x9 : mode,
    });
  }

  return totalEventCount | 0;
}

// ─── Scratch / working state factories ──────────────────────────────────────

export function createGainPassOutput() {
  return {
    idx: new Int32Array(8),
    len: new Int32Array(MAX_POINTS),
    frac: new Float32Array(MAX_POINTS),
  };
}
