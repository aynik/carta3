import {
  AT5_SIGPROC_COEFF_SET_A,
  AT5_SIGPROC_COEFF_SET_B,
  AT5_SIGPROC_COEFF_SET_C,
  AT5_SIGPROC_COEFF_SET_D,
  AT5_SIGPROC_COEFF_SET_E,
  AT5_SIGPROC_COEFF_TABLE,
} from "../tables/encode-sigproc.js";
import { AT5_SIGPROC_BANDS_MAX } from "./constants.js";

export function at5SigprocPolyphaseSums(
  windowStart,
  sumsOut = new Float32Array(AT5_SIGPROC_BANDS_MAX),
  sumsX87 = new Float64Array(AT5_SIGPROC_BANDS_MAX),
  accScratch = null
) {
  if (!windowStart || !sumsOut || !sumsX87) {
    return { sumsOut, sumsX87 };
  }

  const coef = AT5_SIGPROC_COEFF_TABLE;
  const s0 = windowStart;
  const acc =
    accScratch instanceof Float64Array ? accScratch : new Float64Array(AT5_SIGPROC_BANDS_MAX);

  {
    const spill0 = s0[0] * coef[0];
    acc[0] = s0[15] * coef[192] + spill0;
    acc[1] = s0[14] * coef[193] + s0[1] * coef[1];
    acc[2] = s0[13] * coef[194] + s0[2] * coef[2];
    acc[3] = s0[12] * coef[195] + s0[3] * coef[3];
    const spill4 = s0[4] * coef[4];
    acc[4] = s0[11] * coef[196] + spill4;
    acc[5] = s0[10] * coef[197] + s0[5] * coef[5];
    acc[6] = s0[9] * coef[198] + s0[6] * coef[6];
    acc[7] = s0[8] * coef[199] + s0[7] * coef[7];

    const spill8 = s0[16] * coef[8];
    acc[8] = s0[31] * coef[200] + spill8;
    acc[9] = s0[30] * coef[201] + s0[17] * coef[9];
    acc[10] = s0[29] * coef[202] + s0[18] * coef[10];
    acc[11] = s0[28] * coef[203] + s0[19] * coef[11];
    const spill12 = s0[20] * coef[12];
    acc[12] = s0[27] * coef[204] + spill12;
    acc[13] = Math.fround(s0[26] * coef[205] + s0[21] * coef[13]); // Required rounding
    acc[14] = s0[25] * coef[206] + s0[22] * coef[14];
    acc[15] = s0[24] * coef[207] + s0[23] * coef[15];
  }

  let accLd7 = acc[7];
  let accLd8 = acc[8];
  let accLd10 = acc[10];
  let accLd11 = acc[11];
  let accLd12 = acc[12];
  let accLd13 = acc[13];
  let accLd14 = acc[14];
  let accLd15 = acc[15];

  for (let g = 1; g < 12; g += 1) {
    const sb = g * 32;
    const c0b = g * AT5_SIGPROC_BANDS_MAX;
    const c1b = 192 + g * AT5_SIGPROC_BANDS_MAX;

    const prod0 = Math.fround(windowStart[sb] * coef[c0b]); // Required rounding
    const prod0b = windowStart[sb + 15] * coef[c1b];
    acc[0] = Math.fround(acc[0] + prod0 + prod0b); // Required rounding

    acc[1] = Math.fround(acc[1] + windowStart[sb + 14] * coef[c1b + 1]); // Required rounding
    acc[1] = Math.fround(acc[1] + windowStart[sb + 1] * coef[c0b + 1]); // Required rounding

    const prod2 = Math.fround(windowStart[sb + 2] * coef[c0b + 2]); // Required rounding
    const prod2b = windowStart[sb + 13] * coef[c1b + 2];
    acc[2] = Math.fround(acc[2] + prod2 + prod2b); // Required rounding

    const prod3a = windowStart[sb + 3] * coef[c0b + 3];
    const prod3b = windowStart[sb + 12] * coef[c1b + 3];
    acc[3] = Math.fround(acc[3] + prod3a + prod3b); // Required rounding

    const prod4 = Math.fround(windowStart[sb + 4] * coef[c0b + 4]); // Required rounding
    const prod4b = windowStart[sb + 11] * coef[c1b + 4];
    const prod4sum = prod4 + prod4b;
    acc[4] = Math.fround(acc[4] + prod4sum); // Required rounding

    acc[5] = Math.fround(acc[5] + windowStart[sb + 10] * coef[c1b + 5]); // Required rounding
    acc[5] = Math.fround(acc[5] + windowStart[sb + 5] * coef[c0b + 5]); // Required rounding

    const prod6 = Math.fround(windowStart[sb + 6] * coef[c0b + 6]); // Required rounding
    const prod6b = windowStart[sb + 9] * coef[c1b + 6];
    acc[6] = Math.fround(acc[6] + prod6 + prod6b); // Required rounding

    const prod7 = windowStart[sb + 7] * coef[c0b + 7] + windowStart[sb + 8] * coef[c1b + 7];
    accLd7 = acc[7] + prod7;
    acc[7] = Math.fround(accLd7); // Required rounding

    const prod8a = windowStart[sb + 31] * coef[c1b + 8];
    const prod8b = windowStart[sb + 16] * coef[c0b + 8];
    accLd8 = prod8a + prod8b + acc[8];
    acc[8] = Math.fround(accLd8); // Required rounding

    acc[9] = Math.fround(acc[9] + windowStart[sb + 30] * coef[c1b + 9]); // Required rounding
    acc[9] = Math.fround(acc[9] + windowStart[sb + 17] * coef[c0b + 9]); // Required rounding

    const prod10 = windowStart[sb + 18] * coef[c0b + 10] + windowStart[sb + 29] * coef[c1b + 10];
    accLd10 = acc[10] + prod10;
    acc[10] = Math.fround(accLd10); // Required rounding

    const prod11 = windowStart[sb + 19] * coef[c0b + 11] + windowStart[sb + 28] * coef[c1b + 11];
    accLd11 = acc[11] + prod11;
    acc[11] = Math.fround(accLd11); // Required rounding

    const prod12 = windowStart[sb + 20] * coef[c0b + 12] + windowStart[sb + 27] * coef[c1b + 12];
    accLd12 = acc[12] + prod12;
    acc[12] = Math.fround(accLd12); // Required rounding

    const prod13a = windowStart[sb + 21] * coef[c0b + 13];
    const prod13b = windowStart[sb + 26] * coef[c1b + 13];
    accLd13 = acc[13] + (prod13a + prod13b);
    acc[13] = Math.fround(accLd13); // Required rounding

    const prod14 = windowStart[sb + 22] * coef[c0b + 14] + windowStart[sb + 25] * coef[c1b + 14];
    accLd14 = acc[14] + prod14;
    acc[14] = Math.fround(accLd14); // Required rounding

    const prod15a = windowStart[sb + 24] * coef[c1b + 15];
    const prod15b = windowStart[sb + 23] * coef[c0b + 15];
    let prod15 = prod15a;
    prod15 += prod15b;
    const sum15 = acc[15] + prod15;
    acc[15] = Math.fround(sum15); // Required rounding
    accLd15 = sum15;
  }

  for (let i = 0; i < AT5_SIGPROC_BANDS_MAX; i += 1) {
    sumsOut[i] = acc[i];
    sumsX87[i] = acc[i];
  }
  sumsX87[7] = accLd7;
  sumsX87[8] = accLd8;
  sumsX87[10] = accLd10;
  sumsX87[11] = accLd11;
  sumsX87[12] = accLd12;
  sumsX87[13] = accLd13;
  sumsX87[14] = accLd14;
  sumsX87[15] = accLd15;

  return { sumsOut, sumsX87 };
}

