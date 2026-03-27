import { AT5_GAINC_SCALE_TABLE, AT5_GAINC_THRESHOLDS } from "../tables/encode-init.js";

import { fGt, fLe } from "./fp.js";

import {
  at5GaincBuildNormalizedCurve,
  at5GaincMapToGainSel,
  at5GaincPow2FromCurveVal,
  evaluateCurveRaiseCandidateAt5,
} from "./passes.js";
import {
  applyCurveRaiseSeedLimitAt5,
  findWidestCurveRaiseCandidateAt5,
  pruneAndNormalizeCurve,
  scanSuppressedGainRunsAt5,
  seedZeroStartCurveRaiseCandidatesAt5,
} from "./set-curve-raise.js";

import { CURVE_WORDS, MAX_POINTS, SLOTS } from "./set-helpers.js";

const AT5_GAINC_RELEASE_WINDOW_WORDS = 0x10;
const AT5_GAINC_DERIV_RELEASE_LOW_OFFSET = 0x44;
const AT5_GAINC_DERIV_RELEASE_HIGH_OFFSET =
  AT5_GAINC_DERIV_RELEASE_LOW_OFFSET + AT5_GAINC_RELEASE_WINDOW_WORDS;
const AT5_GAINC_MAX_TOTAL_EVENTS = 7;
export {
  applyCurveRaiseSeedLimitAt5,
  findWidestCurveRaiseCandidateAt5,
  pruneAndNormalizeCurve,
  scanSuppressedGainRunsAt5,
  seedZeroStartCurveRaiseCandidatesAt5,
} from "./set-curve-raise.js";

function clampSeedLimitToHighBandFloor(fullBandPeak, highBandPeak, gaincScaleCoef) {
  const totalPeak = fullBandPeak ?? 0;
  const hiPeak = highBandPeak ?? 0;
  return fGt(totalPeak, hiPeak) && fGt(hiPeak * (gaincScaleCoef ?? 0), totalPeak)
    ? hiPeak
    : totalPeak;
}

export function findLastCurveTransitionPeakAt5(ampWindow, curveDiffs) {
  let peakRunning = ampWindow[SLOTS] ?? 0;
  let peakIndex = 0;

  for (let slot = SLOTS - 1; slot >= 0; slot -= 1) {
    if ((curveDiffs[slot] ?? 0) !== 0) {
      peakIndex = slot;
      break;
    }

    const slotPeak = ampWindow[slot] ?? 0;
    if (fGt(slotPeak, peakRunning)) {
      peakRunning = slotPeak;
    }
  }

  return {
    peakIndex,
    peakRunning,
  };
}

export function computeAttackSeedLimitAt5(
  segmentCount,
  curveDiffs,
  peakIndex,
  releaseCur,
  peakRunning,
  currentRecord,
  gaincScaleCoef
) {
  const minHi = currentRecord?.minHi ?? 0;
  const minAll = currentRecord?.minAll ?? 0;
  if ((segmentCount | 0) <= 1) {
    return clampSeedLimitToHighBandFloor(minAll, minHi, gaincScaleCoef);
  }

  const scaledHi = minHi * (gaincScaleCoef ?? 0);
  if ((curveDiffs[peakIndex] ?? 0) <= 0) {
    if ((peakIndex | 0) < AT5_GAINC_RELEASE_WINDOW_WORDS) {
      return fGt(releaseCur, scaledHi) && fGt(scaledHi, peakRunning) ? minHi : (releaseCur ?? 0);
    }
    return releaseCur ?? 0;
  }

  if ((peakIndex | 0) >= AT5_GAINC_RELEASE_WINDOW_WORDS) {
    return peakRunning ?? 0;
  }
  return fGt(peakRunning ?? 0, scaledHi) ? (peakRunning ?? 0) : minHi;
}

