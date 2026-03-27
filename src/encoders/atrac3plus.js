import {
  analyzeAtrac3plusRuntimeFrame,
  encodeAtrac3plusRuntimeFrame,
  normalizeAtrac3plusEncodeRuntime,
} from "../atrac3plus/codec.js";
import { selectAtrac3plusEncodeProfile } from "../atrac3plus/profiles.js";
import { CodecError } from "../common/errors.js";
import {
  assertInterleavedPcmInput,
  copyInterleavedPcmToPlanarF32,
  ensurePlanarF32Frame,
} from "../common/pcm-planar.js";
import { collectAtracEncodeFrames } from "./pcm.js";

const ATX_DEFAULT_BITRATE_KBPS = 96;
const ATX_DEFAULT_CHANNELS = 2;
const ATX_DEFAULT_SAMPLE_RATE = 44100;

/**
 * Resolves one public ATRAC3plus wrapper run around the codec-owned runtime.
 *
 * This owner keeps profile selection, runtime normalization, planar scratch
 * sizing, encode/debug flow, and flush emission together instead of routing
 * through a one-off adapter file.
 */
function resolveAtrac3plusRun(
  pcmI16,
  { bitrateKbps, channels, sampleRate, encodeMode, context, profile: preselectedProfile = null }
) {
  assertInterleavedPcmInput(pcmI16, channels);
  const profile = selectAtrac3plusEncodeProfile(
    bitrateKbps,
    channels,
    sampleRate,
    preselectedProfile
  );
  const runtime = normalizeAtrac3plusEncodeRuntime(context, {
    bitrateKbps,
    frameBytes: profile.frameBytes,
    mode: profile.mode,
    sampleRate,
    inputChannels: channels,
    encodeMode,
  });
  runtime.planarScratch = ensurePlanarF32Frame(
    runtime.planarScratch,
    Math.max(channels, runtime.handle.streamChannels),
    profile.frameSamples
  );

  return {
    profile,
    runtime,
    totalSamples: pcmI16.length / channels,
  };
}

function copyAtrac3plusInputFrame(
  pcmI16,
  channels,
  profile,
  runtime,
  sourceSampleOffset,
  sampleCount
) {
  return copyInterleavedPcmToPlanarF32(pcmI16, channels, profile.frameSamples, {
    outputChannels: runtime.planarScratch.length,
    scratch: runtime.planarScratch,
    packedSampleCount: sampleCount * channels,
    sourceSampleOffset,
  });
}

function prepareAtrac3plusFlushFrame(runtime, frameSamples) {
  if (runtime.handle.flushFramesRemaining === 0) {
    return runtime.zeroPlanar;
  }

  const zeroPlanar = ensurePlanarF32Frame(
    runtime.zeroPlanar,
    runtime.planarScratch.length,
    frameSamples
  );
  runtime.zeroPlanar = zeroPlanar;
  for (const channel of zeroPlanar) {
    channel.fill(0);
  }

  return zeroPlanar;
}

function appendAtrac3plusDebugFrame(debugFrames, runtime, outputFrameIndex) {
  if (!debugFrames) {
    return;
  }

  debugFrames.push({
    outputFrameIndex,
    ...(runtime.lastEncodeDebug ?? {}),
  });
}

/**
 * Analyze ATRAC3plus frame signal-processing state without packing output frames.
 */
