import { AT5_SFTBL_GHA, AT5_SIN } from "../tables/decode.js";
import { dftXAt5 } from "../dft.js";

import { fineAnalysisAt5 } from "./component.js";
import { checkPowerLevelAt5F32, findPeakBin, searchPairedScaleIndex } from "./util.js";

const AT5_SINE_FRAME_SAMPLES = 0x100;
const AT5_SINE_DFT_BINS = 0x81;
const AT5_SINE_SPECTRUM_SIZE = 0x84;
const AT5_SINE_ENTRY_WIDTH = 4;
const AT5_SINE_MAG_SCALE = 0.9169921875;
const AT5_SINE_MIN_DIRECT_SCALE = 0.5946044921875;
const AT5_SINE_PHASE_QUANTIZE_SCALE = 0.015625;
const AT5_SINE_PHASE_MASK = 0x7ff;

function ensureF32(value, length) {
  if (value instanceof Float32Array && value.length === length) {
    return value;
  }
  return new Float32Array(length);
}

function measureResidualPower(buffer, sampleStart, sampleEnd, sampleCount) {
  const window = buffer.subarray(sampleStart, sampleEnd);
  return checkPowerLevelAt5F32(window, window, sampleCount);
}

function findDominantResidualPeak(buffer, spectrum) {
  dftXAt5(buffer, AT5_SINE_FRAME_SAMPLES, spectrum, 0);
  return findPeakBin(spectrum, AT5_SINE_DFT_BINS);
}

function quantizeSineMagnitudeIndex(magnitude) {
  const scaledMagnitude = magnitude * AT5_SINE_MAG_SCALE;
  if (scaledMagnitude < AT5_SINE_MIN_DIRECT_SCALE) {
    return 0;
  }
  return searchPairedScaleIndex(AT5_SFTBL_GHA, 0x3f, scaledMagnitude);
}

function encodeSineEntry(entries, entryIndex, { magnitude, phase, frequency }) {
  const scaleIndex = quantizeSineMagnitudeIndex(magnitude);
  const quantizedPhase = (Math.floor(phase * AT5_SINE_PHASE_QUANTIZE_SCALE + 0.5) | 0) & 0x1f;
  const entryOffset = entryIndex * AT5_SINE_ENTRY_WIDTH;

  entries[entryOffset + 0] = scaleIndex >>> 0;
  entries[entryOffset + 2] = quantizedPhase >>> 0;
  entries[entryOffset + 3] = frequency >>> 0;

  return {
    magnitude: AT5_SFTBL_GHA[scaleIndex] ?? 0,
    phase: quantizedPhase << 6,
    frequency: frequency | 0,
  };
}

function subtractQuantizedSine(buffer, sampleStart, sampleEnd, { magnitude, phase, frequency }) {
  let phaseAcc = ((sampleStart - 0x81) * frequency + phase) | 0;

  for (let sampleIndex = sampleStart; sampleIndex < sampleEnd; sampleIndex += 1) {
    phaseAcc = (phaseAcc + frequency) | 0;
    buffer[sampleIndex] -= magnitude * (AT5_SIN[phaseAcc & AT5_SINE_PHASE_MASK] ?? 0);
  }
}

function sortSineEntriesByScale(entries, entryCount) {
  if ((entryCount | 0) < 2) {
    return;
  }

  const entryBuffer = new Uint32Array(AT5_SINE_ENTRY_WIDTH);
  for (let index = 1; index < entryCount; index += 1) {
    const entryOffset = index * AT5_SINE_ENTRY_WIDTH;
    entryBuffer.set(entries.subarray(entryOffset, entryOffset + AT5_SINE_ENTRY_WIDTH));

    let insertAt = index - 1;
    while (insertAt >= 0 && (entries[insertAt * AT5_SINE_ENTRY_WIDTH] | 0) > (entryBuffer[0] | 0)) {
      entries.copyWithin(
        (insertAt + 1) * AT5_SINE_ENTRY_WIDTH,
        insertAt * AT5_SINE_ENTRY_WIDTH,
        insertAt * AT5_SINE_ENTRY_WIDTH + AT5_SINE_ENTRY_WIDTH
      );
      insertAt -= 1;
    }

    entries.set(entryBuffer, (insertAt + 1) * AT5_SINE_ENTRY_WIDTH);
  }
}

export function analysisSineAt5Sub(src, state, initPeakBin, maxCount) {
  if (!state || typeof state !== "object") {
    return;
  }

  const entries = state.entries;
  if (!(entries instanceof Uint32Array)) {
    state.count = 0;
    return;
  }

  const sampleStart = state.start | 0;
  const sampleEnd = state.end | 0;
  const sampleCount = (sampleEnd - sampleStart) | 0;
  const scratch = state;
  const residual = ensureF32(scratch?.sineResidual, AT5_SINE_FRAME_SAMPLES);
  const spectrum = ensureF32(scratch?.sineSpectrum, AT5_SINE_SPECTRUM_SIZE);
  if (scratch) {
    scratch.sineResidual = residual;
    scratch.sineSpectrum = spectrum;
  }

  residual.fill(0);

  if (sampleCount > 0) {
    residual.set(src.subarray(sampleStart, sampleStart + sampleCount), sampleStart);
  }

  if ((initPeakBin | 0) === -1) {
    state.count = 0;
    return;
  }

  let power = measureResidualPower(residual, sampleStart, sampleEnd, sampleCount);
  let entryCount = 0;
  let peakBin = initPeakBin | 0;

  while (entryCount < (maxCount | 0)) {
    if (entryCount > 0) {
      peakBin = findDominantResidualPeak(residual, spectrum);
      if ((peakBin | 0) === -1) {
        break;
      }
    }

    const candidate = fineAnalysisAt5(residual, peakBin, sampleStart, sampleEnd, scratch);
    if (!candidate) {
      break;
    }

    const quantizedEntry = encodeSineEntry(entries, entryCount, candidate);
    subtractQuantizedSine(residual, sampleStart, sampleEnd, quantizedEntry);

    const nextPower = measureResidualPower(residual, sampleStart, sampleEnd, sampleCount);
    if (nextPower > power) {
      break;
    }

    power = nextPower;
    entryCount += 1;
  }

  state.count = entryCount;
  sortSineEntriesByScale(entries, entryCount);
}
