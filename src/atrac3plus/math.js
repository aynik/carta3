/**
 * Numeric helpers for ATRAC3plus correlation checks and power reconstruction.
 */
import {
  AT5_CORR_CAP,
  AT5_CORR_HIGH,
  AT5_CORR_LOG_FALLBACK,
  AT5_CORR_LOG_SCALE,
  AT5_CORR_LOW,
  AT5_POWER_RATIO_DEFAULT,
  AT5_POWER_RATIO_HI,
  AT5_POWER_RATIO_LOW,
  AT5_POWER_RATIO_MID,
  AT5_POWER_RATIO_ZERO,
  AT5_POWER_RECONST_TABLE_8,
  AT5_POWER_RECONST_TABLE_16,
  AT5_POWER_RECONST_TABLE_32,
  AT5_POWER_RECONST_TABLE_64,
} from "./tables/encode-init.js";
import { subSeqAt5 } from "./dsp.js";

function isZeroOrNegativeOrNan(value) {
  return Number.isNaN(value) || value <= 0;
}

export function checkChannelCorrelationAt5(
  aBands,
  bBands,
  count,
  chCount,
  outCorr,
  outPowerA,
  outPowerB,
  scratch = null
) {
  const n = count | 0;
  let diffBuf = scratch?.diffBuf ?? null;
  if (!(diffBuf instanceof Float32Array) || diffBuf.length < n) {
    diffBuf = new Float32Array(n);
  }

  const powersOut = scratch?.powers ?? null;

  for (let idx = 0; idx < (chCount | 0); idx += 1) {
    const a = aBands[idx];
    const b = bBands[idx];
    if (!a || !b) {
      outCorr[idx] = 0;
      outPowerA[idx] = 0;
      outPowerB[idx] = 0;
      continue;
    }

    subSeqAt5(a, b, diffBuf, n);
    const powers = checkPowerLevelTriplAt5(a, a, b, b, diffBuf, diffBuf, n, powersOut);
    const powerA = powers.ab;
    const powerB = powers.cd;
    const powerDiff = powers.ef;

    let corrRatio = 0;
    if (isZeroOrNegativeOrNan(powerA)) {
      if (isZeroOrNegativeOrNan(powerB)) {
        corrRatio = AT5_CORR_LOW;
      } else if (isZeroOrNegativeOrNan(powerDiff)) {
        corrRatio = AT5_CORR_LOW;
      } else {
        corrRatio = AT5_CORR_HIGH;
      }
    } else if (isZeroOrNegativeOrNan(powerDiff)) {
      corrRatio = AT5_CORR_LOW;
    } else if (isZeroOrNegativeOrNan(powerB)) {
      corrRatio = AT5_CORR_HIGH;
    } else if (powerB > powerA) {
      corrRatio = powerDiff / powerB;
    } else {
      corrRatio = powerDiff / powerA;
    }

    const scaledLog =
      corrRatio > 0 ? Math.log(corrRatio) * AT5_CORR_LOG_SCALE : AT5_CORR_LOG_FALLBACK;
    const corr = -scaledLog;
    outCorr[idx] = corr > AT5_CORR_CAP ? AT5_CORR_CAP : corr;
    outPowerA[idx] = powerA;
    outPowerB[idx] = powerB;
  }
}

export function checkPowerLevelAt5(a, b, count) {
  let sum0 = 0.0;
  let sum1 = 0.0;
  let sum2 = 0.0;
  let sum3 = 0.0;

  const n = count | 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    sum0 += b[i + 0] * a[i + 0];
    sum2 += b[i + 2] * a[i + 2];
    sum1 += b[i + 1] * a[i + 1];
    sum3 += b[i + 3] * a[i + 3];
  }
  for (; i < n; i += 1) {
    sum0 += b[i] * a[i];
  }

  return sum0 + sum1 + sum2 + sum3;
}

