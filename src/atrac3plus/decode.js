import { backwardTransformAt5, createAt5GaincBlock, synthesisWavAt5 } from "./dsp.js";
import {
  sharedNoiseFillCursor,
  sharedNoiseFillEnabled,
  sharedNoiseFillShift,
} from "./shared-fields.js";
import { AT5_RNDTBL, AT5_WIN, ATX_DECODE_RND_IDX_TABLE } from "./tables/decode.js";
import { reconstructBlockSpectra } from "./decode-spectrum.js";
import {
  createAt5GhSlotSynthesisState,
  resolveGhBandSynthesisState,
  shouldApplyCurrentGhOverlapWindow,
  shouldApplyPreviousGhOverlapWindow,
} from "./gh-synthesis.js";
import { applySynthesisFilterbank } from "./synthesis-filterbank.js";
import { pcmI16FromF32Sample } from "../common/pcm-i16.js";
import { ATRAC3PLUS_FRAME_SAMPLES } from "./constants.js";

const ATX_SUBBAND_BLOCKS = 16;
const ATX_SUBBAND_SAMPLES = 128;
const ATX_FRAME_SAMPLES = ATRAC3PLUS_FRAME_SAMPLES;
const ATX_SYNTHESIS_RING_ROWS = 24;
const ATX_SYNTHESIS_PHASES = 8;

function createRuntimeChannel() {
  return {
    prevGainBlocks: Array.from({ length: ATX_SUBBAND_BLOCKS }, () => createAt5GaincBlock()),
    currGainBlocks: Array.from({ length: ATX_SUBBAND_BLOCKS }, () => createAt5GaincBlock()),
    blockBuffers: Array.from(
      { length: ATX_SUBBAND_BLOCKS },
      () => new Float32Array(ATX_SUBBAND_SAMPLES)
    ),
    overlap: new Float32Array(ATX_FRAME_SAMPLES),
    delayA: new Float32Array(ATX_SYNTHESIS_RING_ROWS * ATX_SYNTHESIS_PHASES),
    delayB: new Float32Array(ATX_SYNTHESIS_RING_ROWS * ATX_SYNTHESIS_PHASES),
    ringIndex: 0,
    outPcm: new Float32Array(ATX_FRAME_SAMPLES),
    synA: new Float32Array(ATX_SUBBAND_SAMPLES),
    synB: new Float32Array(ATX_SUBBAND_SAMPLES),
    ghSynthSlots: [createAt5GhSlotSynthesisState(), createAt5GhSlotSynthesisState()],
  };
}

function createRuntimeBlock(block) {
  const channelCount = block.regularBlock?.channels?.length ?? 0;
  return {
    spectra: Array.from({ length: channelCount }, () => new Float32Array(ATX_FRAME_SAMPLES)),
    channels: Array.from({ length: channelCount }, () => createRuntimeChannel()),
  };
}

function ensureDecodeRuntime(handle) {
  if (handle.decodeRuntime) {
    return handle.decodeRuntime;
  }

  const streamChannels = handle.streamChannels | 0;
  const runtime = {
    blocks: Array.from({ length: handle.blockCount | 0 }, (_, index) =>
      createRuntimeBlock(handle.blocks[index])
    ),
    framePlanes: Array.from({ length: streamChannels }, () => new Float32Array(ATX_FRAME_SAMPLES)),
  };

  handle.decodeRuntime = runtime;
  return runtime;
}

function applyWindow(samples, windowOffset) {
  for (let i = 0; i < ATX_SUBBAND_SAMPLES; i += 1) {
    samples[i] *= AT5_WIN[windowOffset + i];
  }
}

function applyGhSynthesis(blockBuffers, channel, ghShared, flipMode, channelRuntime) {
  const slotIndex = ghShared.slotIndex & 1;
  const prevHeader = ghShared.headers[slotIndex ^ 1];
  const currHeader = ghShared.headers[slotIndex];
  const modePrev = prevHeader?.mode | 0;
  const modeCurr = currHeader?.mode | 0;
  const entriesPrev = channel.gh.slots[slotIndex ^ 1].entries;
  const entriesCurr = channel.gh.slots[slotIndex].entries;
  const synthPrev = channelRuntime.ghSynthSlots[slotIndex ^ 1];
  const synthCurr = channelRuntime.ghSynthSlots[slotIndex];
  const synA = channelRuntime.synA;
  const synB = channelRuntime.synB;

  for (let block = 0; block < ATX_SUBBAND_BLOCKS; block += 1) {
    const previousEntry = entriesPrev[block];
    const currentEntry = entriesCurr[block];
    const previousSynth = synthPrev[block];
    const currentSynth = resolveGhBandSynthesisState(previousEntry, currentEntry, synthCurr[block]);

    const countA = previousSynth.entryCount | 0;
    const countB = currentSynth.entryCount | 0;
    if (countA === 0 && countB === 0) {
      continue;
    }

    const flipPrev = prevHeader?.d8Array?.[block] | 0;
    const flipCurr = currHeader?.d8Array?.[block] | 0;

    synthesisWavAt5(previousSynth, synA, 0x80, ATX_SUBBAND_SAMPLES, modePrev, flipPrev, flipMode);
    synthesisWavAt5(currentSynth, synB, 0, ATX_SUBBAND_SAMPLES, modeCurr, flipCurr, flipMode);

    if (shouldApplyPreviousGhOverlapWindow(previousSynth, currentSynth)) {
      applyWindow(synA, 0x80);
    }
    if (shouldApplyCurrentGhOverlapWindow(previousSynth, currentSynth)) {
      applyWindow(synB, 0);
    }

    const dst = blockBuffers[block];
    for (let i = 0; i < ATX_SUBBAND_SAMPLES; i += 1) {
      const sum = Math.fround(synA[i] + synB[i]); // Required rounding
      dst[i] = dst[i] + sum;
    }
  }
}

