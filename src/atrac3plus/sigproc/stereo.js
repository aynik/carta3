import {
  AT5_SIGPROC_NOISE_FLOOR_44100,
  AT5_SIGPROC_NOISE_FLOOR_48000,
  AT5_SIGPROC_RAMP_TABLE,
} from "../tables/encode-init.js";
import { addSeqAt5, subSeqAt5 } from "../dsp.js";
import {
  checkPowerLevelAt5,
  checkPowerLevelDualAt5,
  checkPowerLevelTriplAt5,
  powerReconstAt5,
} from "../math.js";
import {
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_INTENSITY_DEFAULT,
  AT5_SIGPROC_SUBSAMPLES,
} from "./constants.js";
import { at5SigprocBandRow } from "./aux.js";
import { at5BandPtr } from "./bandptr.js";

const AT5_SIGPROC_MIN_DB_DIFF_RATIO = 0.0010000000474974513;
const AT5_SIGPROC_INTENSITY_WEIGHT_CUTOFF = 0.009999999776482582;
const AT5_SIGPROC_INTENSITY_FULL_SEPARATION_RATIO = 0.999969482421875;
const AT5_SIGPROC_DB_SCALE = 8.68588924407959;
const AT5_SIGPROC_INTENSITY_SOLID_MIX_RATIO = 0.000030517578125;
const AT5_SIGPROC_INTENSITY_ATAN_SCALE = 0.36405980587005615;
const AT5_SIGPROC_DB_DIFF_LIMIT = 60;
const AT5_SIGPROC_SCALE_DEFAULT = 0.25;
const AT5_SIGPROC_MAX_INTENSITY_MIX = 0.125;
const AT5_SIGPROC_HALF_SUBSAMPLES = AT5_SIGPROC_SUBSAMPLES >> 1;
const AT5_SIGPROC_BAND_SAMPLES = AT5_SIGPROC_SUBSAMPLES * 2;

function isZeroOrNegativeOrNan(value) {
  return Number.isNaN(value) || value <= 0;
}

function stereoDifferenceRatio(leftPower, rightPower, diffPower) {
  if (
    (isZeroOrNegativeOrNan(leftPower) && isZeroOrNegativeOrNan(rightPower)) ||
    isZeroOrNegativeOrNan(diffPower)
  ) {
    return AT5_SIGPROC_MIN_DB_DIFF_RATIO;
  }
  if (isZeroOrNegativeOrNan(leftPower) || isZeroOrNegativeOrNan(rightPower)) {
    return 1;
  }
  return diffPower / Math.max(leftPower, rightPower);
}

function dbDiffFromRatio(ratio) {
  if (ratio < 0) {
    return AT5_SIGPROC_DB_DIFF_LIMIT;
  }
  return Math.min(-Math.log(ratio) * AT5_SIGPROC_DB_SCALE, AT5_SIGPROC_DB_DIFF_LIMIT);
}

function intensityBandForMode(sampleRate, coreMode) {
  const noiseFloorTable =
    sampleRate === 48000 ? AT5_SIGPROC_NOISE_FLOOR_48000 : AT5_SIGPROC_NOISE_FLOOR_44100;
  return (noiseFloorTable[coreMode | 0] ?? 0) >>> 0;
}

function fillIntensityWeights(weights, intensityBand) {
  weights.fill(1);

  let weight = 1;
  for (
    let band = intensityBand | 0;
    band >= 0 && band < AT5_SIGPROC_BANDS_MAX;
    band -= 1, weight *= 0.5
  ) {
    if (weight <= AT5_SIGPROC_INTENSITY_WEIGHT_CUTOFF) {
      weight = 0;
    }
    weights[band] = weight;
  }

  let firstWeightedBand = 0;
  while (
    firstWeightedBand < AT5_SIGPROC_BANDS_MAX &&
    weights[firstWeightedBand] <= AT5_SIGPROC_INTENSITY_WEIGHT_CUTOFF
  ) {
    firstWeightedBand += 1;
  }
  return firstWeightedBand;
}

function bandDifferenceRatio(left, right, diffBuf) {
  subSeqAt5(left, right, diffBuf, AT5_SIGPROC_BAND_SAMPLES);

  let sumLeft = 0;
  let sumRight = 0;
  let sumDiff = 0;
  for (let sample = 0; sample < AT5_SIGPROC_BAND_SAMPLES; sample += 1) {
    sumLeft += Math.abs(left[sample]);
    sumRight += Math.abs(right[sample]);
    sumDiff += Math.abs(diffBuf[sample]);
  }

  if (sumLeft === 0 && sumRight === 0 && sumDiff === 0) {
    return 1;
  }
  return sumLeft !== 0 || sumRight !== 0 ? sumDiff / (sumLeft + sumRight) : 0;
}

