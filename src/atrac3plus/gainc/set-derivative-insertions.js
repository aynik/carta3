import { fGt } from "./fp.js";

import { at5GaincBuildNormalizedCurve, at5GaincPow2FromCurveVal } from "./passes.js";

import { SLOTS } from "./set-helpers.js";

const AT5_GAINC_MAX_TOTAL_EVENTS = 7;
const AT5_GAINC_ATTACK_INSERTION_RATIO = 1.414;
const AT5_GAINC_BAND0_ATTACK_SUM_LIMIT = 100000;
const AT5_GAINC_BAND0_ATTACK_SUM_RATIO = 10;

function sumScaledCurveRange(decisionCurve, ampWindow, start, endExclusive) {
  let total = 0;
  for (let i = start | 0; i < (endExclusive | 0); i += 1) {
    total += at5GaincPow2FromCurveVal(decisionCurve[i]) * (ampWindow[i] ?? 0);
  }
  return total;
}

function insertGainPassEvent(passOutput, eventCount, insertIndex, splitIndex, bits) {
  const count = eventCount | 0;
  const targetIndex = Math.max(0, Math.min(insertIndex | 0, count));
  for (let i = count; i > targetIndex; i -= 1) {
    passOutput.len[i] = passOutput.len[i - 1];
    passOutput.idx[i + 1] = passOutput.idx[i];
  }
  passOutput.len[targetIndex] = bits | 0;
  passOutput.idx[targetIndex + 1] = splitIndex | 0;
  return (count + 1) | 0;
}

function findInsertionIndex(passOutput, eventCount, splitIndex, reverseOrder = false) {
  const count = eventCount | 0;
  const targetSplit = splitIndex | 0;

  for (let eventIndex = 0; eventIndex < count; eventIndex += 1) {
    const existingSplit = passOutput.idx[eventIndex + 1] | 0;
    if (Math.abs(existingSplit - targetSplit) <= 1) {
      return -1;
    }
    if (reverseOrder ? existingSplit < targetSplit : existingSplit > targetSplit) {
      return eventIndex;
    }
  }

  return count;
}

function shouldInsertDerivativeAttack(decisionCurve, ampWindow, splitIndex, candidateBits) {
  const averageLow =
    sumScaledCurveRange(decisionCurve, ampWindow, 0, splitIndex + 1) / (splitIndex + 1);
  const averageHigh =
    sumScaledCurveRange(decisionCurve, ampWindow, splitIndex + 1, SLOTS + 1) / (SLOTS - splitIndex);

  return fGt(
    averageHigh * AT5_GAINC_ATTACK_INSERTION_RATIO,
    at5GaincPow2FromCurveVal(candidateBits) * averageLow
  );
}

function shouldInsertDerivativeRelease(decisionCurve, ampWindow, splitIndex, candidateBits) {
  const lowSum = sumScaledCurveRange(decisionCurve, ampWindow, 0, splitIndex);
  const averageLow = splitIndex > 0 ? lowSum / splitIndex : lowSum;
  const averageHigh =
    sumScaledCurveRange(decisionCurve, ampWindow, splitIndex, SLOTS + 1) / (SLOTS + 1 - splitIndex);

  return fGt(averageLow, at5GaincPow2FromCurveVal(candidateBits) * averageHigh);
}