export function classifyCurveSegmentAt5(segment, ampWindow, currentReleasePeak, attackCur) {
  const inputDirection = segment.incomingDirection | 0;
  const outputDirection = segment.outgoingDirection | 0;
  const startIndex = segment.start | 0;
  const endIndex = segment.endExclusive | 0;
  const segmentPeak = segment.peakValue ?? 0;
  const startThreshold = ampWindow[startIndex] ?? 0;
  const endThreshold = ampWindow[Math.max(0, ((endIndex | 0) - 1) | 0)] ?? 0;
  if (inputDirection === 1) {
    if (outputDirection === 1) {
      return { mode: 5, thresholdBits: startThreshold };
    }
    if (outputDirection === 2) {
      const thresholdBits = fGt(ampWindow[endIndex] ?? 0, startThreshold)
        ? startThreshold
        : endThreshold;
      return { mode: 6, thresholdBits };
    }
    return { mode: 4, thresholdBits: startThreshold };
  }

  if (inputDirection === 2) {
    if (outputDirection === 1) {
      return { mode: 9, thresholdBits: segmentPeak ?? 0 };
    }
    if (outputDirection === 2) {
      return { mode: 10, thresholdBits: endThreshold };
    }
    return { mode: 8, thresholdBits: currentReleasePeak ?? 0 };
  }

  if (outputDirection === 1) {
    return { mode: 1, thresholdBits: attackCur ?? 0 };
  }
  if (outputDirection === 2) {
    return { mode: 2, thresholdBits: endThreshold };
  }
  return { mode: 0, thresholdBits: segmentPeak ?? 0 };
}

export function classifyCurveSegmentsAt5(
  segments,
  segmentCount,
  ampWindow,
  currentReleasePeak,
  attackSeedStart
) {
  for (let segmentIndex = 0; segmentIndex < (segmentCount | 0); segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const segmentPolicy = classifyCurveSegmentAt5(
      segment,
      ampWindow,
      currentReleasePeak,
      attackSeedStart
    );
    segment.mode = segmentPolicy.mode;
    segment.thresholdValue = segmentPolicy.thresholdBits;
  }
}

export function computeAmpScaledMaxAt5(curve, ampWindow) {
  let scale = at5GaincPow2FromCurveVal(curve[0]);
  let peakValue = (ampWindow[0] ?? 0) * scale;
  let currentExponent = curve[0];

  for (let i = 1; i < SLOTS; i += 1) {
    if ((curve[i] | 0) !== (currentExponent | 0)) {
      scale = at5GaincPow2FromCurveVal(curve[i]);
      currentExponent = curve[i];
    }

    const scaledValue = (ampWindow[i] ?? 0) * scale;
    if (fGt(scaledValue, peakValue)) {
      peakValue = scaledValue;
    }
  }

  return peakValue;
}

export function computeDerivativeSeedLimitAt5(
  derivCurve,
  derivWindow,
  derivReleaseCur,
  currentRecord,
  gaincScaleCoef
) {
  let lastChange = -1;
  let tailPeak = derivWindow[AT5_GAINC_DERIV_RELEASE_LOW_OFFSET] ?? 0;
  for (let i = SLOTS - 1; i >= 0; i -= 1) {
    const curveDelta = (derivCurve[i] | 0) - (derivCurve[i + 1] | 0);
    if (curveDelta !== 0) {
      lastChange = i;
      if (curveDelta < 0 && i >= AT5_GAINC_RELEASE_WINDOW_WORDS) {
        tailPeak = derivWindow[AT5_GAINC_DERIV_RELEASE_HIGH_OFFSET] ?? 0;
      }
      break;
    }

    const derivPeak = derivWindow[(0x24 + i) | 0] ?? 0;
    if (fGt(derivPeak, tailPeak)) {
      tailPeak = derivPeak;
    }
  }

  const derivMaxHi = currentRecord?.derivMaxHi ?? 0;
  const scaledHighPeak = derivMaxHi * (gaincScaleCoef ?? 0);
  let derivSeedLimit = derivReleaseCur ?? 0;

  if (lastChange < 0) {
    derivSeedLimit = clampSeedLimitToHighBandFloor(
      currentRecord?.derivMaxAll ?? 0,
      derivMaxHi,
      gaincScaleCoef
    );
  } else if ((derivCurve[lastChange] | 0) - (derivCurve[lastChange + 1] | 0) < 1) {
    if (
      lastChange < AT5_GAINC_RELEASE_WINDOW_WORDS &&
      fGt(derivSeedLimit, scaledHighPeak) &&
      fGt(scaledHighPeak, tailPeak)
    ) {
      derivSeedLimit = derivMaxHi;
    }
  } else {
    derivSeedLimit = tailPeak;
    if (lastChange < AT5_GAINC_RELEASE_WINDOW_WORDS && fGt(scaledHighPeak, derivSeedLimit)) {
      derivSeedLimit = derivMaxHi;
    }
  }

  return {
    derivSeedLimit,
    lastChange,
    tailPeak,
  };
}

