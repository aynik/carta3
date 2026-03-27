import { LOG2E, LOG2E_F32, fGt, fLt, nearbyintEven } from "./fp.js";

import { at5GaincBuildNormalizedCurve, attackPassAt5, releasePassAt5 } from "./passes.js";

import {
  insertDerivativeAttackEventsAt5,
  insertDerivativeReleaseEventsAt5,
} from "./set-derivative-insertions.js";

import { planGainControlCurvePhase, writeGainControlPointsAt5 } from "./set-planner.js";

import { PAIR_WORDS, SLOTS, getScratch, resetGainPassOutput } from "./set-helpers.js";
import { analyzeGainWindows } from "./set-analysis.js";
import {
  AT5_GAINC_DERIV_RELEASE_HIGH_OFFSET,
  AT5_GAINC_DERIV_RELEASE_LOW_OFFSET,
  AT5_GAINC_FALLBACK_ATTACK_RATIO,
  AT5_GAINC_PRIMARY_RELEASE_HIGH_OFFSET,
  AT5_GAINC_PRIMARY_RELEASE_LOW_OFFSET,
  AT5_GAINC_RELEASE_RATIO,
  buildGainSeedState,
  computeReleaseBitBudget,
  createReleaseSeedStateAt5,
} from "./set-seeds.js";

export const AT5_GAINC_TAIL_EVENT_INDEX = SLOTS - 1;
const AT5_GAINC_TAIL_ATTACK_PROBE_INDEX = SLOTS + 1;
const AT5_GAINC_MAX_TOTAL_EVENTS = 7;

function sumPassBits(output, eventCount) {
  let totalBits = 0;
  for (let i = 0; i < (eventCount | 0); i += 1) {
    totalBits += output.len[i] | 0;
  }
  return totalBits;
}
export { analyzeGainWindows } from "./set-analysis.js";
export {
  buildGainSeedState,
  computeReleaseBitBudget,
  createReleaseSeedStateAt5,
} from "./set-seeds.js";

function runReleaseStageAt5(
  attackCount,
  releasePeakIdx,
  skipReleasePass,
  releaseSeed,
  values,
  positionHints,
  scale,
  output,
  withFrac
) {
  resetGainPassOutput(output);
  if ((attackCount | 0) <= 0 && skipReleasePass) {
    return {
      eventCount: 0,
      releaseCur: releaseSeed.startPeak,
    };
  }

  const { eventCount, currentPeak: releaseCur } = releasePassAt5({
    count: releasePeakIdx,
    step: 2,
    baseEventCount: attackCount,
    initReleaseFlag: releaseSeed.restarted,
    bitLimit: releaseSeed.budgetBits,
    currentPeak: releaseSeed.startPeak,
    values,
    positionHints,
    scale,
    output,
    withFrac,
  });
  return { eventCount, releaseCur };
}

function runAttackStageAt5(
  count,
  step,
  seed,
  values,
  scale,
  output,
  withFrac,
  usedBits = 0,
  roundDownCarry = seed.roundDownCarry,
  totalBits = seed.sumBits,
  currentPeak = seed.seedStart,
  peakLimit = seed.seedLimit
) {
  resetGainPassOutput(output);
  const {
    eventCount,
    roundDownCarry: nextRoundDownCarry,
    totalBits: nextTotalBits,
    usedBits: nextUsedBits,
  } = attackPassAt5({
    count,
    step,
    roundDownCarry,
    totalBits,
    bitLimit: seed.budgetLimitBits,
    usedBits,
    values,
    currentPeak,
    peakLimit,
    scale,
    output,
    withFrac,
  });
  return {
    eventCount,
    roundDownCarry: nextRoundDownCarry,
    totalBits: nextTotalBits,
    usedBits: nextUsedBits,
    emittedBits: sumPassBits(output, eventCount),
  };
}

function fillReleasePairPeaksAt5(ampPairs, releaseVals4) {
  for (let i = 0; i < PAIR_WORDS; i += 4) {
    const a = ampPairs[i] ?? 0;
    const b = ampPairs[i + 2] ?? 0;
    releaseVals4.fill(fLt(b, a) ? a : b, i, i + 4);
  }
}

/**
 * Appends or overwrites the tail attack marker when a restarted release needs
 * the curve to jump back up at the last slot.
 */