function intensityMixFromRatio(ratio) {
  if (ratio > AT5_SIGPROC_INTENSITY_FULL_SEPARATION_RATIO) {
    return 0;
  }
  if (ratio < AT5_SIGPROC_INTENSITY_SOLID_MIX_RATIO) {
    return AT5_SIGPROC_MAX_INTENSITY_MIX;
  }

  const mix = Math.atan((0.5 - ratio) * 10) * AT5_SIGPROC_INTENSITY_ATAN_SCALE + 0.5;
  return Math.min(mix, AT5_SIGPROC_MAX_INTENSITY_MIX);
}

function applyIntensityBlend(left, right, previousMix, currentMix, nextMix, weight) {
  const weightedPreviousMix = weight * previousMix;
  const weightedCurrentMix = weight * currentMix;
  const weightedNextMix = weight * nextMix;

  const firstHalfDelta = weightedCurrentMix - weightedPreviousMix;
  const firstHalfBase = weightedPreviousMix + weightedCurrentMix;
  const secondHalfDelta = weightedCurrentMix - weightedNextMix;
  const secondHalfBase = weightedCurrentMix + weightedNextMix;

  for (let sample = 0; sample < AT5_SIGPROC_HALF_SUBSAMPLES; sample += 1) {
    const fac = firstHalfDelta * AT5_SIGPROC_RAMP_TABLE[sample] + firstHalfBase;
    const inv = 1 - fac;
    const x = left[sample];
    const y = right[sample];
    left[sample] = inv * x + fac * y;
    right[sample] = fac * x + inv * y;
  }

  for (
    let sample = AT5_SIGPROC_HALF_SUBSAMPLES, rampIndex = AT5_SIGPROC_HALF_SUBSAMPLES;
    sample < AT5_SIGPROC_SUBSAMPLES;
    sample += 1, rampIndex -= 1
  ) {
    const fac = secondHalfDelta * AT5_SIGPROC_RAMP_TABLE[rampIndex] + secondHalfBase;
    const inv = 1 - fac;
    const x = left[sample];
    const y = right[sample];
    left[sample] = inv * x + fac * y;
    right[sample] = fac * x + inv * y;
  }
}

export function at5SigprocUpdateDbDiff(aux, bandPtrs) {
  if (!aux || !bandPtrs) {
    return;
  }

  const scratch = aux?.scratch?.dbDiff ?? null;
  const diff =
    scratch?.diffBuf instanceof Float32Array
      ? scratch.diffBuf
      : new Float32Array(AT5_SIGPROC_SUBSAMPLES);
  const power = scratch?.powers ?? null;

  for (let band = 0; band < AT5_SIGPROC_BANDS_MAX; band += 1) {
    const left = at5BandPtr(bandPtrs, 6, 0, band);
    const right = at5BandPtr(bandPtrs, 6, 1, band);
    if (!left || !right) {
      aux.dbDiff[band] = 0;
      continue;
    }

    subSeqAt5(left, right, diff, AT5_SIGPROC_SUBSAMPLES);
    const p = checkPowerLevelTriplAt5(
      left,
      left,
      right,
      right,
      diff,
      diff,
      AT5_SIGPROC_SUBSAMPLES,
      power
    );
    const pLeft = p.ab;
    const pRight = p.cd;
    const pDiff = p.ef;
    const ratio = stereoDifferenceRatio(pLeft, pRight, pDiff);
    aux.dbDiff[band] = dbDiffFromRatio(ratio);
  }
}

