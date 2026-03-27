import { AT5_FQF, AT5_IFQF, AT5_SFTBL, AT5_TTVAL } from "../tables/decode.js";
import {
  AT5_SF_ADJ_LEVEL_LIMIT,
  AT5_SF_ADJ_OFFSET_LIMIT,
  AT5_SF_ADJ_RATIO_HI,
  AT5_SF_ADJ_RATIO_LIMIT,
  AT5_SF_ADJ_RATIO_LO,
  AT5_SF_ADJ_SCALE_HI,
  AT5_SF_ADJ_SCALE_LO,
} from "../tables/encode-init.js";
import { AT5_ISPS, AT5_NSPS } from "../tables/unpack.js";
import { roundToEvenI32 } from "../../common/math.js";
import { clampI32 } from "./primitives.js";

const MODE_MIN = [0, -2, -3, -4, -7, -8, -15, -32];
const MODE_MAX = [0, 1, 3, 3, 7, 7, 15, 31];
const gNormalizedBandScratchByBuffer = new WeakMap();

function getNormalizedBandScratch(out, count) {
  const n = count | 0;
  if (!(out instanceof Int16Array) || n <= 0) {
    return new Float32Array(Math.max(n, 0));
  }

  const key = out.buffer;
  let scratch = gNormalizedBandScratchByBuffer.get(key);
  if (!(scratch instanceof Float32Array) || scratch.length < n) {
    scratch = new Float32Array(n);
    gNormalizedBandScratchByBuffer.set(key, scratch);
  }
  return scratch;
}

function assertChannelBlockScratch(block) {
  if (!block || !block.quantOffsetByBand || !block.normalizedBandPeaks) {
    throw new TypeError("invalid AT5 channel block scratch");
  }
}

function assertChannelState(channel) {
  if (!channel || !channel.idwl?.values || !channel.scratchSpectra) {
    throw new TypeError("invalid AT5 channel state");
  }
}

export function meanAbsInBand(spec, start, count) {
  if (count <= 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    sum += Math.abs(spec[start + i]);
  }
  return sum / count;
}

function sumSquares(values, count) {
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const v = values[i];
    sum += v * v;
  }
  return sum;
}

function sumQuantizedEnergy(coeffs, count, scale) {
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const v = (coeffs[i] | 0) * scale;
    sum += v * v;
  }
  return sum;
}

function sumAbsQuantized(coeffs, count) {
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    sum += Math.abs(coeffs[i] | 0);
  }
  return sum;
}

export function raiseIdsfTowardReference(idsf, specEnergy, refEnergy) {
  let nextIdsf = idsf | 0;
  let nextEnergy = specEnergy;

  while (nextEnergy < refEnergy && nextIdsf <= 0x3e) {
    nextEnergy *= AT5_SF_ADJ_SCALE_HI;
    nextIdsf += 1;
  }

  return { idsf: nextIdsf, specEnergy: nextEnergy };
}

export function lowerIdsfTowardReference(idsf, specEnergy, refEnergy) {
  let nextIdsf = idsf | 0;
  let nextEnergy = specEnergy;

  while (nextEnergy > refEnergy && nextIdsf > 0) {
    nextEnergy *= AT5_SF_ADJ_SCALE_LO;
    nextIdsf -= 1;
  }

  return { idsf: nextIdsf, specEnergy: nextEnergy };
}

export function shouldBackOffRaisedIdsf(bandLevel, ratio) {
  return bandLevel > AT5_SF_ADJ_OFFSET_LIMIT
    ? ratio > AT5_SF_ADJ_RATIO_HI || ratio < AT5_SF_ADJ_RATIO_LO
    : ratio > AT5_SF_ADJ_OFFSET_LIMIT;
}

export function hasHighLevelRatioGuard(bandLevel, ratio) {
  return bandLevel >= AT5_SF_ADJ_LEVEL_LIMIT && ratio >= AT5_SF_ADJ_RATIO_LIMIT;
}