export function at5SigprocModulate16band(
  poly,
  polyX87,
  outBands = new Float32Array(AT5_SIGPROC_BANDS_MAX)
) {
  if (!poly || !polyX87 || !outBands) {
    return outBands;
  }

  const coeffA = AT5_SIGPROC_COEFF_SET_A;
  const coeffB = AT5_SIGPROC_COEFF_SET_B;
  const coeffC = AT5_SIGPROC_COEFF_SET_C;
  const coeffD = AT5_SIGPROC_COEFF_SET_D;
  const coeffE = AT5_SIGPROC_COEFF_SET_E;

  const kIi4 = coeffE[0];
  const kIi2 = coeffA[0];
  const kIi16 = coeffB[0];
  const kIi8 = coeffC[0];

  const p7Ld = polyX87[7] * coeffD[0];
  const p0Ld = poly[0] * coeffD[7];
  const p13Ld = polyX87[13] * coeffD[13];

  const p7 = Math.fround(p7Ld); // Required rounding
  const p5 = Math.fround(poly[5] * coeffD[2]); // Required rounding
  const p6Ld = poly[6] * coeffD[1];
  const p6 = Math.fround(p6Ld); // Required rounding
  const p4Ld = poly[4] * coeffD[3];
  const p4 = Math.fround(p4Ld); // Required rounding

  const p3 = Math.fround(poly[3] * coeffD[4]); // Required rounding
  const p3Ld = p3;

  const p2 = Math.fround(poly[2] * coeffD[5]); // Required rounding
  const p0 = Math.fround(p0Ld); // Required rounding

  const p1Ld = poly[1] * coeffD[6];

  const p8Ld = poly[8] * coeffD[8];
  const p8 = Math.fround(p8Ld); // Required rounding

  const p14Ld = polyX87[14] * coeffD[14];
  const p14 = Math.fround(p14Ld); // Required rounding

  const p15Ld = polyX87[15] * coeffD[15];

  const p9Ld = poly[9] * coeffD[9];
  const p9 = Math.fround(p9Ld); // Required rounding

  const p13 = Math.fround(p13Ld); // Required rounding

  const p10Ld = polyX87[10] * coeffD[10];
  const p10 = Math.fround(p10Ld); // Required rounding

  const p11Ld = polyX87[11] * coeffD[11];
  const p11 = Math.fround(p11Ld); // Required rounding

  const p12Ld = polyX87[12] * coeffD[12];

  const sum0Ld = p0 + p8 + (p7 + p15Ld);

  const mix0Term0Ld = (p7 - p15Ld) * kIi16;
  const mix0Term1Ld = (p0 - p8) * coeffB[7];
  const mix0Ld = mix0Term0Ld + mix0Term1Ld;
  const mix0 = Math.fround(mix0Ld); // Required rounding

  const mixASum0Ld = p7 + p15Ld;
  const mixASum1Ld = p0 + p8;
  const mixALd = kIi8 * (mixASum0Ld - mixASum1Ld);

  const mix1 = Math.fround(kIi8 * (mix0Term0Ld - mix0Term1Ld)); // Required rounding

  const sum1Ld = p14 + p1Ld + (p6 + p9);
  const sum1F32 = Math.fround(sum1Ld); // Required rounding

  const mix2Term0Ld = (p1Ld - p9) * coeffB[6];

  const mixBInnerLd = p6 + p14 - p1Ld - p9;
  const mixBInnerF32 = Math.fround(mixBInnerLd); // Required rounding
  const mixBLd = coeffC[1] * mixBInnerF32;
  const mixB = Math.fround(mixBLd); // Required rounding

  const mix2Term1Ld = Math.fround(p6 - p14) * coeffB[1]; // Required rounding
  const mix2 = Math.fround(mix2Term1Ld + mix2Term0Ld); // Required rounding
  const mix3 = Math.fround(coeffC[1] * (mix2Term1Ld - mix2Term0Ld)); // Required rounding

  const sum2Pair0Ld = p5 + p13;
  const sum2Pair1Ld = p2 + p10;
  const sum2Ld = sum2Pair0Ld + sum2Pair1Ld;
  const sum2F32 = Math.fround(sum2Ld); // Required rounding

  const mixCInnerLd = sum2Pair0Ld - p2 - p10;
  const mixCInnerF32 = Math.fround(mixCInnerLd); // Required rounding
  const mixCLd = coeffC[2] * mixCInnerF32;
  const mixC = Math.fround(mixCLd); // Required rounding

  const mix4Term0Ld = (p5 - p13) * coeffB[2];
  const mix4Term1Ld = (p2 - p10) * coeffB[5];
  const mix4 = Math.fround(mix4Term0Ld + mix4Term1Ld); // Required rounding
  const mix5 = Math.fround(coeffC[2] * (mix4Term0Ld - mix4Term1Ld)); // Required rounding

  const sum3Ld = p3 + p4 + p11Ld + p12Ld;

  const mix6Term0Ld = (p4 - p12Ld) * coeffB[3];
  const mixDLd = coeffC[3] * (p4 + p12Ld - p3Ld - p11Ld);

  const mix6Term1Ld = (p3Ld - p11) * coeffB[4];
  const mix6 = Math.fround(mix6Term0Ld + mix6Term1Ld); // Required rounding
  const mix6Term0F32 = Math.fround(mix6Term0Ld); // Required rounding
  const mix6Term0SpilledLd = mix6Term0F32;
  const mix7 = Math.fround(coeffC[3] * (mix6Term0SpilledLd - mix6Term1Ld)); // Required rounding

  const sumAllLd = sum0Ld + sum1F32 + sum2F32 + sum3Ld;
  const out0Ld = sumAllLd * 0.5;
  outBands[0] = out0Ld;

  const mid0Ld = kIi2 * (sum0Ld - sum1F32 - sum2F32 + sum3Ld);
  const mid0 = Math.fround(mid0Ld); // Required rounding

  const diff03Ld = (sum0Ld - sum3Ld) * kIi4;
  const diff12Ld = (sum1F32 - sum2F32) * coeffE[1];
  const diff12 = Math.fround(diff12Ld); // Required rounding

  const mid1Ld = coeffA[1] * diff03Ld - coeffA[2] * diff12;
  const mid1 = Math.fround(mid1Ld); // Required rounding

  const mid2Ld = (mixALd - mixDLd) * coeffE[2];
  const mid2 = Math.fround(mid2Ld); // Required rounding

  const mid3Ld = (mixB - mixC) * coeffE[3];

  const avg2Pair0Ld = mixB + mixC;
  const avg2Pair1Ld = mixALd + mixDLd;
  let avg2Ld = avg2Pair0Ld + avg2Pair1Ld;
  avg2Ld *= 0.5;

  const mid4Ld = (mid2 + mid3Ld) * 0.5 - avg2Ld;
  const mid4 = Math.fround(mid4Ld); // Required rounding

  const mid5Ld = kIi2 * (mixALd - mixB - mixC + mixDLd) - mid4Ld;

  const mid6Ld = coeffA[1] * mid2 - coeffA[2] * mid3Ld - mid5Ld;
  const mid6 = Math.fround(mid6Ld); // Required rounding

  let avg1Ld = mix0;
  avg1Ld += mix2;
  avg1Ld += mix4;
  avg1Ld += mix6;
  avg1Ld *= 0.5;

  const out1Ld = avg1Ld - outBands[0];
  outBands[1] = out1Ld;

  const out2Ld = avg2Ld - out1Ld;
  outBands[2] = out2Ld;

  const mix0Spill = mix0;
  const mid7Ld = kIi2 * (mix0Spill - mix2 - mix4 + mix6);
  const mid7 = Math.fround(mid7Ld); // Required rounding

  const mid8Ld = kIi4 * (mix0 - mix6);
  const mid8 = Math.fround(mid8Ld); // Required rounding

  const mid9 = Math.fround(coeffE[1] * Math.fround(mix2 - mix4)); // Required rounding

  const mid8Spill = mid8;
  const mid9Spill = mid9;
  const mid10Ld = coeffA[1] * mid8Spill - coeffA[2] * mid9Spill;
  const mid10 = Math.fround(mid10Ld); // Required rounding

  let avg3Ld = mix1;
  avg3Ld += mix3;
  avg3Ld += mix5;
  avg3Ld += mix7;
  avg3Ld *= 0.5;
  avg3Ld -= avg1Ld;

  const out3Ld = avg3Ld - out2Ld;
  outBands[3] = out3Ld;

  const mid11Ld = (mid8Spill + mid9Spill) * 0.5 - avg3Ld;
  const mid11 = Math.fround(mid11Ld); // Required rounding

  const out4Ld = (diff03Ld + diff12) * 0.5 - out3Ld;
  outBands[4] = out4Ld;

  const mid12Ld = (mix1 - mix7) * coeffE[2];
  const mid13Ld = (mix3 - mix5) * coeffE[3];

  const out5Ld = mid11Ld - out4Ld;
  outBands[5] = out5Ld;

  const out6Ld = mid4 - out5Ld;
  outBands[6] = out6Ld;

  const mid14Ld = mid12Ld + mid13Ld - mix1 - mix3 - mix5 - mix7;
  const mid14HalfLd = mid14Ld * 0.5;

  const mid15Ld = kIi2 * (mix1 - mix3 - mix5 + mix7) - mid14HalfLd;

  const mid16Ld = coeffA[1] * mid12Ld - coeffA[2] * mid13Ld - mid15Ld;

  const mid17Ld = mid14HalfLd - mid11;

  const out7Ld = mid17Ld - outBands[6];
  outBands[7] = out7Ld;

  const mid18Ld = mid7 - mid17Ld;

  const out8Ld = mid0 - out7Ld;
  outBands[8] = out8Ld;

  const out9Ld = mid18Ld - out8Ld;
  outBands[9] = out9Ld;

  const mid19Ld = mid15Ld - mid18Ld;

  const out10Ld = mid5Ld - out9Ld;
  outBands[10] = out10Ld;

  const out11Ld = mid19Ld - out10Ld;
  outBands[11] = out11Ld;

  const mid20Ld = mid10 - mid19Ld;

  const out12Ld = mid1 - out11Ld;
  outBands[12] = out12Ld;

  const out13Ld = mid20Ld - out12Ld;
  outBands[13] = out13Ld;

  const mid21Ld = mid16Ld - mid20Ld;

  const out14Ld = mid6 - out13Ld;
  outBands[14] = out14Ld;

  const out15Ld = mid21Ld - out14Ld;
  outBands[15] = out15Ld;

  return outBands;
}
