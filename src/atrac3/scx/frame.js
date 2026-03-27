/**
 * Frame-level ATRAC3 SCX encode entrypoints and channel-state rotation.
 */
import { CodecError } from "../../common/errors.js";
import { encodeScxChannelUnitAt3, encodeScxPcmChannelAt3 } from "./channel-unit.js";
import { clearAt3GainControlBlock } from "./gainc-layout.js";
import { time2freqAt3 } from "./time2freq.js";

const AT3_FRAME_SAMPLES = 1024;

function resetGainControlBlocks(gainControlBlocks) {
  for (const block of gainControlBlocks) {
    clearAt3GainControlBlock(block);
  }
}

function resetMddataEntries(entries) {
  for (const entry of entries) {
    entry.huffTableBaseIndex = 0;
    entry.twiddleId = 0;
    entry.huffTableSetIndex = 0;
    entry.groupFlags.fill(0);
    entry.listCounts.fill(0);
    for (const list of entry.lists) {
      list.fill(0);
    }
  }
}

function resetTonePoolEntries(tonePool) {
  for (const tone of tonePool) {
    tone.start = 0;
    tone.scaleFactorIndex = 0;
    tone.coefficients.fill(0);
    tone.twiddleId = 0;
    tone.huffTableBaseIndex = 0;
    tone.huffTableSetIndex = 0;
  }
}

function ensureChannelBuffers(buffers, name) {
  if (!Array.isArray(buffers)) {
    throw new CodecError(`${name} must be an array of Float32Array channel buffers`);
  }
  for (let i = 0; i < buffers.length; i += 1) {
    if (!(buffers[i] instanceof Float32Array) || buffers[i].length < AT3_FRAME_SAMPLES) {
      throw new CodecError(
        `${name}[${i}] must be a Float32Array with at least ${AT3_FRAME_SAMPLES} samples`
      );
    }
  }
}

function ensureScxContext(ctx) {
  const encoderState = ctx?.state;
  if (
    !ctx ||
    typeof ctx !== "object" ||
    !encoderState ||
    !Array.isArray(encoderState.channelHistories)
  ) {
    throw new CodecError("ctx must be a valid ATRAC3 SCX encoder context");
  }
  return encoderState;
}

function rotateScxChannelHistory(channelHistory) {
  const currentChannel = channelHistory?.current;
  const previousChannel = currentChannel?.prevState;
  const recycledChannel = channelHistory?.recycled;
  if (!currentChannel || !previousChannel || !recycledChannel) {
    throw new CodecError("channelHistory must provide current and recycled states");
  }

  clearScxChannelFrameState(recycledChannel);
  recycledChannel.prevState = currentChannel;
  recycledChannel.config.activeWords.set(currentChannel.config.queuedWords);
  recycledChannel.config.limit = currentChannel.config.queuedLimit;
  recycledChannel.scratchFlag = 0;
  recycledChannel.specGroupCount = recycledChannel.dba.iqtIndexPlus1;
  recycledChannel.componentGroupCount = recycledChannel.dba.scaledQ11CeilQ8;
  channelHistory.current = recycledChannel;
  channelHistory.recycled = previousChannel;
}

/**
 * Clears the SCX metadata rebuilt on every frame while leaving long-lived
 * buffers and topology links in place for channel-state rotation.
 */
export function clearScxChannelFrameState(channel) {
  if (!channel || typeof channel !== "object") {
    throw new CodecError("channel must be an object");
  }

  resetGainControlBlocks(channel.gaincParams);
  channel.mddataEntryIndex = 0;
  resetMddataEntries(channel.mddataEntries);
  channel.toneCount = 0;
  resetTonePoolEntries(channel.tonePool);
}

/**
 * Rotates the authored SCX channel histories and clears the destination frame
 * buffer before one frame-level encode pass begins.
 */
export function beginAtrac3ScxFrame(ctx, out) {
  const encoderState = ensureScxContext(ctx);
  const channelCount = encoderState.channelCount;
  const frameBytes = ctx.frameBytes;
  const frame = out ?? new Uint8Array(frameBytes);
  if (!(frame instanceof Uint8Array) || frame.length < frameBytes) {
    throw new CodecError(`out must be a Uint8Array with at least ${frameBytes} bytes`);
  }

  encoderState.outputOffset = 0;
  frame.fill(0);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    rotateScxChannelHistory(encoderState.channelHistories[channelIndex]);
  }

  return {
    encoderState,
    frame,
    channelCount,
  };
}

export function at3ScxEncodeFrameFromSpectra(transformedChannels, specChannels, ctx, out) {
  ensureChannelBuffers(transformedChannels, "transformedChannels");
  ensureChannelBuffers(specChannels, "specChannels");
  const { encoderState, frame, channelCount } = beginAtrac3ScxFrame(ctx, out);
  if (transformedChannels.length < channelCount || specChannels.length < channelCount) {
    throw new CodecError(`expected ${channelCount} channel buffers`);
  }

  const channelHistories = encoderState.channelHistories;
  for (let ch = 0; ch < channelCount; ch += 1) {
    const channel = channelHistories[ch].current;
    if (encodeScxChannelUnitAt3(channel, transformedChannels[ch], specChannels[ch], frame) < 0) {
      return -1;
    }
  }

  return frame;
}

export function at3ScxEncodeFrameFromPcm(pcmChannels, ctx, out) {
  ensureChannelBuffers(pcmChannels, "pcmChannels");
  const { encoderState, frame, channelCount } = beginAtrac3ScxFrame(ctx, out);
  if (pcmChannels.length < channelCount) {
    throw new CodecError(`expected ${channelCount} channel buffers`);
  }

  const channelHistories = encoderState.channelHistories;
  const scratchChannels = encoderState.channelScratch;
  if (
    time2freqAt3(
      pcmChannels,
      scratchChannels,
      channelHistories,
      channelCount,
      encoderState.time2freqMode | 0
    ) === -1
  ) {
    return -1;
  }

  for (let ch = 0; ch < channelCount; ch += 1) {
    const scratch = scratchChannels[ch];
    const channel = channelHistories[ch].current;
    if (encodeScxPcmChannelAt3(channel, scratch, frame) < 0) {
      return -1;
    }
  }

  return frame;
}
