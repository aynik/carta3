import { AT5_PHASE_BIAS, AT5_PHASE_SCALE, AT5_PHASE_TWO_PI } from "../tables/encode-init.js";
import { AT5_SIN } from "../tables/decode.js";
import { checkPowerLevelAt5F32, shellSortDesc } from "./util.js";

const AT5_FINE_FRAME_SAMPLES = 0x100;
const AT5_FINE_COMPONENT_BUFFER_SIZE = 0x104;
const AT5_FINE_SEARCH_STEP = 2;
const AT5_FINE_BIN_STRIDE = 8;
const AT5_FINE_EDGE_OFFSET = 4;
const AT5_FINE_MAX_FREQUENCY = 0x400;
const AT5_FINE_PHASE_MASK = 0x7ff;
const AT5_FINE_COS_PHASE_OFFSET = 0x200;

function ensureF32(value, length) {
  if (value instanceof Float32Array && value.length === length) {
    return value;
  }
  return new Float32Array(length);
}

function measureSinCosProjection(samples, sinValues, cosValues, sampleStart, sampleEnd) {
  let dotSin0 = 0;
  let dotSin1 = 0;
  let dotSin2 = 0;
  let dotSin3 = 0;
  let dotCos0 = 0;
  let dotCos1 = 0;
  let dotCos2 = 0;
  let dotCos3 = 0;

  let sampleIndex = sampleStart;
  for (; sampleIndex < sampleEnd && (sampleIndex & 3) !== 0; sampleIndex += 1) {
    const sample = samples[sampleIndex];
    dotSin0 += sample * sinValues[sampleIndex];
    dotCos0 += sample * cosValues[sampleIndex];
  }

  for (; sampleIndex + 3 < sampleEnd; sampleIndex += 4) {
    dotSin0 += samples[sampleIndex + 0] * sinValues[sampleIndex + 0];
    dotSin2 += samples[sampleIndex + 2] * sinValues[sampleIndex + 2];
    dotSin1 += samples[sampleIndex + 1] * sinValues[sampleIndex + 1];
    dotSin3 += samples[sampleIndex + 3] * sinValues[sampleIndex + 3];

    dotCos0 += samples[sampleIndex + 0] * cosValues[sampleIndex + 0];
    dotCos2 += samples[sampleIndex + 2] * cosValues[sampleIndex + 2];
    dotCos1 += samples[sampleIndex + 1] * cosValues[sampleIndex + 1];
    dotCos3 += samples[sampleIndex + 3] * cosValues[sampleIndex + 3];
  }

  for (; sampleIndex < sampleEnd; sampleIndex += 1) {
    const sample = samples[sampleIndex];
    dotSin0 += sample * sinValues[sampleIndex];
    dotCos0 += sample * cosValues[sampleIndex];
  }

  return {
    dotSin: dotSin1 + dotSin0 + dotSin2 + dotSin3,
    dotCos: dotCos2 + dotCos1 + dotCos0 + dotCos3,
  };
}

function solveSinusoidCoefficients({
  sinEnd,
  sinStart,
  cosEndPrev,
  cosStartPrev,
  sinStep,
  sinStartPrev,
  sinEndPrev,
  span,
  dotSin,
  dotCos,
}) {
  const boundaryCrossTerm = (cosEndPrev * sinEnd - cosStartPrev * sinStart) / sinStep;
  const overlapTerm = (sinEnd * sinEndPrev - sinStart * sinStartPrev) / (2 * sinStep);
  const forwardWeight = 0.5 * (span + boundaryCrossTerm);
  const reverseWeight = 0.5 * (span - boundaryCrossTerm);
  const determinant = overlapTerm * overlapTerm - forwardWeight * reverseWeight;

  return {
    cosCoeff: (overlapTerm * dotSin - reverseWeight * dotCos) / determinant,
    sinCoeff: (overlapTerm * dotCos - forwardWeight * dotSin) / determinant,
  };
}