export function at5SigprocApplyIntensityStereo(aux, shared, bandPtrs, coreMode, channels) {
  if (!aux || !shared || !bandPtrs || (channels | 0) !== 2) {
    if (aux?.intensityBand) {
      aux.intensityBand[0] = AT5_SIGPROC_INTENSITY_DEFAULT;
    }
    return;
  }

  const scratch = aux?.scratch?.intensity ?? null;

  const sampleRate = shared.sampleRateHz ?? 44100;
  aux.intensityBand[0] = intensityBandForMode(sampleRate, coreMode);

  const weights =
    scratch?.weights instanceof Float32Array
      ? scratch.weights
      : new Float32Array(AT5_SIGPROC_BANDS_MAX);
  const firstBand = fillIntensityWeights(weights, aux.intensityBand[0]);
  if (firstBand >= AT5_SIGPROC_BANDS_MAX) {
    return;
  }

  const mix0 = at5SigprocBandRow(aux.mixHist, 0);
  const mix1 = at5SigprocBandRow(aux.mixHist, 1);
  const mix2 = at5SigprocBandRow(aux.mixHist, 2);
  const mix3 = at5SigprocBandRow(aux.mixHist, 3);
  const mix4 = at5SigprocBandRow(aux.mixHist, 4);

  const diffBuf =
    scratch?.diffBuf instanceof Float32Array
      ? scratch.diffBuf
      : new Float32Array(AT5_SIGPROC_BAND_SAMPLES);

  for (let b = firstBand; b < AT5_SIGPROC_BANDS_MAX; b += 1) {
    const left = at5BandPtr(bandPtrs, 7, 0, b);
    const right = at5BandPtr(bandPtrs, 7, 1, b);
    if (!left || !right) {
      continue;
    }

    const mix = intensityMixFromRatio(bandDifferenceRatio(left, right, diffBuf));
    applyIntensityBlend(left, right, mix2[b], mix3[b], mix, weights[b] * 0.5);
    mix4[b] = mix;
  }

  mix0.set(mix1);
  mix1.set(mix2);
  mix2.set(mix3);
  mix3.set(mix4);

  const newScale =
    scratch?.newScale instanceof Float32Array
      ? scratch.newScale
      : new Float32Array(AT5_SIGPROC_BANDS_MAX * 2);
  newScale.fill(AT5_SIGPROC_SCALE_DEFAULT);
  const scalePrev0 = at5SigprocBandRow(aux.scalePrev, 0);
  const scalePrev1 = at5SigprocBandRow(aux.scalePrev, 1);
  const scaleCur0 = at5SigprocBandRow(aux.scaleCur, 0);
  const scaleCur1 = at5SigprocBandRow(aux.scaleCur, 1);
  const newScale0 = at5SigprocBandRow(newScale, 0);
  const newScale1 = at5SigprocBandRow(newScale, 1);

  for (let b = aux.intensityBand[0] | 0; b < AT5_SIGPROC_BANDS_MAX; b += 1) {
    const db = aux.dbDiff[b];
    if (!(db >= -11)) {
      continue;
    }

    const left = at5BandPtr(bandPtrs, 6, 0, b);
    const right = at5BandPtr(bandPtrs, 6, 1, b);
    if (!left || !right) {
      continue;
    }

    const p = checkPowerLevelDualAt5(
      left.subarray(AT5_SIGPROC_SUBSAMPLES),
      left.subarray(AT5_SIGPROC_SUBSAMPLES),
      right.subarray(AT5_SIGPROC_SUBSAMPLES),
      right.subarray(AT5_SIGPROC_SUBSAMPLES),
      AT5_SIGPROC_SUBSAMPLES,
      scratch?.powerDual ?? null
    );

    const addBuf =
      scratch?.addBuf instanceof Float32Array
        ? scratch.addBuf
        : new Float32Array(AT5_SIGPROC_BAND_SAMPLES);
    addSeqAt5(left, right, addBuf, addBuf.length);
    let sumPower = checkPowerLevelAt5(
      addBuf.subarray(AT5_SIGPROC_SUBSAMPLES),
      addBuf.subarray(AT5_SIGPROC_SUBSAMPLES),
      AT5_SIGPROC_SUBSAMPLES
    );
    sumPower *= AT5_SIGPROC_SCALE_DEFAULT;

    if (sumPower > 0) {
      newScale0[b] = Math.sqrt(p.ab / sumPower) * AT5_SIGPROC_SCALE_DEFAULT;
      newScale1[b] = Math.sqrt(p.cd / sumPower) * AT5_SIGPROC_SCALE_DEFAULT;
    } else {
      newScale0[b] = AT5_SIGPROC_SCALE_DEFAULT;
      newScale1[b] = AT5_SIGPROC_SCALE_DEFAULT;
    }

    const powerL = scratch?.powerL instanceof Float32Array ? scratch.powerL : new Float32Array(3);
    const powerR = scratch?.powerR instanceof Float32Array ? scratch.powerR : new Float32Array(3);
    powerL[0] = scalePrev0[b];
    powerL[1] = scaleCur0[b];
    powerL[2] = newScale0[b];
    powerR[0] = scalePrev1[b];
    powerR[1] = scaleCur1[b];
    powerR[2] = newScale1[b];
    powerReconstAt5(powerL, addBuf, left, AT5_SIGPROC_SUBSAMPLES);
    powerReconstAt5(powerR, addBuf, right, AT5_SIGPROC_SUBSAMPLES);
  }

  aux.scalePrev.set(aux.scaleCur);
  aux.scaleCur.set(newScale);
}