export function appendTailRestartEventAt5(
  restartRelease,
  releaseCount,
  probeLevel,
  releaseCur,
  output,
  eventCount,
  withFrac = false,
  roundToEven = false
) {
  const count = eventCount | 0;
  const probeValue = probeLevel ?? 0;
  if (
    !restartRelease ||
    (releaseCount | 0) <= 0 ||
    !fGt(probeValue, releaseCur * AT5_GAINC_RELEASE_RATIO)
  ) {
    return count;
  }

  const ratio = probeValue / releaseCur;
  const log2v = Math.log(ratio) * LOG2E_F32;
  let extraBits = 0;
  let extraFrac = 0;

  if (withFrac) {
    const prevFrac = count > 0 && !(log2v > 2) ? (output.frac[count - 1] ?? 0.5) : 0.5;
    extraBits = (log2v + prevFrac) | 0;
    extraFrac = log2v - extraBits;
  } else if (roundToEven) {
    extraBits = nearbyintEven(Math.log(ratio) * LOG2E + 0.5) | 0;
  } else {
    extraBits = (log2v + 0.5) | 0;
  }

  if (extraBits <= 0) {
    return count;
  }

  let nextCount = count;
  let fracWriteIndex = -1;
  if (count < 1 || (output.idx[count] | 0) !== AT5_GAINC_TAIL_EVENT_INDEX) {
    if (count + (releaseCount | 0) >= AT5_GAINC_MAX_TOTAL_EVENTS) {
      return count;
    }

    output.len[count] = extraBits;
    output.idx[count + 1] = AT5_GAINC_TAIL_EVENT_INDEX;
    nextCount = count + 1;
    fracWriteIndex = count;
  } else {
    output.len[count - 1] = extraBits;
    fracWriteIndex = count;
  }

  if (withFrac && fracWriteIndex >= 0) {
    output.frac[fracWriteIndex] = extraFrac;
  }

  return nextCount;
}

/**
 * Reuses the neighboring band-1 attack on band 0 when the band-0 history and
 * bit budget indicate the same onset but the primary scan stayed too quiet.
 */
export function augmentBand0AttackFromBand1At5(
  bandIndex,
  currentRecord,
  adjacentBandRecord,
  attackOut,
  attackCount,
  attackSumBits,
  attackLimitBits,
  attackPosBits
) {
  if (
    bandIndex !== 0 ||
    (currentRecord?.gainBase ?? 0) !== 1 ||
    (currentRecord?.tlev ?? 0) > 15 ||
    !((attackSumBits | 0) < (attackLimitBits | 0))
  ) {
    return attackCount | 0;
  }

  const band1 = adjacentBandRecord ?? null;
  if (
    !band1 ||
    (band1.attackPoints ?? 0) <= 0 ||
    (band1.attackTotal ?? 0) <= 1 ||
    ((band1.attackFirst ?? 0) | 0) >= ((band1.releaseLast ?? 0) | 0)
  ) {
    return attackCount | 0;
  }

  let nextAttackCount = attackCount | 0;
  if (nextAttackCount === 0 && fGt(currentRecord?.minAll ?? 0, band1.minAll ?? 0)) {
    attackOut.len[0] = 1;
    attackOut.idx[1] = (band1.attackFirst ?? 0) | 0;
    nextAttackCount = 1;
  }

  const attackBitsTotal = sumPassBits(attackOut, nextAttackCount);
  if (
    (nextAttackCount - 1) >>> 0 < 2 &&
    fGt(currentRecord?.minAll ?? 0, band1.minAll ?? 0) &&
    attackBitsTotal < 3 &&
    (attackPosBits | 0) < (attackLimitBits | 0) &&
    (band1.attackTotal ?? 0) > 3
  ) {
    attackOut.len[0] = (attackOut.len[0] + 1) | 0;
    if (nextAttackCount === 1) {
      attackOut.idx[1] = (band1.attackFirst ?? 0) | 0;
    }
  }

  return nextAttackCount | 0;
}

/**
 * Converts one analyzed band window into the final ATRAC3plus gain-control
 * record and synthesized curve points for the current channel.
 */