export function clampRaisedIdsf(baseIdsf, idsf, stepLimit) {
  if (idsf < baseIdsf) {
    return baseIdsf | 0;
  }
  if ((idsf | 0) - (baseIdsf | 0) > (stepLimit | 0)) {
    return ((baseIdsf | 0) + (stepLimit | 0)) | 0;
  }
  return idsf | 0;
}

export function clampLoweredIdsf(baseIdsf, idsf, stepLimit) {
  if (idsf > baseIdsf) {
    return baseIdsf | 0;
  }
  if ((baseIdsf | 0) - (idsf | 0) > (stepLimit | 0)) {
    return ((baseIdsf | 0) - (stepLimit | 0)) | 0;
  }
  return idsf | 0;
}

function clampQuantizedCoefficients(dst, count, mode) {
  const min = MODE_MIN[mode] | 0;
  const max = MODE_MAX[mode] | 0;
  let nonzero = 0;

  for (let i = 0; i < count; i += 1) {
    let q = dst[i] | 0;
    if (q < min) {
      q = min;
    } else if (q > max) {
      q = max;
    }
    dst[i] = q;
    if (q !== 0) {
      nonzero += 1;
    }
  }

  return nonzero;
}

export function quantizeBandScalar(spec, start, count, step, mode, scratch) {
  const dst = scratch.subarray(start, start + count);
  for (let i = 0; i < count; i += 1) {
    dst[i] = Math.round(spec[start + i] / step);
  }
  return clampQuantizedCoefficients(dst, count, mode);
}

export function quantizeBandAt5(spec, start, count, mode, offset, normDivisor, scale, scratch) {
  const dst = scratch.subarray(start, start + count);
  const normalized = getNormalizedBandScratch(dst, count);
  const inv = 1 / normDivisor;
  for (let i = 0; i < count; i += 1) {
    normalized[i] = spec[start + i] * inv;
  }
  quantAt5(normalized, dst, mode, offset, scale, count);
  return clampQuantizedCoefficients(dst, count, mode);
}

export function at5QuantizeActiveBands(
  blocks,
  quantizedSpectraByChannel,
  channels,
  channelCount,
  bandCount
) {
  const chCount = channelCount | 0;
  const bands = bandCount | 0;

  for (let ch = 0; ch < chCount; ch += 1) {
    const channel = channels[ch];
    assertChannelState(channel);

    const block = blocks[ch];
    assertChannelBlockScratch(block);

    const quantizedSpectrum = quantizedSpectraByChannel[ch];
    if (!(quantizedSpectrum instanceof Float32Array)) {
      throw new TypeError("at5QuantizeActiveBands: missing quantized spectrum");
    }

    const quantModes = channel.idwl.values;
    const out = channel.scratchSpectra;
    for (let band = 0; band < bands; band += 1) {
      const mode = quantModes[band] | 0;
      if (mode < 1) {
        continue;
      }

      const isps = AT5_ISPS[band] >>> 0;
      quantAt5(
        quantizedSpectrum.subarray(isps),
        out.subarray(isps),
        mode,
        block.quantOffsetByBand[band] | 0,
        block.normalizedBandPeaks[band],
        AT5_NSPS[band] >>> 0
      );
    }
  }
}

function findBestScalarIdsfCandidate(
  bandSpec,
  scratchBand,
  nsps,
  mode,
  idsf,
  modeFactor,
  bandScale,
  stepScale,
  refEnergyRaw
) {
  const minIdsf = Math.max(1, (idsf | 0) - 4);
  const maxIdsf = Math.min(0x3f, (idsf | 0) + 1);
  const best = {
    idsf: idsf | 0,
    score: Number.POSITIVE_INFINITY,
    coeffs: new Int16Array(nsps),
  };

  for (let candIdsf = minIdsf; candIdsf <= maxIdsf; candIdsf += 1) {
    const scalefactor = AT5_SFTBL[candIdsf] ?? 0;
    const step = modeFactor * scalefactor * bandScale * stepScale;
    if (!(step > 0)) {
      continue;
    }

    const nonzero = quantizeBandScalar(bandSpec, 0, nsps, step, mode, scratchBand);
    if (nonzero === 0) {
      continue;
    }

    const reconEnergy = sumQuantizedEnergy(scratchBand, nsps, modeFactor * scalefactor);
    const score = Math.abs(Math.log((reconEnergy + 1e-7) / (refEnergyRaw + 1e-7)));
    if (score < best.score) {
      best.score = score;
      best.idsf = candIdsf;
      best.coeffs.set(scratchBand);
    }
  }

  return Number.isFinite(best.score) ? best : null;
}

