import assert from "node:assert/strict";
import test from "node:test";

import { applySynthesisFilterbank } from "../../../src/atrac3plus/synthesis-filterbank.js";
import { ATX_DECODE_COEFF } from "../../../src/atrac3plus/tables/decode.js";

const ATX_SYNTHESIS_SUBBANDS = 16;
const ATX_SUBBAND_SAMPLES = 128;
const ATX_FRAME_SAMPLES = 2048;
const ATX_RING_ROWS = 24;
const ATX_DELAY_PHASES = 8;
const ATX_SYNTHESIS_TAPS = 12;

const coeffA = ATX_DECODE_COEFF.subarray(0x000 / 4, 0x200 / 4);
const coeffB = ATX_DECODE_COEFF.subarray(0x200 / 4, 0x400 / 4);
const coeffC = ATX_DECODE_COEFF.subarray(0x400 / 4, 0x700 / 4);
const coeffS = ATX_DECODE_COEFF.subarray(0x700 / 4);

function createChannelRuntime() {
  return {
    blockBuffers: Array.from({ length: ATX_SYNTHESIS_SUBBANDS }, (_, subband) =>
      Float32Array.from({ length: ATX_SUBBAND_SAMPLES }, (_, sampleIndex) => {
        const seed = ((subband + 3) * 17 + sampleIndex * 13) % 127;
        return (seed - 63) / 16;
      })
    ),
    delayA: Float32Array.from({ length: ATX_RING_ROWS * ATX_DELAY_PHASES }, (_, index) => {
      const seed = (index * 7) % 41;
      return (seed - 20) / 32;
    }),
    delayB: Float32Array.from({ length: ATX_RING_ROWS * ATX_DELAY_PHASES }, (_, index) => {
      const seed = (index * 11) % 53;
      return (seed - 26) / 32;
    }),
    ringIndex: 7,
    outPcm: Float32Array.from({ length: ATX_FRAME_SAMPLES }, (_, index) => (index % 5) - 2),
  };
}

function cloneChannelRuntime(channelRuntime) {
  return {
    blockBuffers: channelRuntime.blockBuffers.map((band) => Float32Array.from(band)),
    delayA: Float32Array.from(channelRuntime.delayA),
    delayB: Float32Array.from(channelRuntime.delayB),
    ringIndex: channelRuntime.ringIndex,
    outPcm: Float32Array.from(channelRuntime.outPcm),
  };
}

function applyReferenceSynthesisFilterbank(channelRuntime) {
  const blockBuffers = channelRuntime.blockBuffers;
  const delayA = channelRuntime.delayA;
  const delayB = channelRuntime.delayB;
  const outPcm = channelRuntime.outPcm;

  outPcm.fill(0);
  let ringIndex = channelRuntime.ringIndex | 0;

  for (let sampleIndex = 0; sampleIndex < ATX_SUBBAND_SAMPLES; sampleIndex += 1) {
    for (let phase = 0; phase < ATX_DELAY_PHASES; phase += 1) {
      let sumA = 0;
      let sumB = 0;
      const coeffOffset = phase * ATX_SYNTHESIS_SUBBANDS;

      for (let subband = 0; subband < ATX_SYNTHESIS_SUBBANDS; subband += 1) {
        const sample = blockBuffers[subband][sampleIndex];
        sumA += coeffA[coeffOffset + subband] * sample;
        sumB += sample * coeffB[coeffOffset + subband];
      }

      delayA[ringIndex * ATX_DELAY_PHASES + phase] = sumA;
      delayB[ringIndex * ATX_DELAY_PHASES + phase] = sumB;
    }

    const outBase = sampleIndex * ATX_SYNTHESIS_SUBBANDS;
    for (let tapIndex = 0; tapIndex < ATX_SYNTHESIS_TAPS; tapIndex += 1) {
      const idxA = (((ringIndex + tapIndex * 2) % ATX_RING_ROWS) * ATX_DELAY_PHASES) | 0;
      const idxB = (((ringIndex + tapIndex * 2 + 1) % ATX_RING_ROWS) * ATX_DELAY_PHASES) | 0;

      for (let phase = 0; phase < ATX_DELAY_PHASES; phase += 1) {
        const coeffIndex = tapIndex * ATX_SYNTHESIS_SUBBANDS + phase;
        outPcm[outBase + phase] +=
          delayA[idxA + phase] * coeffC[coeffIndex] + delayB[idxB + phase] * coeffS[coeffIndex];
      }
      for (let phase = 8; phase < ATX_SYNTHESIS_SUBBANDS; phase += 1) {
        const sourcePhase = 15 - phase;
        const coeffIndex = tapIndex * ATX_SYNTHESIS_SUBBANDS + phase;
        outPcm[outBase + phase] +=
          delayA[idxA + sourcePhase] * coeffC[coeffIndex] +
          delayB[idxB + sourcePhase] * coeffS[coeffIndex];
      }
    }

    ringIndex = ringIndex === 0 ? ATX_RING_ROWS - 1 : ringIndex - 1;
  }

  channelRuntime.ringIndex = ringIndex >>> 0;
}

test("applySynthesisFilterbank preserves PCM, delay rows, and ring position", () => {
  const expected = createChannelRuntime();
  const actual = cloneChannelRuntime(expected);

  applyReferenceSynthesisFilterbank(expected);
  applySynthesisFilterbank(actual);

  assert.equal(actual.ringIndex, expected.ringIndex);
  assert.deepEqual(Array.from(actual.outPcm), Array.from(expected.outPcm));
  assert.deepEqual(Array.from(actual.delayA), Array.from(expected.delayA));
  assert.deepEqual(Array.from(actual.delayB), Array.from(expected.delayB));
});