export function checkPowerLevelDualAt5(a, b, c, d, count, out = null) {
  let sumAb0 = 0.0;
  let sumAb1 = 0.0;
  let sumAb2 = 0.0;
  let sumAb3 = 0.0;
  let sumCd0 = 0.0;
  let sumCd1 = 0.0;
  let sumCd2 = 0.0;
  let sumCd3 = 0.0;

  for (let i = 0; i < (count | 0); i += 4) {
    sumAb0 = Math.fround(sumAb0 + b[i + 0] * a[i + 0]); // Required rounding
    sumAb2 = Math.fround(sumAb2 + b[i + 2] * a[i + 2]); // Required rounding
    sumAb1 = Math.fround(sumAb1 + b[i + 1] * a[i + 1]); // Required rounding
    sumAb3 = Math.fround(sumAb3 + b[i + 3] * a[i + 3]); // Required rounding

    sumCd0 = Math.fround(sumCd0 + d[i + 0] * c[i + 0]); // Required rounding
    sumCd2 = Math.fround(sumCd2 + d[i + 2] * c[i + 2]); // Required rounding
    sumCd1 = Math.fround(sumCd1 + d[i + 1] * c[i + 1]); // Required rounding
    sumCd3 = Math.fround(sumCd3 + d[i + 3] * c[i + 3]); // Required rounding
  }

  let ab = sumAb1 + sumAb0;
  ab = Math.fround(ab + sumAb2); // Required rounding
  ab = Math.fround(ab + sumAb3); // Required rounding

  let cd = sumCd2 + sumCd1;
  cd = cd + sumCd0;
  cd = Math.fround(cd + sumCd3); // Required rounding

  if (out && typeof out === "object") {
    out.ab = ab;
    out.cd = cd;
    return out;
  }
  return { ab, cd };
}

export function checkPowerLevelTriplAt5(a, b, c, d, e, f, count, out = null) {
  let sumAb0 = 0.0;
  let sumAb1 = 0.0;
  let sumAb2 = 0.0;
  let sumAb3 = 0.0;
  let sumCd0 = 0.0;
  let sumCd1 = 0.0;
  let sumCd2 = 0.0;
  let sumCd3 = 0.0;
  let sumEf0 = 0.0;
  let sumEf1 = 0.0;
  let sumEf2 = 0.0;
  let sumEf3 = 0.0;

  for (let i = 0; i < (count | 0); i += 4) {
    sumAb0 += b[i + 0] * a[i + 0];
    sumAb2 += b[i + 2] * a[i + 2];
    sumAb1 += b[i + 1] * a[i + 1];
    sumAb3 += b[i + 3] * a[i + 3];

    sumCd0 += d[i + 0] * c[i + 0];
    sumCd2 += d[i + 2] * c[i + 2];
    sumCd1 += d[i + 1] * c[i + 1];
    sumCd3 += d[i + 3] * c[i + 3];

    sumEf0 += f[i + 0] * e[i + 0];
    sumEf2 += f[i + 2] * e[i + 2];
    sumEf1 += f[i + 1] * e[i + 1];
    sumEf3 += f[i + 3] * e[i + 3];
  }

  let ab = sumAb0 + sumAb1;
  ab = ab + sumAb2;
  ab = ab + sumAb3;

  let cd = sumCd1 + sumCd0;
  cd = cd + sumCd2;
  cd = cd + sumCd3;

  let ef = sumEf0 + sumEf1;
  ef = ef + sumEf2;
  ef = ef + sumEf3;

  if (out && typeof out === "object") {
    out.ab = ab;
    out.cd = cd;
    out.ef = ef;
    return out;
  }
  return { ab, cd, ef };
}

function powerReconstSegment(powerA, powerB) {
  let ratio = 0;
  if (powerA === AT5_POWER_RATIO_ZERO || powerB === AT5_POWER_RATIO_ZERO) {
    ratio = AT5_POWER_RATIO_DEFAULT;
  } else if (powerB > powerA) {
    ratio = powerB / powerA;
  } else {
    ratio = powerA / powerB;
  }

  if (ratio > AT5_POWER_RATIO_HI) {
    return AT5_POWER_RECONST_TABLE_8;
  }
  if (ratio > AT5_POWER_RATIO_MID) {
    return AT5_POWER_RECONST_TABLE_16;
  }
  if (ratio > AT5_POWER_RATIO_LOW) {
    return AT5_POWER_RECONST_TABLE_32;
  }
  return AT5_POWER_RECONST_TABLE_64;
}

export function powerReconstAt5(power, input, output, count) {
  const headTable = powerReconstSegment(power[0], power[1]);
  const tailTable = powerReconstSegment(power[1], power[2]);
  const headLength = headTable.length - 1;
  const tailLength = tailTable.length - 1;

  const headDelta = power[1] - power[0];
  const headSum = power[1] + power[0];
  const tailDelta = power[1] - power[2];
  const tailSum = power[1] + power[2];

  const midScale = headDelta * headTable[headLength] + headSum;

  let i = 0;
  for (; i < headLength; i += 1) {
    output[i] = (headDelta * headTable[i] + headSum) * input[i];
  }

  const midEnd = (count | 0) - tailLength;
  for (; i < midEnd; i += 1) {
    output[i] = midScale * input[i];
  }

  const tailStart = (count | 0) - tailLength;
  if (tailStart < (count | 0)) {
    for (let t = 0; t < (count | 0) - tailStart; t += 1) {
      const idx = tailStart + t;
      output[idx] = (tailDelta * tailTable[(count | 0) - tailStart - t] + tailSum) * input[idx];
    }
  }
}