function measureDcComponent(samples, sampleStart, sampleEnd, residual) {
  const span = (sampleEnd - sampleStart) | 0;
  let sum = 0;

  let sampleIndex = sampleStart;
  for (; sampleIndex < sampleEnd && (sampleIndex & 3) !== 0; sampleIndex += 1) {
    sum += samples[sampleIndex];
  }
  for (; sampleIndex + 3 < sampleEnd; sampleIndex += 4) {
    sum += samples[sampleIndex + 0];
    sum += samples[sampleIndex + 1];
    sum += samples[sampleIndex + 2];
    sum += samples[sampleIndex + 3];
  }
  for (; sampleIndex < sampleEnd; sampleIndex += 1) {
    sum += samples[sampleIndex];
  }

  const mean = sum / span;
  for (let sampleIndex = sampleStart; sampleIndex < sampleEnd; sampleIndex += 1) {
    residual[sampleIndex] = samples[sampleIndex] - mean;
  }

  return {
    power: checkPowerLevelAt5F32(residual, residual, AT5_FINE_FRAME_SAMPLES),
    sinCoeff: 0,
    cosCoeff: mean,
  };
}

function buildSinusoidBasis(frequency, sampleStart, sampleEnd, sinValues, cosValues) {
  let phaseAcc = (((sampleStart - 1) * frequency) & AT5_FINE_PHASE_MASK) >>> 0;

  for (let sampleIndex = sampleStart; sampleIndex < sampleEnd; sampleIndex += 1) {
    phaseAcc = (phaseAcc + frequency) >>> 0;
    const phase = phaseAcc & AT5_FINE_PHASE_MASK;
    sinValues[sampleIndex] = AT5_SIN[phase] ?? 0;
    cosValues[sampleIndex] =
      AT5_SIN[(phase + AT5_FINE_COS_PHASE_OFFSET) & AT5_FINE_PHASE_MASK] ?? 0;
  }
}

function measureSinusoidComponent(
  samples,
  frequency,
  sampleStart,
  sampleEnd,
  residual,
  sinValues,
  cosValues
) {
  buildSinusoidBasis(frequency, sampleStart, sampleEnd, sinValues, cosValues);

  const span = (sampleEnd - sampleStart) | 0;
  const { dotSin, dotCos } = measureSinCosProjection(
    samples,
    sinValues,
    cosValues,
    sampleStart,
    sampleEnd
  );

  const phaseStartPrev = (((sampleStart - 1) * frequency) & AT5_FINE_PHASE_MASK) >>> 0;
  const phaseEnd = ((frequency * sampleEnd) & AT5_FINE_PHASE_MASK) >>> 0;
  const sinStep = AT5_SIN[frequency & AT5_FINE_PHASE_MASK] ?? 0;

  const { sinCoeff, cosCoeff } = solveSinusoidCoefficients({
    sinEnd: AT5_SIN[phaseEnd] ?? 0,
    sinStart: sinValues[sampleStart],
    cosEndPrev: cosValues[sampleEnd - 1],
    cosStartPrev: AT5_SIN[(phaseStartPrev + AT5_FINE_COS_PHASE_OFFSET) & AT5_FINE_PHASE_MASK] ?? 0,
    sinStep,
    sinStartPrev: AT5_SIN[phaseStartPrev] ?? 0,
    sinEndPrev: sinValues[sampleEnd - 1],
    span,
    dotSin,
    dotCos,
  });

  for (let sampleIndex = sampleStart; sampleIndex < sampleEnd; sampleIndex += 1) {
    const predicted = cosCoeff * cosValues[sampleIndex] + sinCoeff * sinValues[sampleIndex];
    residual[sampleIndex] = samples[sampleIndex] - predicted;
  }

  return {
    power: checkPowerLevelAt5F32(residual, residual, AT5_FINE_FRAME_SAMPLES),
    sinCoeff,
    cosCoeff,
  };
}

function measureFrequencyComponent(
  samples,
  frequency,
  sampleStart,
  sampleEnd,
  residual,
  sinValues,
  cosValues
) {
  residual.fill(0);
  if ((frequency | 0) === 0) {
    return { frequency: 0, ...measureDcComponent(samples, sampleStart, sampleEnd, residual) };
  }

  sinValues.fill(0);
  cosValues.fill(0);

  return {
    frequency: frequency | 0,
    ...measureSinusoidComponent(
      samples,
      frequency | 0,
      sampleStart,
      sampleEnd,
      residual,
      sinValues,
      cosValues
    ),
  };
}

