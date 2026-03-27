import { CodecError } from "../common/errors.js";
import { normalizeCodecFrames } from "../common/bytes.js";
import { resolveCodecDecodedSampleWindow } from "../common/trim.js";
import { unpackAtxFrame } from "./bitstream/internal.js";
import { ATRAC3PLUS_DELAY_SAMPLES } from "./state.js";
import { decodeAtrac3PlusFrameInto } from "./decode.js";

const ATRAC3PLUS_FACT_LEAD_IN_WORDS = Object.freeze([2, 1]);

/**
 * Decodes ATRAC3plus transport frames to trimmed public PCM16 output.
 *
 * This owner keeps frame normalization, unpack/decode sequencing, and the
 * codec/container trim window together so `decoder.js` can stay focused on the
 * reusable public wrapper class.
 *
 * @param {object} state
 * @param {(ArrayBuffer|ArrayBufferView)[]} frames
 * @param {number | null | undefined} factSamples
 * @param {number[] | null | undefined} [factRaw=[]]
 * @returns {Int16Array}
 */
export function decodeAtrac3PlusFrames(state, frames, factSamples, factRaw = []) {
  const { frameBytes, frameSamples, handle, outputChannels } = state;
  const normalizedFrames = normalizeCodecFrames(frames, frameBytes, "ATRAC3plus");
  if (!handle) {
    if (state.mode === 0) {
      throw new CodecError(
        "ATRAC3plus decode handle is not initialized (missing codec bytes/mode)"
      );
    }
    if (!state.sampleRate) {
      throw new CodecError("ATRAC3plus decode handle is not initialized (missing sampleRate)");
    }
    throw new CodecError("ATRAC3plus decode handle is not initialized");
  }

  const totalSamples = normalizedFrames.length * frameSamples;
  const sampleWindow = resolveCodecDecodedSampleWindow(
    totalSamples,
    factSamples,
    factRaw,
    frameSamples,
    ATRAC3PLUS_FACT_LEAD_IN_WORDS,
    ATRAC3PLUS_DELAY_SAMPLES
  );
  const startSample = sampleWindow.skipSamples | 0;
  const endSample = startSample + (sampleWindow.targetSamples | 0);

  const pcm = new Int16Array(sampleWindow.targetSamples * outputChannels);
  let frameStart = 0;

  for (const [frameIndex, frame] of normalizedFrames.entries()) {
    const result = unpackAtxFrame(handle, frame);
    if (!result.ok) {
      const blockCursor = Number.isInteger(result.parsedBlocks) ? result.parsedBlocks | 0 : null;
      const blocks = handle.blocks;
      const block =
        blockCursor !== null &&
        Array.isArray(blocks) &&
        blockCursor >= 0 &&
        blockCursor < blocks.length
          ? blocks[blockCursor]
          : null;
      const regularBlock = block?.regularBlock ?? null;
      const channelErrors = Array.isArray(regularBlock?.channels)
        ? regularBlock.channels.map((channel) => channel?.blockErrorCode ?? 0)
        : null;
      const channelCursor =
        channelErrors && channelErrors.length > 0
          ? channelErrors.findIndex((code) => code >>> 0 !== 0)
          : -1;

      const messageParts = [
        `ATRAC3plus unpack failed at frame ${frameIndex}:`,
        `error=0x${(result.errorCode >>> 0).toString(16)}`,
        `bitpos=${result.bitpos >>> 0}`,
      ];
      if (blockCursor !== null) {
        messageParts.push(`block=${blockCursor}`);
      }
      if (block) {
        messageParts.push(`blockError=0x${(block.blockErrorCode >>> 0).toString(16)}`);
        if (Number.isInteger(block.blockIndex) && block.blockIndex !== blockCursor) {
          messageParts.push(`layoutIndex=${block.blockIndex}`);
        }
      }
      if (regularBlock) {
        messageParts.push(
          `regularBlockError=0x${(regularBlock.blockErrorCode >>> 0).toString(16)}`
        );
      }
      if (channelErrors) {
        messageParts.push(
          `channelErrors=[${channelErrors
            .map((code) => `0x${(code >>> 0).toString(16)}`)
            .join(",")}]`
        );
      }
      if (channelCursor >= 0) {
        messageParts.push(`channel=${channelCursor}`);
      }
      throw new CodecError(messageParts.join(" "));
    }

    const frameEnd = frameStart + frameSamples;
    const copyStart = Math.max(frameStart, startSample);
    const copyEnd = Math.min(frameEnd, endSample);

    if (copyEnd > copyStart) {
      const sourceSampleOffset = copyStart - frameStart;
      const copySamples = copyEnd - copyStart;
      const targetIndex = (copyStart - startSample) * outputChannels;
      decodeAtrac3PlusFrameInto(handle, pcm, targetIndex, sourceSampleOffset, copySamples);
    } else {
      decodeAtrac3PlusFrameInto(handle, null, 0, 0, 0);
    }

    frameStart = frameEnd;
  }

  return pcm;
}