export function insertDerivativeAttackEventsAt5(
  derivAttackCount,
  curveAttackEvents,
  curveReleaseEvents,
  attackOut,
  releaseOut,
  decisionCurve,
  derivAttackOut,
  bandIndex,
  prevSumAmp,
  prevSumDeriv,
  ampWindow,
  releaseLimitBits,
  attackUsedBits
) {
  const attackEvents = curveAttackEvents | 0;
  const releaseEvents = curveReleaseEvents | 0;
  let attackBudget = attackUsedBits | 0;

  if (
    (bandIndex | 0) === 0 &&
    fGt(prevSumAmp, AT5_GAINC_BAND0_ATTACK_SUM_LIMIT) &&
    fGt(prevSumAmp, prevSumDeriv * AT5_GAINC_BAND0_ATTACK_SUM_RATIO)
  ) {
    return attackEvents;
  }

  if ((derivAttackCount | 0) <= 0 || attackEvents + releaseEvents >= AT5_GAINC_MAX_TOTAL_EVENTS) {
    return attackEvents;
  }

  let nextAttackEvents = attackEvents;
  at5GaincBuildNormalizedCurve(attackOut, attackEvents, releaseOut, releaseEvents, decisionCurve);

  for (
    let derivIndex = 0;
    derivIndex < (derivAttackCount | 0) &&
    attackEvents + releaseEvents < AT5_GAINC_MAX_TOTAL_EVENTS;
    derivIndex += 1
  ) {
    const splitIndex = derivAttackOut.idx[derivIndex + 1] | 0;
    if (splitIndex < 0 || splitIndex > SLOTS) {
      continue;
    }

    const candidateBits = derivAttackOut.len[derivIndex] | 0;
    if (
      candidateBits <= 0 ||
      !shouldInsertDerivativeAttack(decisionCurve, ampWindow, splitIndex, candidateBits)
    ) {
      continue;
    }

    const insertIndex = findInsertionIndex(attackOut, nextAttackEvents, splitIndex);
    if (insertIndex < 0) {
      continue;
    }

    const insertedBits = Math.min(candidateBits, (releaseLimitBits | 0) - attackBudget);
    if (insertedBits <= 0) {
      continue;
    }

    attackBudget += insertedBits;
    nextAttackEvents = insertGainPassEvent(
      attackOut,
      nextAttackEvents,
      insertIndex,
      splitIndex,
      insertedBits
    );
  }

  return nextAttackEvents;
}

export function insertDerivativeReleaseEventsAt5(
  derivReleaseCount,
  curveAttackEvents,
  curveReleaseEvents,
  attackOut,
  releaseOut,
  decisionCurve,
  derivReleaseOut,
  ampWindow,
  releaseLimitBits,
  releaseUsedBits
) {
  const attackEvents = curveAttackEvents | 0;
  const releaseEvents = curveReleaseEvents | 0;
  let releaseBudget = releaseUsedBits | 0;
  let nextReleaseEvents = releaseEvents;

  if ((derivReleaseCount | 0) <= 0 || attackEvents + releaseEvents >= AT5_GAINC_MAX_TOTAL_EVENTS) {
    return nextReleaseEvents;
  }

  at5GaincBuildNormalizedCurve(attackOut, attackEvents, releaseOut, releaseEvents, decisionCurve);

  for (
    let derivIndex = 0;
    derivIndex < (derivReleaseCount | 0) &&
    attackEvents + releaseEvents < AT5_GAINC_MAX_TOTAL_EVENTS;
    derivIndex += 1
  ) {
    const splitIndex = derivReleaseOut.idx[derivIndex + 1] | 0;
    if (splitIndex < 0 || splitIndex > SLOTS) {
      continue;
    }

    const candidateBits = derivReleaseOut.len[derivIndex] | 0;
    if (
      candidateBits <= 0 ||
      !shouldInsertDerivativeRelease(decisionCurve, ampWindow, splitIndex, candidateBits)
    ) {
      continue;
    }

    const insertIndex = findInsertionIndex(releaseOut, nextReleaseEvents, splitIndex, true);
    if (insertIndex < 0) {
      continue;
    }

    const insertedBits = Math.min(candidateBits, (releaseLimitBits | 0) - releaseBudget);
    if (insertedBits <= 0) {
      continue;
    }

    releaseBudget += insertedBits;
    nextReleaseEvents = insertGainPassEvent(
      releaseOut,
      nextReleaseEvents,
      insertIndex,
      splitIndex,
      insertedBits
    );
  }

  return nextReleaseEvents;
}