function nudgeScalarIdsfTowardBandEnergy(bestIdsf, coeffs, nsps, modeFactor, refEnergyRaw) {
  let idsf = bestIdsf | 0;
  let energy = sumQuantizedEnergy(coeffs, nsps, modeFactor * (AT5_SFTBL[idsf] ?? 0));
  if (!(refEnergyRaw > 0)) {
    return { idsf, energy };
  }

  for (let steps = 0; steps < 4 && idsf < 0x3f && energy < refEnergyRaw * 0.8; steps += 1) {
    idsf += 1;
    energy = sumQuantizedEnergy(coeffs, nsps, modeFactor * (AT5_SFTBL[idsf] ?? 0));
  }

  for (let steps = 0; steps < 2 && idsf > 1 && energy > refEnergyRaw * 1.6; steps += 1) {
    idsf -= 1;
    energy = sumQuantizedEnergy(coeffs, nsps, modeFactor * (AT5_SFTBL[idsf] ?? 0));
  }

  return { idsf, energy };
}

function refineScalarIdsfAgainstBandScale(
  bestIdsf,
  coeffs,
  nsps,
  modeFactor,
  band,
  sfAdjustConfig,
  bandLevel,
  refEnergyRaw
) {
  if (!sfAdjustConfig || (band | 0) < (sfAdjustConfig.startBand | 0) || (bestIdsf | 0) <= 0) {
    return bestIdsf | 0;
  }

  const baseSft = AT5_SFTBL[bestIdsf] ?? 0;
  const factor = modeFactor * baseSft;
  const refEnergy = refEnergyRaw * baseSft * baseSft;
  const specEnergy = sumQuantizedEnergy(coeffs, nsps, factor);
  if (!(baseSft > 0) || !(refEnergy > 0) || !(specEnergy > 0)) {
    return bestIdsf | 0;
  }

  const absSum = sumAbsQuantized(coeffs, nsps);
  const ratioNum = absSum > 0 ? (nsps * baseSft) / absSum : 0;
  const ratioDen = Math.max(0, bandLevel) * factor;
  const ratio = ratioDen > 0 ? ratioNum / ratioDen : Number.POSITIVE_INFINITY;
  if (specEnergy < refEnergy) {
    const raised = raiseIdsfTowardReference(bestIdsf, specEnergy, refEnergy);
    const raisedIdsf =
      raised.idsf -
      (raised.specEnergy > refEnergy * sfAdjustConfig.kHi ? 1 : 0) -
      (shouldBackOffRaisedIdsf(bandLevel, ratio) ? 1 : 0);
    return clampRaisedIdsf(bestIdsf, raisedIdsf, sfAdjustConfig.stepLimit);
  }

  const lowered = lowerIdsfTowardReference(bestIdsf, specEnergy, refEnergy);
  const loweredIdsf =
    lowered.idsf +
    (lowered.specEnergy < refEnergy * sfAdjustConfig.kLo ? 1 : 0) +
    (hasHighLevelRatioGuard(bandLevel, ratio) ? 1 : 0);
  return clampLoweredIdsf(bestIdsf, loweredIdsf, sfAdjustConfig.stepLimit);
}

/**
 * Scalar-quantizes one band by probing nearby IDSF candidates, nudging the
 * winner toward the raw band energy, then optionally applying the later
 * scalefactor refinement heuristic.
 */
