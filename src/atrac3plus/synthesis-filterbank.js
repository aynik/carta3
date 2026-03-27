import { ATX_DECODE_COEFF } from "./tables/decode.js";

const ATX_SYNTHESIS_SUBBANDS = 16;
const ATX_SUBBAND_SAMPLES = 128;
const ATX_PCM_STRIDE = 16;
const ATX_DELAY_PHASES = 8;
const ATX_RING_ROWS = 24;
const ATX_SYNTHESIS_TAPS = 12;

const coeffA = ATX_DECODE_COEFF.subarray(0x000 / 4, 0x200 / 4);
const coeffB = ATX_DECODE_COEFF.subarray(0x200 / 4, 0x400 / 4);
const coeffC = ATX_DECODE_COEFF.subarray(0x400 / 4, 0x700 / 4);
const coeffS = ATX_DECODE_COEFF.subarray(0x700 / 4);

function writeSynthesisDelayRow(blockBuffers, sampleIndex, delayA, delayB, ringIndex) {
  const delayOffset = (ringIndex | 0) * ATX_DELAY_PHASES;

  for (let phase = 0; phase < ATX_DELAY_PHASES; phase += 1) {
    const coeffOffset = phase * ATX_SYNTHESIS_SUBBANDS;
    let sumA = 0;
    let sumB = 0;

    for (let subband = 0; subband < ATX_SYNTHESIS_SUBBANDS; subband += 1) {
      const sample = blockBuffers[subband][sampleIndex];
      sumA += coeffA[coeffOffset + subband] * sample;
      sumB += coeffB[coeffOffset + subband] * sample;
    }

    delayA[delayOffset + phase] = sumA;
    delayB[delayOffset + phase] = sumB;
  }
}

function delayRowOffset(ringIndex, tapIndex, rowBias) {
  const row = ((ringIndex | 0) + (tapIndex | 0) * 2 + (rowBias | 0)) % ATX_RING_ROWS;
  return row * ATX_DELAY_PHASES;
}

function accumulateSynthesisHalf(
  outPcm,
  outBase,
  delayA,
  delayB,
  delayOffsetA,
  delayOffsetB,
  coeffOffset,
  reverseSource
) {
  const outputBase = reverseSource ? outBase + ATX_DELAY_PHASES : outBase;
  const coeffBase = reverseSource ? coeffOffset + ATX_DELAY_PHASES : coeffOffset;

  for (let phase = 0; phase < ATX_DELAY_PHASES; phase += 1) {
    const sourcePhase = reverseSource ? ATX_DELAY_PHASES - 1 - phase : phase;
    outPcm[outputBase + phase] +=
      delayA[delayOffsetA + sourcePhase] * coeffC[coeffBase + phase] +
      delayB[delayOffsetB + sourcePhase] * coeffS[coeffBase + phase];
  }
}

function accumulateSynthesisTaps(outPcm, outBase, delayA, delayB, ringIndex) {
  for (let tapIndex = 0; tapIndex < ATX_SYNTHESIS_TAPS; tapIndex += 1) {
    const coeffOffset = tapIndex * ATX_PCM_STRIDE;
    const delayOffsetA = delayRowOffset(ringIndex, tapIndex, 0);
    const delayOffsetB = delayRowOffset(ringIndex, tapIndex, 1);

    accumulateSynthesisHalf(
      outPcm,
      outBase,
      delayA,
      delayB,
      delayOffsetA,
      delayOffsetB,
      coeffOffset,
      false
    );
    accumulateSynthesisHalf(
      outPcm,
      outBase,
      delayA,
      delayB,
      delayOffsetA,
      delayOffsetB,
      coeffOffset,
      true
    );
  }
}

function previousRingRow(ringIndex) {
  return ringIndex === 0 ? ATX_RING_ROWS - 1 : ringIndex - 1;
}

export function applySynthesisFilterbank(channelRuntime) {
  const { blockBuffers, delayA, delayB, outPcm } = channelRuntime;

  outPcm.fill(0);
  let ringIndex = channelRuntime.ringIndex | 0;

  for (let sampleIndex = 0; sampleIndex < ATX_SUBBAND_SAMPLES; sampleIndex += 1) {
    writeSynthesisDelayRow(blockBuffers, sampleIndex, delayA, delayB, ringIndex);
    accumulateSynthesisTaps(outPcm, sampleIndex * ATX_PCM_STRIDE, delayA, delayB, ringIndex);
    ringIndex = previousRingRow(ringIndex);
  }

  channelRuntime.ringIndex = ringIndex >>> 0;
}