function buildFineSearchCandidates(
  samples,
  peakBin,
  sampleStart,
  sampleEnd,
  residual,
  sinValues,
  cosValues
) {
  const baseFrequency = (peakBin | 0) * AT5_FINE_BIN_STRIDE;
  const searchStart = Math.max(baseFrequency - AT5_FINE_EDGE_OFFSET, 0);
  const searchEnd = Math.min(baseFrequency + AT5_FINE_EDGE_OFFSET, AT5_FINE_MAX_FREQUENCY);
  const candidates = [];

  for (let frequency = searchStart; frequency < searchEnd; frequency += AT5_FINE_SEARCH_STEP) {
    candidates.push(
      measureFrequencyComponent(
        samples,
        frequency,
        sampleStart,
        sampleEnd,
        residual,
        sinValues,
        cosValues
      )
    );
  }

  return candidates;
}

function rankFineSearchCandidates(candidates) {
  const values = new Float32Array(candidates.length);
  const order = new Int32Array(candidates.length);

  for (let index = 0; index < candidates.length; index += 1) {
    values[index] = candidates[index].power;
    order[index] = index;
  }

  shellSortDesc(values, order, candidates.length);
  return order;
}

function chooseOddFrequencyCandidate(
  samples,
  candidates,
  order,
  sampleStart,
  sampleEnd,
  residual,
  sinValues,
  cosValues
) {
  const candidateCount = candidates.length;
  const bestEvenRank = order[candidateCount - 1] | 0;
  const secondEvenRank = order[candidateCount - 2] | 0;
  const bestEvenFrequency = candidates[bestEvenRank].frequency | 0;

  let oddCandidate = measureFrequencyComponent(
    samples,
    secondEvenRank > bestEvenRank ? bestEvenFrequency + 1 : bestEvenFrequency - 1,
    sampleStart,
    sampleEnd,
    residual,
    sinValues,
    cosValues
  );

  if (bestEvenRank === candidateCount - 1) {
    const highOddCandidate = measureFrequencyComponent(
      samples,
      bestEvenFrequency + 1,
      sampleStart,
      sampleEnd,
      residual,
      sinValues,
      cosValues
    );
    if (oddCandidate.power > highOddCandidate.power) {
      oddCandidate = highOddCandidate;
    }
  }

  return oddCandidate;
}

function finalizeFineAnalysisResult(candidate) {
  const magnitude = Math.sqrt(
    candidate.sinCoeff * candidate.sinCoeff + candidate.cosCoeff * candidate.cosCoeff
  );
  // The legacy encoder stores the cosine coefficient as the phase numerator.
  const angle = Math.atan2(candidate.cosCoeff, candidate.sinCoeff);
  const encodedPhase =
    Math.floor((angle / AT5_PHASE_TWO_PI) * AT5_PHASE_SCALE + AT5_PHASE_BIAS) | 0;

  return {
    magnitude,
    phase: (encodedPhase + (candidate.frequency << 7)) & AT5_FINE_PHASE_MASK,
    frequency: candidate.frequency | 0,
  };
}

export function fineAnalysisAt5(samples, peakBin, sampleStartArg, sampleEndArg, work = null) {
  const sampleStart = sampleStartArg | 0;
  const sampleEnd = sampleEndArg | 0;
  const scratch = work && typeof work === "object" ? work : null;
  const residual = ensureF32(scratch?.fineResidual, AT5_FINE_COMPONENT_BUFFER_SIZE);
  const sinValues = ensureF32(scratch?.fineSinValues, AT5_FINE_COMPONENT_BUFFER_SIZE);
  const cosValues = ensureF32(scratch?.fineCosValues, AT5_FINE_COMPONENT_BUFFER_SIZE);
  if (scratch) {
    scratch.fineResidual = residual;
    scratch.fineSinValues = sinValues;
    scratch.fineCosValues = cosValues;
  }

  const candidates = buildFineSearchCandidates(
    samples,
    peakBin | 0,
    sampleStart,
    sampleEnd,
    residual,
    sinValues,
    cosValues
  );
  if (candidates.length === 0) {
    return null;
  }

  const order = rankFineSearchCandidates(candidates);
  const bestEvenCandidate = candidates[order[candidates.length - 1] | 0];
  const bestOddCandidate = chooseOddFrequencyCandidate(
    samples,
    candidates,
    order,
    sampleStart,
    sampleEnd,
    residual,
    sinValues,
    cosValues
  );

  return finalizeFineAnalysisResult(
    bestEvenCandidate.power > bestOddCandidate.power ? bestOddCandidate : bestEvenCandidate
  );
}