function clearGainControlPointsAt5(currentRecord) {
  currentRecord.entries = 0;
  currentRecord.locations.fill(0);
  currentRecord.levels.fill(0);
}

export function resetOverflowedGaincOutputAt5(
  currentRecord,
  gaincScaleCoef,
  withFrac,
  ampPairs,
  prevHistB,
  spikeCount
) {
  clearGainControlPointsAt5(currentRecord);
  currentRecord.attackTotal = 0;
  currentRecord.releaseTotal = 0;
  currentRecord.attackPoints = 0;
  currentRecord.releaseLast = 0;
  currentRecord.attackFirst = 0;
  currentRecord.attackRoundDownCarry = 0;
  currentRecord.ampScaledMax = currentRecord.minAll ?? 0;
  currentRecord.attackSeedLimit = clampSeedLimitToHighBandFloor(
    currentRecord.minAll ?? 0,
    currentRecord.minHi ?? 0,
    gaincScaleCoef
  );
  currentRecord.releaseTotalB = 0;
  currentRecord.attackTotalB = 0;
  if (withFrac) {
    currentRecord.derivSeedLimit = clampSeedLimitToHighBandFloor(
      currentRecord.derivMaxAll ?? 0,
      currentRecord.derivMaxHi ?? 0,
      gaincScaleCoef
    );
  }
  currentRecord.minTail = ampPairs[SLOTS - 1] ?? 0;
  currentRecord.histA = prevHistB;
  currentRecord.histB = spikeCount;
}

export function writeGainControlPointsAt5(
  currentRecord,
  curve,
  gaincScaleCoef,
  withFrac,
  ampPairs,
  prevHistB,
  spikeCount
) {
  let pointCount = 0;
  clearGainControlPointsAt5(currentRecord);

  for (let i = 0; i < SLOTS; i += 1) {
    if ((curve[i] | 0) === (curve[i + 1] | 0)) {
      continue;
    }
    if (pointCount >= MAX_POINTS) {
      resetOverflowedGaincOutputAt5(
        currentRecord,
        gaincScaleCoef,
        withFrac,
        ampPairs,
        prevHistB,
        spikeCount
      );
      return -1;
    }

    currentRecord.locations[pointCount] = i >>> 0;
    currentRecord.levels[pointCount] = at5GaincMapToGainSel(curve[i]) >>> 0;
    pointCount += 1;
  }

  currentRecord.entries = pointCount >>> 0;
  currentRecord.minTail = ampPairs[SLOTS - 1] ?? 0;
  currentRecord.histA = prevHistB;
  currentRecord.histB = spikeCount;
  return pointCount | 0;
}

