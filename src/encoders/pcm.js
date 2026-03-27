import { CodecError } from "../common/errors.js";
import { assertInterleavedPcmInput, copyInterleavedPcmToPlanarF32 } from "../common/pcm-planar.js";
import { assertPositiveInteger } from "../common/pcm-planar-frame.js";
import { resolveAtracEncodeFactPlan } from "./fact.js";

/**
 * Computes the shared ATRAC lead-in padding needed to align authored PCM with
 * the codec's delayed output history.
 */
export function computeAtracEncodePadPlan(frameSamples, factParam, encoderDelaySamples) {
  assertPositiveInteger(frameSamples, "frameSamples");
  if (!Number.isInteger(factParam) || factParam < 0) {
    throw new CodecError(`invalid factParam: ${factParam}`);
  }
  if (!Number.isInteger(encoderDelaySamples) || encoderDelaySamples < 0) {
    throw new CodecError(`invalid encoderDelaySamples: ${encoderDelaySamples}`);
  }

  const alignedSampleCount = factParam - encoderDelaySamples;
  const alignedRemainder = alignedSampleCount % frameSamples;
  const normalizedRemainder =
    alignedRemainder < 0 ? alignedRemainder + frameSamples : alignedRemainder;
  // When the aligned count falls below zero, the encoders intentionally over-pad
  // by one frame and drop the first produced frame during flush. Normalizing
  // the remainder keeps pad planning in-bounds for copy offsets.
  const padSamples =
    normalizedRemainder === 0
      ? alignedSampleCount < frameSamples
        ? frameSamples
        : 0
      : frameSamples - normalizedRemainder;

  return {
    alignedSampleCount,
    padSamples,
    dropInitialOutputFrames: alignedSampleCount < frameSamples ? 1 : 0,
  };
}

/**
 * One fixed-size frame in the shared ATRAC encoder input plan.
 *
 * `sourceSampleOffset` and `sourceSampleCount` describe the copied window in
 * per-channel samples. `targetSampleOffset` is the destination offset inside
 * the staged fixed-size frame. `sampleCount` is the meaningful sample count
 * reported for that staged frame, which can be larger than the copied source
 * window for the synthetic leading frame that models encoder delay padding.
 *
 * @typedef {object} InterleavedPcmFramePlan
 * @property {number} sampleCount
 * @property {number} sourceSampleOffset
 * @property {number} sourceSampleCount
 * @property {number} targetSampleOffset
 */

/**
 * Delay-aware PCM planning request consumed by the shared ATRAC wrapper
 * staging helpers.
 *
 * @typedef {object} AtracEncodeInputPlanRequest
 * @property {Int16Array} pcmI16
 * @property {number} channels
 * @property {number} frameSamples
 * @property {number} factParam
 * @property {number} encoderDelaySamples
 */

/**
 * Resolves the optional synthetic lead-in frame that models the encoder's
 * delayed history before the contiguous PCM body starts.
 */
function resolveLeadInInterleavedFramePlan(totalSamples, frameSamples, padSamples) {
  if (padSamples <= 0) {
    return null;
  }

  return {
    sampleCount: frameSamples,
    sourceSampleOffset: 0,
    sourceSampleCount: Math.min(padSamples, totalSamples),
    targetSampleOffset: frameSamples - padSamples,
  };
}

/**
 * Resolves the contiguous body frames that follow any optional lead-in pad
 * frame in the shared ATRAC input plan.
 */
function createContiguousInterleavedFramePlans(totalSamples, frameSamples, startSampleOffset = 0) {
  const framePlans = [];

  for (
    let sourceSampleOffset = startSampleOffset;
    sourceSampleOffset < totalSamples;
    sourceSampleOffset += frameSamples
  ) {
    const sampleCount = Math.min(frameSamples, totalSamples - sourceSampleOffset);
    framePlans.push({
      sampleCount,
      sourceSampleOffset,
      sourceSampleCount: sampleCount,
      targetSampleOffset: 0,
    });
  }

  return framePlans;
}

/**
 * Builds the ATRAC wrapper PCM input plan used by both fixed-size interleaved
 * staging and delayed-output frame collection.
 */
