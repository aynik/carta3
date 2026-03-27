import { buildAtracWavBuffer } from "../container/wav-build.js";
import { createAtrac3ScxEncoderContext, isAtrac3ScxEncoderContext } from "../atrac3/scx/context.js";
import { at3ScxEncodeFrameFromPcm } from "../atrac3/scx/frame.js";
import { selectAtrac3ScxEncodeProfile } from "../atrac3/profiles.js";
import { CodecError } from "../common/errors.js";
import { assertInterleavedPcmInput, ensurePlanarF32Frame } from "../common/pcm-planar.js";
import { collectAtracEncodeFrames } from "./pcm.js";

const AT3_SCX_BITRATE_KBPS = 132;
const AT3_SCX_CHANNELS = 2;
const AT3_SCX_SAMPLE_RATE = 44100;
const AT3_FLUSH_SAMPLE_COUNT = 886;

/**
 * Public ATRAC3 SCX wrapper runtime carried across encode calls.
 *
 * @typedef {object} Atrac3ScxWrapperRuntime
 * @property {import("../atrac3/scx/context.js").Atrac3ScxEncoderContext} encoderContext
 * @property {number} frameIndex
 * @property {boolean} flushComplete
 * @property {Float32Array[] | null} planarScratch
 */

function isAtrac3ScxRuntime(runtime) {
  return (
    runtime &&
    typeof runtime === "object" &&
    Number.isInteger(runtime.frameIndex) &&
    typeof runtime.flushComplete === "boolean" &&
    isAtrac3ScxEncoderContext(runtime.encoderContext)
  );
}

function createAtrac3ScxWrapperRuntime(encoderContext) {
  return {
    encoderContext,
    frameIndex: 0,
    flushComplete: false,
    planarScratch: null,
  };
}

function resolveAtrac3ScxRuntime(context, profile) {
  /** @type {Atrac3ScxWrapperRuntime} */
  let runtime;

  if (isAtrac3ScxRuntime(context)) {
    runtime = context;
  } else if (isAtrac3ScxEncoderContext(context)) {
    runtime = createAtrac3ScxWrapperRuntime(context);
  } else {
    runtime = createAtrac3ScxWrapperRuntime(
      createAtrac3ScxEncoderContext(profile.bitrateKbps, profile.mode)
    );
  }

  runtime.planarScratch = ensurePlanarF32Frame(
    runtime.planarScratch,
    profile.channels,
    profile.frameSamples
  );

  return runtime;
}

function encodeAtrac3ScxRuntimeFrame(runtime, sampleCount) {
  const { encoderContext } = runtime;
  encoderContext.pcmLenHistory.copyWithin(1, 0, 2);
  encoderContext.pcmLenHistory[0] = sampleCount;

  const frame = at3ScxEncodeFrameFromPcm(runtime.planarScratch, encoderContext);
  if (!(frame instanceof Uint8Array)) {
    throw new CodecError("ATRAC3 SCX frame encode failed");
  }

  return frame;
}

function flushAtrac3ScxFrames(runtime, frameCollector) {
  while (!runtime.flushComplete) {
    for (const channel of runtime.planarScratch) {
      channel.fill(0);
    }

    frameCollector.collect(encodeAtrac3ScxRuntimeFrame(runtime, 0));
    runtime.flushComplete = runtime.encoderContext.pcmLenHistory[2] < AT3_FLUSH_SAMPLE_COUNT;
  }
}

/**
 * Encodes stereo 132 kbps ATRAC3 through the SCX encoder path.
 *
 * `context` may be either the wrapper runtime returned by a previous call or
 * the raw SCX encoder context when resuming an existing stream.
 */
export function encodeAtrac3ScxFramesFromInterleavedPcm(pcmI16, options = {}) {
  const {
    bitrateKbps = AT3_SCX_BITRATE_KBPS,
    channels = AT3_SCX_CHANNELS,
    sampleRate = AT3_SCX_SAMPLE_RATE,
    loopEnd = -1,
    context = null,
    profile: preselectedProfile = null,
  } = options ?? {};
  assertInterleavedPcmInput(pcmI16, channels);
  const profile = selectAtrac3ScxEncodeProfile(
    bitrateKbps,
    channels,
    sampleRate,
    preselectedProfile
  );
  const runtime = resolveAtrac3ScxRuntime(context, profile);
  const totalSamples = pcmI16.length / channels;
  const { frameCollector } = collectAtracEncodeFrames(pcmI16, {
    channels,
    profile,
    loopEnd,
    runtime,
    planarScratch: runtime.planarScratch,
    encodeFrame: (sampleCount) => encodeAtrac3ScxRuntimeFrame(runtime, sampleCount),
  });
  flushAtrac3ScxFrames(runtime, frameCollector);

  return {
    profile,
    encodedFrames: frameCollector.encodedFrames,
    totalSamples,
    context: runtime,
  };
}

export function encodeAtrac3ScxWavBufferFromInterleavedPcm(pcmI16, options = {}) {
  const { loopStart = -1, loopEnd = -1, factMode = 1 } = options ?? {};
  const result = encodeAtrac3ScxFramesFromInterleavedPcm(pcmI16, options);

  return {
    ...result,
    buffer: buildAtracWavBuffer({
      profile: result.profile,
      encodedFrames: result.encodedFrames,
      totalSamples: result.totalSamples,
      loopStart,
      loopEnd,
      factMode,
      validateTrim: true,
    }),
  };
}