export function planGainControlCurvePhase(
  { scratch, cur, bandIndex, cfgMode, withFrac },
  stageState,
  seedState,
  baseCurveEventTotal
) {
  const {
    ampWindow,
    curve,
    curveDiffs,
    segments,
    suppressedCurveRuns,
    initialCurveRaiseCandidates,
    refinementCurveRaiseCandidates,
    plannedCurveRaiseEntries,
    derivAttackOut,
    derivReleaseOut,
    derivWindow,
  } = scratch;
  const {
    releaseCur,
    currentReleasePeak,
    noisyHist,
    derivAttackCount,
    derivReleaseCount,
    derivReleaseCur,
  } = stageState;
  const gainBase = cur.gainBase ?? 0;

  initialCurveRaiseCandidates.length = 0;
  refinementCurveRaiseCandidates.length = 0;
  plannedCurveRaiseEntries.length = 0;

  curveDiffs.fill(0);
  segments[0].start = 0;
  segments[0].endExclusive = ampWindow.length;
  segments[0].incomingDirection = 0;
  segments[0].outgoingDirection = 0;
  segments[0].peakValue = 4;
  let segmentCount = 1;

  for (let slot = 0; slot < SLOTS; slot += 1) {
    const slotPeak = ampWindow[slot] ?? 0;
    const segment = segments[segmentCount - 1];
    if (fGt(slotPeak, segment.peakValue)) {
      segment.peakValue = slotPeak;
    }

    const curveDelta = (curve[slot] | 0) - (curve[slot + 1] | 0);
    if (curveDelta === 0) {
      continue;
    }

    curveDiffs[slot] = curveDelta;
    const outgoingDirection = fLe(curve[slot], curve[slot + 1]) ? 2 : 1;
    segment.endExclusive = slot + 1;
    segment.outgoingDirection = outgoingDirection;

    const nextSegment = segments[segmentCount];
    nextSegment.start = slot + 1;
    nextSegment.endExclusive = ampWindow.length;
    nextSegment.incomingDirection = outgoingDirection;
    nextSegment.outgoingDirection = 0;
    nextSegment.peakValue = 4;
    segmentCount += 1;
  }

  const gaincScaleCoef = (AT5_GAINC_SCALE_TABLE[bandIndex] ?? 0) * gainBase;
  const { peakIndex, peakRunning } = findLastCurveTransitionPeakAt5(ampWindow, curveDiffs);
  cur.attackSeedLimit = computeAttackSeedLimitAt5(
    segmentCount,
    curveDiffs,
    peakIndex,
    releaseCur,
    peakRunning,
    cur,
    gaincScaleCoef
  );
  cur.attackRoundDownCarry = 0;

  let totalEventCount = ((segmentCount | 0) - 1) | 0;

  const plannerActive =
    cfgMode > 1 && !noisyHist && (totalEventCount | 0) < AT5_GAINC_MAX_TOTAL_EVENTS;

  if (plannerActive) {
    classifyCurveSegmentsAt5(
      segments,
      segmentCount,
      ampWindow,
      currentReleasePeak,
      seedState.attack.seedStart
    );

    let averagePeak = 0;
    for (let slot = 0; slot < SLOTS; slot += 1) {
      averagePeak += ampWindow[slot] ?? 0;
    }
    averagePeak /= SLOTS;

    const canPlanMoreEvents = () => totalEventCount < AT5_GAINC_MAX_TOTAL_EVENTS;
    const zeroStartSeedingAllowed =
      withFrac && (baseCurveEventTotal | 0) === 0 && (segmentCount | 0) > 1;
    const considerCurveRaise = (runCandidates, mode, run) => {
      totalEventCount = evaluateCurveRaiseCandidateAt5(
        mode,
        run,
        runCandidates,
        ampWindow,
        curve,
        curveDiffs,
        plannedCurveRaiseEntries,
        totalEventCount,
        cur.gainBase,
        cur.minAll,
        averagePeak
      );
    };

    let suppressionScale = 1;
    for (
      let segmentIndex = 0;
      segmentIndex < (segmentCount | 0) && canPlanMoreEvents();
      segmentIndex += 1
    ) {
      const segment = segments[segmentIndex];
      const segmentMode = segment.mode | 0;
      const minimumRunLength = AT5_GAINC_THRESHOLDS[segmentMode];
      const segmentStart = segment.start | 0;
      const segmentEnd = segment.endExclusive | 0;
      const segmentSpan = segmentEnd - segmentStart;
      if (segmentSpan <= minimumRunLength) {
        continue;
      }

      suppressionScale =
        (segment.outgoingDirection | 0) === 0
          ? suppressionScale + suppressionScale
          : suppressionScale * 1.65;

      suppressedCurveRuns.length = 0;
      const trailingRun = scanSuppressedGainRunsAt5(
        segmentStart,
        segmentEnd,
        suppressionScale,
        segment.thresholdValue ?? 0,
        minimumRunLength,
        ampWindow,
        suppressedCurveRuns
      );

      for (const run of suppressedCurveRuns) {
        if (run.start <= 0) {
          continue;
        }

        considerCurveRaise(initialCurveRaiseCandidates, segmentMode, run);
      }

      const trailingRunSpan = trailingRun.end - trailingRun.start;
      if (!canPlanMoreEvents() || trailingRunSpan <= minimumRunLength) {
        suppressionScale = gainBase;
        continue;
      }

      const trailingRunStartsInsideCurve = ((trailingRun.start | 0) - 1) >>> 0 < SLOTS;
      if (trailingRunStartsInsideCurve) {
        considerCurveRaise(initialCurveRaiseCandidates, segmentMode, trailingRun);
      } else if (zeroStartSeedingAllowed && segmentEnd < SLOTS) {
        seedZeroStartCurveRaiseCandidatesAt5(
          segment,
          ampWindow,
          suppressionScale,
          initialCurveRaiseCandidates
        );
      }

      suppressionScale = gainBase;
    }

    for (
      let candidateIndex = 0;
      candidateIndex < initialCurveRaiseCandidates.length;
      candidateIndex += 1
    ) {
      let remainingRefinementPasses = Math.min(
        3,
        AT5_GAINC_MAX_TOTAL_EVENTS - (totalEventCount | 0)
      );
      let refinementCandidate = initialCurveRaiseCandidates[candidateIndex];

      while (
        remainingRefinementPasses > 0 &&
        (refinementCandidate.start | 0) < CURVE_WORDS &&
        canPlanMoreEvents()
      ) {
        const refinementMode = refinementCandidate.mode | 0;
        const minimumRunLength = AT5_GAINC_THRESHOLDS[refinementMode];
        suppressedCurveRuns.length = 0;
        refinementCurveRaiseCandidates.length = 0;

        const trailingRun = scanSuppressedGainRunsAt5(
          refinementCandidate.start,
          refinementCandidate.end,
          gainBase + gainBase,
          refinementCandidate.value,
          minimumRunLength,
          ampWindow,
          suppressedCurveRuns
        );

        for (const run of suppressedCurveRuns) {
          considerCurveRaise(refinementCurveRaiseCandidates, refinementMode, run);
        }

        const trailingRunSpan = trailingRun.end - trailingRun.start;
        const trailingRunChanged =
          (refinementCandidate.start | 0) !== (trailingRun.start | 0) ||
          (refinementCandidate.end | 0) !== (trailingRun.end | 0);
        if (
          canPlanMoreEvents() &&
          (trailingRun.start | 0) > 0 &&
          (trailingRun.start | 0) < CURVE_WORDS &&
          trailingRunSpan > minimumRunLength &&
          trailingRunChanged
        ) {
          considerCurveRaise(refinementCurveRaiseCandidates, refinementMode, trailingRun);
        }

        const widestCandidateIndex = findWidestCurveRaiseCandidateAt5(
          refinementCurveRaiseCandidates
        );
        if (widestCandidateIndex < 0) {
          break;
        }

        refinementCandidate = refinementCurveRaiseCandidates[widestCandidateIndex];
        remainingRefinementPasses -= 1;
      }
    }
  }
  const plannedRaiseCount = plannedCurveRaiseEntries.length;
  pruneAndNormalizeCurve(curve, plannedCurveRaiseEntries);

  if (plannedRaiseCount > 0) {
    const adjustedAttackSeed = applyCurveRaiseSeedLimitAt5(
      cur,
      plannedCurveRaiseEntries,
      peakIndex
    );
    cur.attackRoundDownCarry = adjustedAttackSeed.attackRoundDownCarry;
    cur.attackSeedLimit = adjustedAttackSeed.attackSeedLimit;
  }

  cur.ampScaledMax = computeAmpScaledMaxAt5(curve, ampWindow);

  if (!withFrac) return gaincScaleCoef;

  const derivCurve = new Int32Array(CURVE_WORDS);
  at5GaincBuildNormalizedCurve(
    derivAttackOut,
    derivAttackCount,
    derivReleaseOut,
    derivReleaseCount,
    derivCurve
  );
  cur.derivSeedLimit = computeDerivativeSeedLimitAt5(
    derivCurve,
    derivWindow,
    derivReleaseCur,
    cur,
    gaincScaleCoef
  ).derivSeedLimit;

  return gaincScaleCoef;
}
