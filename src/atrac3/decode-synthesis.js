import { ATRAC3_FRAME_SAMPLES, ATRAC3_RESIDUAL_DELAY_SAMPLES } from "./constants.js";
import { AT3_DEC_CURVE_TABLE, AT3_DEC_TWO_PI_BITS } from "./decode-tables.js";
import { pcmI16FromF32Sample } from "../common/pcm-i16.js";

const EMPTY_I16 = new Int16Array(0);

const AT3_DEC_SYNTH_DELAY_OFFSET = ATRAC3_RESIDUAL_DELAY_SAMPLES;
const AT3_DEC_SYNTH_STATE_OFFSET = 0x2e;
const AT3_DEC_SYNTH_TAP_COUNT = 0x16;
const AT3_DEC_SYNTH_STATE_TAP_STRIDE = 4;
const AT3_DEC_SYNTH_OUTPUT_TAP_STRIDE = 2;

function seedAtrac3SynthesisStateTerms(stateTerms, work, delayBase, stateBase, twoPi) {
  const leftDifference = work[delayBase] - work[delayBase + 1];
  const leftSum = work[delayBase] + work[delayBase + 1];
  const rightDifference = work[delayBase + 3] - work[delayBase + 2];
  const rightSum = work[delayBase + 3] + work[delayBase + 2];

  work[delayBase] = leftDifference;
  work[delayBase + 1] = leftSum;
  work[delayBase + 2] = rightDifference;
  work[delayBase + 3] = rightSum;

  stateTerms[0] = leftDifference + work[stateBase] * twoPi;
  stateTerms[1] = leftSum * twoPi + work[stateBase + 1];
  stateTerms[2] = rightDifference + work[stateBase + 2] * twoPi;
  stateTerms[3] = rightSum * twoPi + work[stateBase + 3];
}

function accumulateAtrac3SynthesisTaps(terms, work, tapBase, tapStride) {
  for (
    let curveIndex = AT3_DEC_SYNTH_TAP_COUNT, mirrorIndex = 1;
    curveIndex >= 1;
    curveIndex -= 1, mirrorIndex += 1
  ) {
    const curve = AT3_DEC_CURVE_TABLE[curveIndex];
    const mirrorCurve = AT3_DEC_CURVE_TABLE[mirrorIndex];
    const sampleBase = tapBase + curveIndex * tapStride;
    terms[0] += curve * work[sampleBase];
    terms[1] += mirrorCurve * work[sampleBase + 1];
    terms[2] += curve * work[sampleBase + 2];
    terms[3] += mirrorCurve * work[sampleBase + 3];
  }
}

/** Runs the ATRAC3 synthesis filterbank over one channel's overlap/add work area. */
export function synthesizeAtrac3Channel(channelState) {
  const work = channelState.workF32;
  const twoPi = AT3_DEC_TWO_PI_BITS;
  const scratch = channelState.synthesisScratch;
  let stateTerms = scratch?.stateTerms;
  let outputTerms = scratch?.outputTerms;
  if (!Array.isArray(stateTerms) || stateTerms.length < 4) {
    stateTerms = [0, 0, 0, 0];
  }
  if (!Array.isArray(outputTerms) || outputTerms.length < 4) {
    outputTerms = [0, 0, 0, 0];
  }
  if (scratch && typeof scratch === "object") {
    scratch.stateTerms = stateTerms;
    scratch.outputTerms = outputTerms;
  } else {
    channelState.synthesisScratch = { stateTerms, outputTerms };
  }

  for (let base = 0; base < ATRAC3_FRAME_SAMPLES; base += 4) {
    const delayBase = base + AT3_DEC_SYNTH_DELAY_OFFSET;
    const stateBase = base + AT3_DEC_SYNTH_STATE_OFFSET;
    seedAtrac3SynthesisStateTerms(stateTerms, work, delayBase, stateBase, twoPi);

    // The 22 synthesis history taps live in the same work buffer immediately
    // after the four state slots. The same descending tap traversal also
    // drives the final output accumulation below, so keep that walk in one
    // helper instead of spelling it twice.
    accumulateAtrac3SynthesisTaps(stateTerms, work, stateBase, AT3_DEC_SYNTH_STATE_TAP_STRIDE);

    const leftDifference = stateTerms[0];
    const leftSum = stateTerms[1];
    const rightDifference = stateTerms[2];
    const rightSum = stateTerms[3];
    const diff = leftDifference - rightDifference;
    const mix = leftDifference + rightDifference;
    const spread = leftSum - rightSum;
    const sum = leftSum + rightSum;
    work[stateBase] = diff;
    work[stateBase + 1] = mix;
    work[stateBase + 2] = spread;
    work[stateBase + 3] = sum;

    outputTerms[0] = work[base] * twoPi + diff;
    outputTerms[1] = mix * twoPi + work[base + 1];
    outputTerms[2] = spread + work[base + 2] * twoPi;
    outputTerms[3] = sum * twoPi + work[base + 3];
    accumulateAtrac3SynthesisTaps(outputTerms, work, base, AT3_DEC_SYNTH_OUTPUT_TAP_STRIDE);

    work[base] = outputTerms[0];
    work[base + 1] = outputTerms[1];
    work[base + 2] = outputTerms[2];
    work[base + 3] = outputTerms[3];
  }
}

function writeAtrac3StereoPcmRange(
  primaryChannel,
  secondaryChannel,
  pcm,
  pcmOffset,
  startSample,
  sampleCount
) {
  const primary = primaryChannel.workF32;
  const secondary = secondaryChannel.workF32;
  const start = startSample | 0;
  const end = start + (sampleCount | 0);
  let out = pcmOffset | 0;

  for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
    pcm[out] = pcmI16FromF32Sample(primary[sampleIndex]);
    pcm[out + 1] = pcmI16FromF32Sample(secondary[sampleIndex]);
    out += 2;
  }
}

/** Packs the synthesized ATRAC3 left/right work buffers into stereo PCM. */
export function buildAtrac3StereoPcm(
  primaryChannel,
  secondaryChannel,
  pcm = null,
  pcmOffset = 0,
  startSample = 0,
  sampleCount = ATRAC3_FRAME_SAMPLES
) {
  const count = sampleCount | 0;
  if (count <= 0) {
    return pcm instanceof Int16Array ? pcm : EMPTY_I16;
  }

  const out = pcm instanceof Int16Array ? pcm : new Int16Array(count * 2);

  const offset = pcm instanceof Int16Array ? pcmOffset | 0 : 0;
  writeAtrac3StereoPcmRange(primaryChannel, secondaryChannel, out, offset, startSample, count);
  return out;
}
