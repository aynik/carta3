import { buildAtracWavBuffer } from "../container/wav-build.js";
import {
  createAtrac3EncoderState,
  isAtrac3Algorithm0EncoderState,
} from "../atrac3/encode-runtime.js";
import { encodeAtrac3Algorithm0Frame } from "../atrac3/frame.js";
import { selectAtrac3Algorithm0EncodeProfile } from "../atrac3/profiles.js";
import { CodecError } from "../common/errors.js";
import { assertInterleavedPcmInput, ensurePlanarF32Frame } from "../common/pcm-planar.js";
import { collectAtracEncodeFrames } from "./pcm.js";

const AT3_ALGO0_DEFAULT_BITRATE_KBPS = 66;
const AT3_ALGO0_SUPPORTED_CHANNELS = 2;
const AT3_ALGO0_SUPPORTED_SAMPLE_RATE = 44100;
const AT3_ALGO0_FLUSH_CALLS = 3;
// Tiny non-zero fill used during flush frames to preserve the current encode
// baselines. (`-0x1.1432aap-41` as float32.)
const AT3_ALGO0_FLUSH_FILL_F32 = Math.fround(-5.26504729571331e-13);

/**
 * Public ATRAC3 algorithm-0 wrapper runtime carried across encode calls.
 *
 * @typedef {object} Atrac3Algorithm0WrapperRuntime
 * @property {import("../atrac3/encode-runtime.js").Atrac3Algorithm0EncoderState} encoderState
 * @property {number} frameIndex
 * @property {Float32Array[] | null} planarScratch
 */

function isAtrac3Algorithm0Runtime(runtime) {
  return (
    runtime &&
    typeof runtime === "object" &&
    Number.isInteger(runtime.frameIndex) &&
    isAtrac3Algorithm0EncoderState(runtime.encoderState)
  );
}

function createAtrac3Algorithm0WrapperRuntime(encoderState) {
  return {
    encoderState,
    frameIndex: 0,
    planarScratch: null,
  };
}

function resolveAtrac3Algorithm0Runtime(context, profile) {
  /** @type {Atrac3Algorithm0WrapperRuntime} */
  let runtime;
  const expectedBytesPerLayer = profile.frameBytes / 2;

  if (isAtrac3Algorithm0Runtime(context)) {
    if (context.encoderState.bytesPerLayer !== expectedBytesPerLayer) {
      throw new CodecError(
        `ATRAC3 encode context mismatch: expected frameBytes=${profile.frameBytes}, ` +
          `got frameBytes=${context.encoderState.bytesPerLayer * 2}`
      );
    }
    runtime = context;
  } else if (isAtrac3Algorithm0EncoderState(context)) {
    if (context.bytesPerLayer !== expectedBytesPerLayer) {
      throw new CodecError(
        `ATRAC3 encode context mismatch: expected frameBytes=${profile.frameBytes}, ` +
          `got frameBytes=${context.bytesPerLayer * 2}`
      );
    }
    runtime = createAtrac3Algorithm0WrapperRuntime(context);
  } else {
    runtime = createAtrac3Algorithm0WrapperRuntime(createAtrac3EncoderState(profile).state);
  }

  runtime.planarScratch = ensurePlanarF32Frame(
    runtime.planarScratch,
    profile.channels,
    profile.frameSamples
  );

  return runtime;
}

function flushAtrac3Algorithm0Frames(runtime, frameCollector) {
  for (let flushIndex = 0; flushIndex < AT3_ALGO0_FLUSH_CALLS; flushIndex += 1) {
    for (const channel of runtime.planarScratch) {
      channel.fill(AT3_ALGO0_FLUSH_FILL_F32);
    }

    frameCollector.collect(
      encodeAtrac3Algorithm0Frame(runtime.planarScratch, runtime.encoderState)
    );
  }
}

/**
 * Encodes stereo ATRAC3 algorithm-0 frames from interleaved PCM.
 *
 * `context` may be either the wrapper runtime returned by a previous call or
 * the raw ATRAC3 algorithm-0 encoder state when resuming an existing stream.
 */
export function encodeAtrac3FramesFromInterleavedPcm(pcmI16, options = {}) {
  const {
    bitrateKbps = AT3_ALGO0_DEFAULT_BITRATE_KBPS,
    channels = AT3_ALGO0_SUPPORTED_CHANNELS,
    sampleRate = AT3_ALGO0_SUPPORTED_SAMPLE_RATE,
    loopEnd = -1,
    context = null,
    profile: preselectedProfile = null,
  } = options ?? {};
  assertInterleavedPcmInput(pcmI16, channels);
  const profile = selectAtrac3Algorithm0EncodeProfile(
    bitrateKbps,
    channels,
    sampleRate,
    preselectedProfile
  );
  const runtime = resolveAtrac3Algorithm0Runtime(context, profile);
  const totalSamples = pcmI16.length / channels;
  const { frameCollector } = collectAtracEncodeFrames(pcmI16, {
    channels,
    profile,
    loopEnd,
    runtime,
    planarScratch: runtime.planarScratch,
    encodeFrame: () => encodeAtrac3Algorithm0Frame(runtime.planarScratch, runtime.encoderState),
  });
  flushAtrac3Algorithm0Frames(runtime, frameCollector);

  return {
    profile,
    encodedFrames: frameCollector.encodedFrames,
    totalSamples,
    context: runtime,
  };
}

export function encodeAtrac3WavBufferFromInterleavedPcm(pcmI16, options = {}) {
  const { loopStart = -1, loopEnd = -1, factMode = 1 } = options ?? {};
  const result = encodeAtrac3FramesFromInterleavedPcm(pcmI16, options);

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