function applyNoiseFillToBlockBuffers(blockBuffers, shared) {
  if (sharedNoiseFillEnabled(shared) === 0) {
    return;
  }

  const scale = (1 << (sharedNoiseFillShift(shared) & 31)) * (1 / 32768);
  let cursor = sharedNoiseFillCursor(shared) | 0;

  for (let block = 0; block < ATX_SUBBAND_BLOCKS; block += 1) {
    const base = ATX_DECODE_RND_IDX_TABLE[cursor] | 0;
    cursor += 1;

    const dst = blockBuffers[block];
    for (let i = 0; i < ATX_SUBBAND_SAMPLES; i += 1) {
      dst[i] += (AT5_RNDTBL[base + i] | 0) * scale;
    }
  }

  shared.noiseFillCursor = cursor >>> 0;
}

function writeOutputPcmRange(
  framePlanes,
  streamChannels,
  outputChannels,
  pcm,
  pcmOffset,
  startSample,
  sampleCount
) {
  const channels = outputChannels | 0;
  const count = sampleCount | 0;
  if (!(pcm instanceof Int16Array) || channels <= 0 || count <= 0) {
    return;
  }

  const sampleStart = startSample | 0;
  const outBase = pcmOffset | 0;

  if (channels === 1 && (streamChannels | 0) === 2) {
    const a = framePlanes[0];
    const b = framePlanes[1];

    for (let i = 0; i < count; i += 1) {
      const index = sampleStart + i;
      const left = a ? a[index] : 0;
      const right = b ? b[index] : 0;
      pcm[outBase + i] = pcmI16FromF32Sample((left + right) * 0.5);
    }
    return;
  }

  const sourceChannelLimit = Math.max((streamChannels | 0) - 1, 0);
  for (let i = 0; i < count; i += 1) {
    const sampleIndex = sampleStart + i;
    const dst = outBase + i * channels;
    for (let ch = 0; ch < channels; ch += 1) {
      const plane = framePlanes[Math.min(ch, sourceChannelLimit)];
      const sample = plane ? plane[sampleIndex] : 0;
      pcm[dst + ch] = pcmI16FromF32Sample(sample);
    }
  }
}

function copyGainBlocks(dst, src) {
  for (let i = 0; i < ATX_SUBBAND_BLOCKS; i += 1) {
    const d = dst[i];
    const s = src[i];
    d.segmentCount = s.segmentCount;
    d.windowFlag = s.windowFlag;
    d.segmentEnd.set(s.segmentEnd);
    d.segmentGainSel.set(s.segmentGainSel);
  }
}

function decodeBlockFloats(block, blockRuntime, framePlanes, outBase) {
  const regular = block.regularBlock;
  const shared = regular.shared;
  const channels = regular.channels;
  const channelRuntimes = blockRuntime.channels;
  const spectra = blockRuntime.spectra;
  const channelCount = shared.channels | 0;
  const outputBase = outBase | 0;
  const mdctBlockCount = reconstructBlockSpectra(block, blockRuntime);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channels[channelIndex];
    const channelRuntime = channelRuntimes[channelIndex];

    backwardTransformAt5(
      spectra[channelIndex],
      channelRuntime.blockBuffers,
      channelRuntime.prevGainBlocks,
      channelRuntime.currGainBlocks,
      mdctBlockCount,
      channelRuntime.overlap
    );

    for (let blockIndex = mdctBlockCount; blockIndex < ATX_SUBBAND_BLOCKS; blockIndex += 1) {
      channelRuntime.blockBuffers[blockIndex].fill(0);
    }
    applyGhSynthesis(
      channelRuntime.blockBuffers,
      channel,
      regular.ghShared,
      block.isMode4Block | 0,
      channelRuntime
    );
    applyNoiseFillToBlockBuffers(channelRuntime.blockBuffers, shared);
    applySynthesisFilterbank(channelRuntime);

    framePlanes[outputBase + channelIndex] = channelRuntime.outPcm;
    copyGainBlocks(channelRuntime.prevGainBlocks, channelRuntime.currGainBlocks);
  }

  regular.ghShared.slotIndex = (regular.ghShared.slotIndex ^ 1) >>> 0;
  return channelCount;
}

export function decodeAtrac3PlusFrame(handle) {
  const outputChannels = handle.outputChannels | 0;
  const pcm = new Int16Array(ATX_FRAME_SAMPLES * Math.max(outputChannels, 0));
  decodeAtrac3PlusFrameInto(handle, pcm, 0, 0, ATX_FRAME_SAMPLES);
  return pcm;
}

export function decodeAtrac3PlusFrameInto(handle, pcm, pcmOffset, startSample, sampleCount) {
  const runtime = ensureDecodeRuntime(handle);
  const framePlanes = runtime.framePlanes;

  let outBase = 0;
  for (let blockIndex = 0; blockIndex < (handle.blockCount | 0); blockIndex += 1) {
    const block = handle.blocks[blockIndex];
    outBase += decodeBlockFloats(block, runtime.blocks[blockIndex], framePlanes, outBase);
  }

  const streamChannels = handle.streamChannels | 0;
  const outputChannels = handle.outputChannels | 0;
  writeOutputPcmRange(
    framePlanes,
    streamChannels,
    outputChannels,
    pcm,
    pcmOffset,
    startSample,
    sampleCount
  );
  return pcm;
}
