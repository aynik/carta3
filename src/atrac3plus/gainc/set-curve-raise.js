/**
 * Curve-raise planning helpers for ATRAC3plus gain-control curves.
 *
 * These helpers scan suppressed valleys in the provisional curve, rank
 * candidate raises, and normalize the final curve back into the codec's
 * transition budget.
 */
import { AT5_GAINC_THRESHOLDS } from "../tables/encode-init.js";

import { fGt } from "./fp.js";
import { CURVE_WORDS, SLOTS } from "./set-helpers.js";

const AT5_GAINC_MAX_TOTAL_EVENTS = 7;
const AT5_GAINC_CURVE_MIN = -6;
const AT5_GAINC_CURVE_MAX = 9;

function countTransitions(curve, slotCount = SLOTS) {
  let count = 0;
  for (let slot = 0; slot < (slotCount | 0); slot += 1) {
    if ((curve[slot] | 0) !== (curve[slot + 1] | 0)) {
      count += 1;
    }
  }
  return count;
}

export function pruneAndNormalizeCurve(curve, plannedCurveRaiseEntries) {
  let transitions = countTransitions(curve);
  if (plannedCurveRaiseEntries.length > 0 && transitions > AT5_GAINC_MAX_TOTAL_EVENTS) {
    const rankedRaises = [...plannedCurveRaiseEntries].sort(
      (leftEntry, rightEntry) =>
        (leftEntry.scaledGainRatio ?? 0) +
        (leftEntry.span ?? 0) -
        ((rightEntry.scaledGainRatio ?? 0) + (rightEntry.span ?? 0))
    );

    for (const raiseEntry of rankedRaises) {
      if (transitions <= AT5_GAINC_MAX_TOTAL_EVENTS) {
        break;
      }

      const start = raiseEntry.start | 0;
      const end = Math.min(raiseEntry.end | 0, CURVE_WORDS);
      const bitCount = raiseEntry.gainBits | 0;

      for (let i = start; i < end; i += 1) {
        curve[i] -= bitCount;
      }
      transitions = countTransitions(curve);
    }
  }

  const tailValue = curve[SLOTS] | 0;
  for (let i = 0; i < CURVE_WORDS; i += 1) {
    let level = curve[i] | 0;
    if (tailValue !== 0) {
      level -= tailValue;
    }
    if (level > AT5_GAINC_CURVE_MAX) {
      level = AT5_GAINC_CURVE_MAX;
    } else if (level < AT5_GAINC_CURVE_MIN) {
      level = AT5_GAINC_CURVE_MIN;
    }
    curve[i] = level;
  }

  return countTransitions(curve);
}

export function seedZeroStartCurveRaiseCandidatesAt5(
  segment,
  ampWindow,
  suppressionScale,
  runCandidates
) {
  const segmentStart = segment.start | 0;
  const segmentEnd = segment.endExclusive | 0;
  if (segmentStart !== 0 || segmentEnd >= SLOTS) {
    return;
  }

  const mode = segment.mode | 0;
  const minimumRunLength = AT5_GAINC_THRESHOLDS[mode];
  const thresholdBits = segment.thresholdValue ?? 0;
  let runStart = 0;
  let runEnd = 0;
  // Zero-start seeding inherits its initial run peak from slot 1 in the extracted codec flow.
  let runPeak = ampWindow[1] ?? 0;

  for (let slot = 0; slot <= segmentEnd; slot += 1) {
    const value = ampWindow[slot] ?? 0;
    if (suppressionScale * value <= thresholdBits) {
      runEnd += 1;
      if (fGt(value, runPeak)) {
        runPeak = value;
      }
      continue;
    }

    if (runEnd - runStart > minimumRunLength && runCandidates.length < SLOTS) {
      runCandidates.push({
        start: runStart | 0,
        end: runEnd | 0,
        value: runPeak ?? 0,
        mode: mode | 0,
      });
    }

    runPeak = 4;
    runStart = slot + 1;
    runEnd = slot + 1;
  }
}

export function applyCurveRaiseSeedLimitAt5(currentRecord, plannedCurveRaiseEntries, peakIndex) {
  let attackSeedLimit = currentRecord?.attackSeedLimit ?? 0;
  let lastCoveredEnd = peakIndex | 0;
  let attackRoundDownCarry = currentRecord?.attackRoundDownCarry ?? 0;

  for (const raiseEntry of plannedCurveRaiseEntries) {
    if ((raiseEntry.end | 0) <= SLOTS || (raiseEntry.start | 0) <= 0) {
      continue;
    }

    const tailEdge = ((raiseEntry.start | 0) - 1) | 0;
    if (tailEdge < lastCoveredEnd) {
      continue;
    }

    const rangeValue = raiseEntry.rangeValue ?? 0;
    if (!fGt(attackSeedLimit, rangeValue)) {
      continue;
    }

    attackRoundDownCarry = 1;
    lastCoveredEnd = tailEdge;
    attackSeedLimit = rangeValue;
  }

  return {
    attackSeedLimit,
    lastCoveredEnd,
    attackRoundDownCarry,
  };
}

export function scanSuppressedGainRunsAt5(
  startIndex,
  endIndex,
  thresholdScale,
  thresholdValue,
  minimumRunLength,
  ampWindow,
  acceptedRuns = null
) {
  let runPeak = 4;
  let runStart = startIndex | 0;
  let runEnd = startIndex | 0;

  for (let idx = startIndex | 0; idx < (endIndex | 0); idx += 1) {
    const value = ampWindow[idx] ?? 0;
    if ((thresholdScale ?? 0) * value <= (thresholdValue ?? 0)) {
      runEnd += 1;
      if (fGt(value, runPeak)) {
        runPeak = value;
      }
      continue;
    }

    if (runEnd > SLOTS) {
      break;
    }
    if ((runStart - 1) >>> 0 < SLOTS && runEnd - runStart > (minimumRunLength | 0)) {
      acceptedRuns?.push({
        start: runStart,
        end: runEnd,
        value: runPeak,
      });
    }

    runPeak = 4;
    runStart = (idx + 1) | 0;
    runEnd = (idx + 1) | 0;
  }

  return {
    start: runStart,
    end: runEnd,
    value: runPeak,
  };
}

export function findWidestCurveRaiseCandidateAt5(runCandidates) {
  if (runCandidates.length <= 0) {
    return -1;
  }

  let bestIndex = 0;
  let bestSpan = (runCandidates[0]?.end | 0) - (runCandidates[0]?.start | 0);
  for (let i = 1; i < runCandidates.length; i += 1) {
    const span = (runCandidates[i]?.end | 0) - (runCandidates[i]?.start | 0);
    if (span > bestSpan) {
      bestSpan = span;
      bestIndex = i;
    }
  }
  return bestIndex | 0;
}