export function createAtracEncodeInputPlan({
  pcmI16,
  channels,
  frameSamples,
  factParam,
  encoderDelaySamples,
}) {
  assertPositiveInteger(frameSamples, "frameSamples");
  assertInterleavedPcmInput(pcmI16, channels);

  const totalSamples = pcmI16.length / channels;
  const { padSamples, dropInitialOutputFrames } = computeAtracEncodePadPlan(
    frameSamples,
    factParam,
    encoderDelaySamples
  );
  const leadInFramePlan = resolveLeadInInterleavedFramePlan(totalSamples, frameSamples, padSamples);
  const contiguousStartSample = leadInFramePlan?.sourceSampleCount ?? 0;
  const bodyFramePlans = createContiguousInterleavedFramePlans(
    totalSamples,
    frameSamples,
    contiguousStartSample
  );
  const framePlans = leadInFramePlan ? [leadInFramePlan, ...bodyFramePlans] : bodyFramePlans;

  return {
    totalSamples,
    padSamples,
    dropInitialOutputFrames,
    framePlans,
  };
}

/**
 * Packs interleaved PCM into fixed-size staged frames while preserving the
 * meaningful sample count of each frame.
 */
export function stageInterleavedPcmFrames(pcmI16, channels, frameSamples, startSampleOffset = 0) {
  assertPositiveInteger(frameSamples, "frameSamples");
  assertInterleavedPcmInput(pcmI16, channels);

  const totalSamples = pcmI16.length / channels;
  if (
    !Number.isInteger(startSampleOffset) ||
    startSampleOffset < 0 ||
    startSampleOffset > totalSamples
  ) {
    throw new CodecError(`invalid startSampleOffset: ${startSampleOffset}`);
  }

  return stageInterleavedPcmFramePlans(
    pcmI16,
    channels,
    frameSamples,
    createContiguousInterleavedFramePlans(totalSamples, frameSamples, startSampleOffset)
  );
}

/**
 * Applies authored interleaved copy plans to fixed-size staged PCM frames.
 *
 * This owner keeps the full shared wrapper PCM story together: lead-in pad
 * planning, staged interleaved frame materialization, planar copy into codec
 * scratch, and delayed-output collection. The planner decides source and
 * target offsets, and this helper materializes the staged frames without
 * splitting that story across extra helper files.
 *
 * @param {Int16Array} pcmI16
 * @param {number} channels
 * @param {number} frameSamples
 * @param {InterleavedPcmFramePlan[]} framePlans
 * @returns {{ pcm: Int16Array, sampleCount: number }[]}
 */
export function stageInterleavedPcmFramePlans(pcmI16, channels, frameSamples, framePlans) {
  assertPositiveInteger(frameSamples, "frameSamples");
  assertInterleavedPcmInput(pcmI16, channels);
  if (!Array.isArray(framePlans)) {
    throw new CodecError("framePlans must be an array");
  }

  const stagedFrames = new Array(framePlans.length);

  for (const [index, framePlan] of framePlans.entries()) {
    const {
      sampleCount,
      sourceSampleOffset,
      sourceSampleCount,
      targetSampleOffset = 0,
    } = framePlan;
    const pcm = new Int16Array(frameSamples * channels);

    if (sourceSampleCount > 0) {
      const sourceStartWord = sourceSampleOffset * channels;
      pcm.set(
        pcmI16.subarray(sourceStartWord, sourceStartWord + sourceSampleCount * channels),
        targetSampleOffset * channels
      );
    }

    stagedFrames[index] = { pcm, sampleCount };
  }

  return stagedFrames;
}

export function splitInterleavedPcmFrames(pcmI16, channels, frameSamples) {
  const stagedFrames = stageInterleavedPcmFrames(pcmI16, channels, frameSamples);
  const pcmFrames = new Array(stagedFrames.length);

  for (const [index, { pcm }] of stagedFrames.entries()) {
    pcmFrames[index] = pcm;
  }

  return pcmFrames;
}

/**
 * Collects encoded ATRAC transport frames while applying the shared delayed
 * output rules used by the wrapper encoders.
 */
export function createAtracEncodeFrameCollector(runtime, dropInitialOutputFrames = 0) {
  if (!runtime || typeof runtime !== "object" || !Number.isInteger(runtime.frameIndex)) {
    throw new CodecError("runtime must expose an integer frameIndex");
  }
  if (!Number.isInteger(dropInitialOutputFrames) || dropInitialOutputFrames < 0) {
    throw new CodecError(`invalid dropInitialOutputFrames: ${dropInitialOutputFrames}`);
  }

  const encodedFrames = [];
  let warmupFramesToDrop = runtime.frameIndex === 0 ? 1 : 0;
  let delayedFramesToDrop = dropInitialOutputFrames;

  return {
    encodedFrames,
    collect(frame, dropDelayedOutput = false) {
      runtime.frameIndex += 1;
      if (warmupFramesToDrop > 0) {
        warmupFramesToDrop -= 1;
        return false;
      }
      if (dropDelayedOutput && delayedFramesToDrop > 0) {
        delayedFramesToDrop -= 1;
        return false;
      }

      encodedFrames.push(frame);
      return true;
    },
  };
}