export function analyzeAtrac3plusFramesFromInterleavedPcm(pcmI16, options = {}) {
  const {
    bitrateKbps = ATX_DEFAULT_BITRATE_KBPS,
    channels = ATX_DEFAULT_CHANNELS,
    sampleRate = ATX_DEFAULT_SAMPLE_RATE,
    encodeMode = 0,
    context = null,
    profile: preselectedProfile = null,
  } = options ?? {};
  const { profile, runtime, totalSamples } = resolveAtrac3plusRun(pcmI16, {
    bitrateKbps,
    channels,
    sampleRate,
    encodeMode,
    context,
    profile: preselectedProfile,
  });
  const frameAnalyses = [];

  for (
    let sourceSampleOffset = 0;
    sourceSampleOffset < totalSamples;
    sourceSampleOffset += profile.frameSamples
  ) {
    const sampleCount = Math.min(profile.frameSamples, totalSamples - sourceSampleOffset);
    const planar = copyAtrac3plusInputFrame(
      pcmI16,
      channels,
      profile,
      runtime,
      sourceSampleOffset,
      sampleCount
    );
    const sigproc = analyzeAtrac3plusRuntimeFrame(runtime, planar, sampleCount);
    frameAnalyses.push({
      frameIndex: runtime.frameIndex | 0,
      blockResults: sigproc.blockResults.map((block) => ({
        blockIndex: block.blockIndex,
        channels: block.channels,
        bandCount: block.bandCount,
      })),
    });
    runtime.frameIndex += 1;
  }

  return {
    profile,
    totalSamples,
    processedFrames: frameAnalyses.length,
    frameAnalyses,
    context: runtime,
  };
}

/**
 * Encode interleaved PCM into ATRAC3plus frames, including encoder delay and flush output.
 */
export function encodeAtrac3plusFramesFromInterleavedPcm(pcmI16, options = {}) {
  const {
    bitrateKbps = ATX_DEFAULT_BITRATE_KBPS,
    channels = ATX_DEFAULT_CHANNELS,
    sampleRate = ATX_DEFAULT_SAMPLE_RATE,
    encodeMode = 0,
    useExactQuant = true,
    loopEnd = -1,
    maxOutputFrames = null,
    collectDebug = false,
    context = null,
    profile: preselectedProfile = null,
  } = options ?? {};
  const { profile, runtime, totalSamples } = resolveAtrac3plusRun(pcmI16, {
    channels,
    sampleRate,
    bitrateKbps,
    encodeMode,
    context,
    profile: preselectedProfile,
  });
  if (!Number.isInteger(loopEnd) || loopEnd < -1) {
    throw new CodecError(`invalid loopEnd: ${loopEnd}`);
  }
  if (loopEnd >= 0 && loopEnd >= totalSamples) {
    throw new CodecError(`loopEnd ${loopEnd} must be < totalSamples ${totalSamples}`);
  }

  const debugFrames = collectDebug ? [] : null;
  const encodeOptions = { useExactQuant };
  const maxFrames =
    Number.isInteger(maxOutputFrames) && maxOutputFrames > 0 ? maxOutputFrames : null;
  const zeroPlanar = prepareAtrac3plusFlushFrame(runtime, profile.frameSamples);
  const encodedFrames = [];
  const frameCollector = {
    encodedFrames,
    collect(frame) {
      if (!frame) {
        return false;
      }
      if (maxFrames !== null && encodedFrames.length >= maxFrames) {
        return false;
      }

      encodedFrames.push(frame);
      appendAtrac3plusDebugFrame(debugFrames, runtime, encodedFrames.length - 1);
      return true;
    },
  };

  collectAtracEncodeFrames(pcmI16, {
    channels,
    profile,
    loopEnd,
    maxOutputFrames: maxFrames,
    planarScratch: runtime.planarScratch,
    encodeFrame: (sampleCount) =>
      encodeAtrac3plusRuntimeFrame(runtime, runtime.planarScratch, sampleCount, encodeOptions),
    frameCollector,
  });

  while (
    (maxFrames === null || encodedFrames.length < maxFrames) &&
    runtime.handle.flushFramesRemaining > 0
  ) {
    runtime.handle.flushFramesRemaining = (runtime.handle.flushFramesRemaining - 1) >>> 0;
    const packed = encodeAtrac3plusRuntimeFrame(runtime, zeroPlanar, 0, encodeOptions);
    if (!packed) {
      continue;
    }

    frameCollector.collect(packed);
  }

  return {
    profile,
    encodedFrames,
    totalSamples,
    context: runtime,
    debug: debugFrames ? { frames: debugFrames } : null,
  };
}