export function quantizeBandScalarWithIdsfRefine(
  spec,
  channel,
  band,
  mode,
  idsf,
  quantStepScale,
  bandScale = 0.95,
  sfAdjustConfig = null,
  bandLevel = 1
) {
  const start = AT5_ISPS[band] >>> 0;
  const nsps = AT5_NSPS[band] >>> 0;
  if (nsps === 0) {
    return { idsf: idsf | 0, nonzero: 0 };
  }

  const bandSpec = spec.subarray(start, start + nsps);
  const scratchBand = channel.scratchSpectra.subarray(start, start + nsps);
  const refEnergyRaw = sumSquares(bandSpec, nsps);
  const modeFactor = AT5_IFQF[mode] ?? 0;
  if (!(modeFactor > 0)) {
    return { idsf: idsf | 0, nonzero: 0 };
  }

  const stepScale = Math.max(0.03125, quantStepScale);

  const best = findBestScalarIdsfCandidate(
    bandSpec,
    scratchBand,
    nsps,
    mode,
    idsf,
    modeFactor,
    bandScale,
    stepScale,
    refEnergyRaw
  );
  if (!best) {
    scratchBand.fill(0);
    return { idsf: idsf | 0, nonzero: 0 };
  }

  const heuristic = nudgeScalarIdsfTowardBandEnergy(
    best.idsf,
    best.coeffs,
    nsps,
    modeFactor,
    refEnergyRaw
  );
  let adjustedIdsf = refineScalarIdsfAgainstBandScale(
    best.idsf,
    best.coeffs,
    nsps,
    modeFactor,
    band,
    sfAdjustConfig,
    bandLevel,
    refEnergyRaw
  );

  adjustedIdsf = clampI32(adjustedIdsf | 0, 0, 0x3f);
  const adjustedEnergy = sumQuantizedEnergy(
    best.coeffs,
    nsps,
    modeFactor * (AT5_SFTBL[adjustedIdsf] ?? 0)
  );
  if (Math.abs(heuristic.energy - refEnergyRaw) < Math.abs(adjustedEnergy - refEnergyRaw)) {
    adjustedIdsf = heuristic.idsf;
  }

  const stepFinal = modeFactor * (AT5_SFTBL[adjustedIdsf] ?? 0) * bandScale * stepScale;
  if (!(stepFinal > 0)) {
    scratchBand.fill(0);
    return { idsf: adjustedIdsf | 0, nonzero: 0 };
  }

  const nonzeroFinal = quantizeBandScalar(bandSpec, 0, nsps, stepFinal, mode, scratchBand);
  if (nonzeroFinal === 0) {
    scratchBand.fill(0);
    return { idsf: adjustedIdsf | 0, nonzero: 0 };
  }

  return { idsf: adjustedIdsf | 0, nonzero: nonzeroFinal | 0 };
}

function toInt16FromU16(value) {
  const v = value & 0xffff;
  return (v << 16) >> 16;
}

export function quantAt5(spec, out, idx, offset, scale, count) {
  const mode = idx | 0;
  if (mode < 0 || mode >= AT5_FQF.length) {
    throw new RangeError(`invalid ATRAC3plus quant mode index: ${idx}`);
  }
  const off = offset | 0;
  if (off < 0 || off >= 16) {
    throw new RangeError(`invalid ATRAC3plus quant offset: ${offset}`);
  }
  if (!(spec instanceof Float32Array) || !(out instanceof Int16Array)) {
    throw new TypeError("quantAt5 expects Float32Array input and Int16Array output");
  }

  const n = count | 0;
  if (n <= 0) {
    return;
  }
  if (n > spec.length || n > out.length) {
    throw new RangeError("quantAt5 count exceeds input/output array length");
  }

  const qscale = AT5_FQF[mode] ?? 0;
  const threshold = (AT5_TTVAL[(mode << 4) + off] ?? 0) * scale;

  for (let i = 0; i < n; i += 1) {
    const s = spec[i];
    if (!(Math.abs(s) > threshold)) {
      out[i] = 0;
      continue;
    }
    out[i] = toInt16FromU16(roundToEvenI32(s * qscale));
  }
}