/**
 * Builds the staged PCM frames consumed by the shared ATRAC encoder wrappers.
 *
 * This owner keeps one shared wrapper PCM story together: resolve the
 * delay-driven frame plan once, then materialize the staged interleaved frames
 * that the direct ATRAC wrappers consume.
 */
export function prepareAtracEncodePcmFrames(options) {
  const { pcmI16, channels, frameSamples, factParam, encoderDelaySamples } = options ?? {};
  const inputPlan = createAtracEncodeInputPlan({
    pcmI16,
    channels,
    frameSamples,
    factParam,
    encoderDelaySamples,
  });

  return {
    stagedFrames: stageInterleavedPcmFramePlans(
      pcmI16,
      channels,
      frameSamples,
      inputPlan.framePlans
    ),
    padSamples: inputPlan.padSamples,
    dropInitialOutputFrames: inputPlan.dropInitialOutputFrames,
  };
}

/**
 * Shared wrapper flow for ATRAC encoders that pad PCM according to the
 * profile's delay plan, copy it into planar scratch, and collect the delayed
 * transport output through a caller-provided frame encoder.
 *
 * The bridge from `framePlans` to `copyInterleavedPcmToPlanarF32()` stays
 * explicit here so readers can see how the authored interleaved staging plan
 * turns into one reusable planar scratch window per encode call.
 */
export function collectAtracEncodeFrames(
  pcmI16,
  {
    channels,
    profile,
    loopEnd = -1,
    maxOutputFrames = null,
    runtime = null,
    planarScratch,
    encodeFrame,
    frameCollector: providedCollector = null,
  }
) {
  if (typeof encodeFrame !== "function") {
    throw new CodecError("encodeFrame must be a function");
  }
  if (!Array.isArray(planarScratch)) {
    throw new CodecError("planarScratch must provide planar Float32Array channel buffers");
  }
  if (!Number.isInteger(loopEnd) || loopEnd < -1) {
    throw new CodecError(`invalid loopEnd: ${loopEnd}`);
  }
  const sourceTotalSamples = pcmI16.length / channels;
  if (loopEnd >= 0 && loopEnd >= sourceTotalSamples) {
    throw new CodecError(`loopEnd ${loopEnd} must be < totalSamples ${sourceTotalSamples}`);
  }

  const frameSamples = profile.frameSamples;
  const { encoderDelaySamples, factParam } = resolveAtracEncodeFactPlan(profile, loopEnd);
  const { totalSamples, dropInitialOutputFrames, framePlans } = createAtracEncodeInputPlan({
    pcmI16,
    channels,
    frameSamples,
    factParam,
    encoderDelaySamples,
  });
  const maxFrames =
    Number.isInteger(maxOutputFrames) && maxOutputFrames > 0 ? maxOutputFrames | 0 : null;
  /** @type {ReturnType<typeof createAtracEncodeFrameCollector>} */
  const frameCollector =
    providedCollector !== null && providedCollector !== undefined
      ? providedCollector
      : createAtracEncodeFrameCollector(runtime, dropInitialOutputFrames);
  if (
    !frameCollector ||
    typeof frameCollector !== "object" ||
    !Array.isArray(frameCollector.encodedFrames) ||
    typeof frameCollector.collect !== "function"
  ) {
    throw new CodecError("frameCollector must expose an encodedFrames array and collect() method");
  }
  const outputChannels = planarScratch.length;

  for (const framePlan of framePlans) {
    if (maxFrames !== null && frameCollector.encodedFrames.length >= maxFrames) {
      break;
    }
    const { sampleCount, sourceSampleOffset, sourceSampleCount, targetSampleOffset } = framePlan;

    copyInterleavedPcmToPlanarF32(pcmI16, channels, frameSamples, {
      outputChannels,
      scratch: planarScratch,
      packedSampleCount: sourceSampleCount * channels,
      sourceSampleOffset,
      targetSampleOffset,
    });
    frameCollector.collect(encodeFrame(sampleCount), true);
  }

  return { totalSamples, frameCollector };
}
