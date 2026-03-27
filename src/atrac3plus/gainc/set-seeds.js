import { LOG2E, fGe, fGt, fLt, nearbyintEven } from "./fp.js";
import { SLOTS } from "./set-helpers.js";

export const AT5_GAINC_FALLBACK_ATTACK_RATIO = 1.5;
export const AT5_GAINC_RELEASE_RATIO = 1.75;

const AT5_GAINC_RELEASE_WINDOW_WORDS = 0x10;
const BASE_ATTACK_BITS = 6;
const BAND0_TLEV_BOOST_THRESHOLD = 10;
const BAND0_TLEV_BOOST_CORE_MODE_LIMIT = 0x1b;

export const AT5_GAINC_PRIMARY_RELEASE_LOW_OFFSET = SLOTS;
export const AT5_GAINC_PRIMARY_RELEASE_HIGH_OFFSET =
  AT5_GAINC_PRIMARY_RELEASE_LOW_OFFSET + AT5_GAINC_RELEASE_WINDOW_WORDS;
export const AT5_GAINC_DERIV_RELEASE_LOW_OFFSET = 0x44;
export const AT5_GAINC_DERIV_RELEASE_HIGH_OFFSET =
  AT5_GAINC_DERIV_RELEASE_LOW_OFFSET + AT5_GAINC_RELEASE_WINDOW_WORDS;

function windowPeak(window, start, count) {
  let peakValue = window[start] ?? 0;
  for (let i = 1; i < (count | 0); i += 1) {
    const value = window[(start + i) | 0] ?? 0;
    if (fGt(value, peakValue)) {
      peakValue = value;
    }
  }
  return peakValue;
}

function summarizeSeedWindowAt5(window, previousSeedLimit) {
  const halfSlots = SLOTS >> 1;
  const lowHalfPeak = windowPeak(window, 0, halfSlots);
  const highHalfPeak = windowPeak(window, halfSlots, halfSlots);
  const fullBandPeak = fGt(lowHalfPeak, highHalfPeak) ? lowHalfPeak : highHalfPeak;
  const lowHalfBoost = lowHalfPeak * 1.5;
  const previousSeedTooHigh = fGe(previousSeedLimit, lowHalfBoost);
  const previousSeedBelowLowHalf = fLt(previousSeedLimit, lowHalfPeak);
  const highHalfOvertakesBoostedLowHalf = fGe(highHalfPeak, lowHalfBoost);

  let seedLimit = previousSeedLimit;
  if (previousSeedTooHigh || previousSeedBelowLowHalf || highHalfOvertakesBoostedLowHalf) {
    seedLimit = previousSeedBelowLowHalf ? previousSeedLimit : lowHalfPeak;
  }

  return {
    lowHalfPeak,
    highHalfPeak,
    fullBandPeak,
    seedLimit,
  };
}

function highestGainLevel(record, entryCount, floor = BASE_ATTACK_BITS) {
  let highestLevel = floor;

  for (let i = 0; i < entryCount; i += 1) {
    const level = record.levels[i] | 0;
    if (level > highestLevel) {
      highestLevel = level;
    }
  }

  return highestLevel;
}

function shouldBoostBand0GainScale(bandIndex, coreMode, tlev) {
  return (
    bandIndex === 0 &&
    coreMode < BAND0_TLEV_BOOST_CORE_MODE_LIMIT &&
    !((tlev ?? 0) < BAND0_TLEV_BOOST_THRESHOLD)
  );
}

export function buildGainSeedState(
  prev,
  cur,
  ampPairs,
  derivWindow,
  withFrac,
  bandIndex,
  coreMode
) {
  const previousEntryCount = prev.entries | 0;
  const hasPreviousEntries = previousEntryCount > 0;
  const attackWindow = summarizeSeedWindowAt5(ampPairs, prev.attackSeedLimit ?? 0);
  const attackSumBits = highestGainLevel(prev, previousEntryCount) - BASE_ATTACK_BITS;
  const attackBudgetLimitBits =
    nearbyintEven(Math.log(65536 / (prev.ampScaledMax ?? 1)) * LOG2E) | 0;
  let gainScale = (cur.gainBase ?? 0) * AT5_GAINC_FALLBACK_ATTACK_RATIO;
  if (shouldBoostBand0GainScale(bandIndex, coreMode, cur.tlev)) {
    gainScale *= 1.5;
  }

  cur.minHi = attackWindow.highHalfPeak;
  cur.minAll = attackWindow.fullBandPeak;

  const attack = {
    sumBits: attackSumBits,
    seedLimit: attackWindow.seedLimit,
    seedStart: hasPreviousEntries ? (prev.attackSeedLimit ?? 0) : attackWindow.seedLimit,
    roundDownCarry: (prev.attackRoundDownCarry ?? 0) | 0,
    budgetLimitBits: attackBudgetLimitBits,
    lowHalfPeak: attackWindow.lowHalfPeak,
    highHalfPeak: attackWindow.highHalfPeak,
  };
  const seedState = { attack, gainScale };
  if (!withFrac) {
    return seedState;
  }

  const derivativeWindow = summarizeSeedWindowAt5(derivWindow, prev.derivSeedLimit ?? 0);

  cur.derivMaxAll = derivativeWindow.fullBandPeak;
  cur.derivMaxHi = derivativeWindow.highHalfPeak;

  seedState.derivative = {
    seedStart: hasPreviousEntries ? (prev.derivSeedLimit ?? 0) : derivativeWindow.seedLimit,
    highHalfPeak: derivativeWindow.highHalfPeak,
    seedLimit: derivativeWindow.seedLimit,
    roundDownCarry: 0,
    sumBits: attack.sumBits,
    budgetLimitBits: attack.budgetLimitBits,
  };
  return seedState;
}

export function computeReleaseBitBudget(
  previousAttackTotal,
  currentAttackTotal,
  previousReleaseTotal
) {
  const releaseBudget =
    (previousAttackTotal | 0) + (currentAttackTotal | 0) - (previousReleaseTotal | 0);
  return (releaseBudget < 0 ? releaseBudget + 6 : 6) | 0;
}

export function createReleaseSeedStateAt5(
  window,
  lowOffset,
  highOffset,
  previousHighHalfPeak,
  previousAttackTotal,
  currentAttackTotal,
  previousReleaseTotal,
  gainBase
) {
  const lowHalfPeak = windowPeak(window, lowOffset, AT5_GAINC_RELEASE_WINDOW_WORDS);
  const highPeak = windowPeak(window, highOffset, AT5_GAINC_RELEASE_WINDOW_WORDS);
  const strongestReleasePeak = fGt(lowHalfPeak, highPeak) ? lowHalfPeak : highPeak;
  const currentPeak = fGt(strongestReleasePeak, lowHalfPeak * AT5_GAINC_RELEASE_RATIO)
    ? lowHalfPeak
    : strongestReleasePeak;
  const previousReleasePeak = previousHighHalfPeak ?? 0;
  const restarted = fGt(currentPeak, previousReleasePeak * AT5_GAINC_RELEASE_RATIO) ? 1 : 0;
  const startPeak = restarted ? previousReleasePeak : currentPeak;
  const budgetBits = computeReleaseBitBudget(
    previousAttackTotal,
    currentAttackTotal,
    previousReleaseTotal
  );
  const releaseState = {
    currentPeak,
    highPeak,
    restarted,
    startPeak,
    budgetBits,
  };

  if (gainBase !== undefined) {
    releaseState.scale = (gainBase ?? 0) * AT5_GAINC_RELEASE_RATIO;
  }
  return releaseState;
}