export function setGaincAt5(blocks, analysis, band, channel, prevBuf, curBuf, bandCount) {
  const bandIndex = band | 0;
  const channelIndex = channel | 0;
  if (!blocks?.[0] || !blocks[channelIndex] || !analysis || !prevBuf || !curBuf) {
    return;
  }

  const prevRecords = prevBuf.records;
  const curRecords = curBuf.records;
  if (!Array.isArray(prevRecords) || !Array.isArray(curRecords)) {
    return;
  }

  const block0 = blocks[0];
  const block = blocks[channelIndex];
  const shared = block0.shared ?? block0.header?.shared ?? null;
  const coreMode = shared ? (shared.coreMode ?? 0) | 0 : 0;
  const channelCount = shared ? (shared.channels ?? 0) | 0 : 0;
  const state = block0.blockState ?? block0.header?.blockState ?? null;
  const withFrac = (state ? (state.encodeMode ?? 0) | 0 : 0) !== 2;
  const prev = prevRecords[bandIndex];
  const cur = curRecords[bandIndex];
  const scratch = getScratch(block);
  if (
    !prev ||
    !cur ||
    !scratch ||
    !(block.table0 instanceof Float32Array) ||
    !(block.table1 instanceof Float32Array)
  ) {
    return;
  }

  const {
    ampWindow,
    derivVals,
    derivWindow,
    ampPairs,
    releaseVals4,
    curve,
    decisionCurve,
    attackOut,
    releaseOut,
    derivAttackOut,
    derivReleaseOut,
  } = scratch;
  const plannerMode =
    bandIndex >= (bandCount | 0)
      ? 1
      : (channelCount === 2 && (coreMode - 0x0c) >>> 0 < 4) ||
          (channelCount === 1 && coreMode < 0x10)
        ? 2
        : 1;
  const {
    noisyHist,
    prevHistB,
    prevSumAmp,
    prevSumDeriv,
    spikeCount,
    ampPeakIdx,
    releasePeakIdx,
    derivPeakIdx,
  } = analyzeGainWindows(
    block,
    analysis,
    bandIndex,
    withFrac,
    prev,
    cur,
    ampWindow,
    derivVals,
    derivWindow,
    ampPairs
  );
  const seedState = buildGainSeedState(
    prev,
    cur,
    ampPairs,
    derivWindow,
    withFrac,
    bandIndex,
    coreMode
  );
  const attackSeed = seedState.attack;
  const derivativeSeed = seedState.derivative ?? null;
  const derivHistoryWindow = derivWindow.subarray(PAIR_WORDS);
  let derivativeAttackCount = 0;
  let derivativeAttackTotal = 0;
  let derivativeReleaseCount = 0;
  let derivativeReleaseCur = 0;
  const useFractionalPassBits = withFrac ? 1 : 0;
  const skipReleasePass = (cur.tlev ?? 0) > 15;

  let {
    eventCount: attackCount,
    roundDownCarry: primaryAttackRoundDownCarry,
    totalBits: primaryAttackTotalBits,
    usedBits: primaryAttackUsedBits,
  } = runAttackStageAt5(
    Math.min(ampPeakIdx | 0, SLOTS),
    1,
    attackSeed,
    ampWindow,
    seedState.gainScale,
    attackOut,
    useFractionalPassBits
  );

  attackCount = augmentBand0AttackFromBand1At5(
    bandIndex,
    cur,
    curRecords?.[1] ?? null,
    attackOut,
    attackCount,
    primaryAttackTotalBits,
    attackSeed.budgetLimitBits,
    primaryAttackUsedBits
  );
  let attackTotal = sumPassBits(attackOut, attackCount);

  if (derivativeSeed) {
    const { eventCount, emittedBits } = runAttackStageAt5(
      SLOTS,
      1,
      derivativeSeed,
      derivHistoryWindow,
      seedState.gainScale,
      derivAttackOut,
      1
    );
    derivativeAttackCount = eventCount;
    derivativeAttackTotal = emittedBits;
  }

  const primaryReleaseSeed = createReleaseSeedStateAt5(
    ampWindow,
    AT5_GAINC_PRIMARY_RELEASE_LOW_OFFSET,
    AT5_GAINC_PRIMARY_RELEASE_HIGH_OFFSET,
    attackSeed.highHalfPeak,
    prev.attackTotal,
    attackTotal,
    prev.releaseTotal,
    cur.gainBase
  );
  const releaseScale = primaryReleaseSeed.scale;

  let { eventCount: primaryReleaseCount, releaseCur: primaryReleaseCur } = runReleaseStageAt5(
    attackCount,
    releasePeakIdx,
    skipReleasePass,
    primaryReleaseSeed,
    ampPairs,
    ampWindow,
    releaseScale,
    releaseOut,
    useFractionalPassBits
  );

  if (derivativeSeed) {
    const derivativeReleaseSeed = createReleaseSeedStateAt5(
      derivWindow,
      AT5_GAINC_DERIV_RELEASE_LOW_OFFSET,
      AT5_GAINC_DERIV_RELEASE_HIGH_OFFSET,
      derivativeSeed.highHalfPeak,
      prev.attackTotalB,
      derivativeAttackTotal,
      prev.releaseTotalB
    );
    derivWindow[AT5_GAINC_DERIV_RELEASE_HIGH_OFFSET] = derivativeReleaseSeed.highPeak;
    ({ eventCount: derivativeReleaseCount, releaseCur: derivativeReleaseCur } = runReleaseStageAt5(
      derivativeAttackCount,
      derivPeakIdx,
      skipReleasePass,
      derivativeReleaseSeed,
      derivWindow,
      derivHistoryWindow,
      releaseScale,
      derivReleaseOut,
      1
    ));

    derivativeAttackCount = appendTailRestartEventAt5(
      derivativeReleaseSeed.restarted,
      derivativeReleaseCount,
      derivWindow[AT5_GAINC_DERIV_RELEASE_LOW_OFFSET],
      derivativeReleaseCur,
      derivAttackOut,
      derivativeAttackCount,
      false,
      true
    );
  }

  attackCount = appendTailRestartEventAt5(
    primaryReleaseSeed.restarted,
    primaryReleaseCount,
    ampWindow[AT5_GAINC_TAIL_ATTACK_PROBE_INDEX],
    primaryReleaseCur,
    attackOut,
    attackCount,
    withFrac
  );

  if (attackCount === 0) {
    const fallbackScale =
      (cur.gainBase ?? 0) * AT5_GAINC_FALLBACK_ATTACK_RATIO * (bandIndex === 0 ? 2 : 1);
    const fallbackAttack = runAttackStageAt5(
      SLOTS - 2,
      2,
      attackSeed,
      ampPairs,
      fallbackScale,
      attackOut,
      useFractionalPassBits,
      primaryAttackUsedBits,
      primaryAttackRoundDownCarry,
      primaryAttackTotalBits,
      attackSeed.seedStart,
      -1
    );
    attackCount = fallbackAttack.eventCount;

    if (attackCount !== 0) {
      attackTotal = fallbackAttack.emittedBits;
    }
  }

  const releaseLimitBits = computeReleaseBitBudget(
    prev.attackTotal,
    attackTotal,
    prev.releaseTotal
  );
  if (primaryReleaseCount === 0 && !skipReleasePass) {
    fillReleasePairPeaksAt5(ampPairs, releaseVals4);

    ({ eventCount: primaryReleaseCount, releaseCur: primaryReleaseCur } = runReleaseStageAt5(
      attackCount,
      releasePeakIdx,
      false,
      {
        restarted: primaryReleaseSeed.restarted,
        budgetBits: releaseLimitBits,
        startPeak: primaryReleaseCur,
      },
      releaseVals4,
      ampWindow,
      bandIndex === 0 ? releaseScale * 2 : releaseScale,
      releaseOut,
      useFractionalPassBits
    ));
  }
  cur.releaseLast =
    primaryReleaseCount > 0 ? releaseOut.idx[primaryReleaseCount] : AT5_GAINC_TAIL_EVENT_INDEX;
  cur.releaseTotal = sumPassBits(releaseOut, primaryReleaseCount);
  cur.attackPoints = attackCount | 0;
  if (attackCount > 0) {
    cur.attackFirst = attackOut.idx[1];
  }
  cur.attackTotal = attackTotal;
  if (withFrac) {
    cur.attackTotalB = derivativeAttackTotal;
  }

  let curveAttackEvents = attackCount;
  let curveReleaseEvents = primaryReleaseCount;
  const baseCurveEventTotal = (curveAttackEvents | 0) + (curveReleaseEvents | 0);
  const hasDerivativeCurveEvents = derivativeAttackCount > 0 || derivativeReleaseCount > 0;
  if (withFrac && hasDerivativeCurveEvents && baseCurveEventTotal < AT5_GAINC_MAX_TOTAL_EVENTS) {
    curveAttackEvents = insertDerivativeAttackEventsAt5(
      derivativeAttackCount,
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
      primaryAttackUsedBits
    );

    curveReleaseEvents = insertDerivativeReleaseEventsAt5(
      derivativeReleaseCount,
      curveAttackEvents,
      curveReleaseEvents,
      attackOut,
      releaseOut,
      decisionCurve,
      derivReleaseOut,
      ampWindow,
      releaseLimitBits,
      0
    );
  }
  at5GaincBuildNormalizedCurve(attackOut, curveAttackEvents, releaseOut, curveReleaseEvents, curve);

  const gaincScaleCoef = planGainControlCurvePhase(
    { scratch, cur, bandIndex, cfgMode: plannerMode, withFrac },
    {
      releaseCur: primaryReleaseCur,
      currentReleasePeak: primaryReleaseSeed.currentPeak,
      noisyHist,
      derivAttackCount: derivativeAttackCount,
      derivReleaseCount: derivativeReleaseCount,
      derivReleaseCur: derivativeReleaseCur,
    },
    seedState,
    baseCurveEventTotal
  );

  if (
    writeGainControlPointsAt5(
      cur,
      curve,
      gaincScaleCoef,
      withFrac,
      ampPairs,
      prevHistB,
      spikeCount
    ) < 0
  ) {
    return;
  }
}
