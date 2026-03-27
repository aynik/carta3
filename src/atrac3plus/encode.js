import { CodecError } from "../common/errors.js";
import { readNodeEnvFlag } from "../common/env.js";

import {
  ATX_FRAME_BLOCK_TYPE_BITS,
  ATX_FRAME_BLOCK_TYPE_END,
  ATX_FRAME_SYNC_BITS,
  ATX_FRAME_SYNC_FLAG,
  at5PackStoreFromMsb,
  atxFrameBlockTypeName,
  atxRegularBlockTypeForChannels,
  packChannelBlockAt5Reg,
  unpackAtxFrame,
} from "./bitstream/internal.js";
import { encodeChannelBlocksWithinBudget } from "./channel-block/internal.js";
import { detectGaincDataNewAt5, setGaincAt5 } from "./gainc/internal.js";
import { at5SigprocAnalyzeFrame } from "./sigproc/internal.js";
import { ATRAC3PLUS_FRAME_SAMPLES } from "./constants.js";
import { createAtxDecodeHandle } from "./handle.js";
export { createAtrac3plusEncodeRuntime } from "./runtime.js";

export {
  ENCODE_SETTING_FIELDS,
  buildAtrac3plusCodecConfig,
  channelCountForBlockMode,
  computeCoreModeForBitBudget,
  createAtrac3plusEncodeHandle,
  decodeAtrac3plusCodecConfig,
  findAtrac3plusEncodeSetting,
  parseAtrac3plusCodecConfig,
} from "./encode-handle.js";

const ATX_FRAME_SAMPLES = ATRAC3PLUS_FRAME_SAMPLES;
const ATX_FLUSH_LEAD_SAMPLES = 0x396f;
const ATX_ENC_BUDGET_RETRY_STEP_BITS = 32;
const ATX_ENC_BUDGET_RETRY_LIMIT = 16;
const ATX_ENC_ERR_INPUT_SAMPLES = 0x210;

function getHandle(obj) {
  if (!obj) {
    return null;
  }
  if (obj.handle) {
    return obj.handle;
  }
  return obj;
}

function setHandleError(handleLike, code) {
  const handle = getHandle(handleLike);
  if (!handle) {
    return;
  }
  handle.errorCode = code >>> 0;
}

export function zeroPadAtrac3plusFramePcm(planarByChannel, streamChannels, sampleCount) {
  const count = sampleCount | 0;
  if (!Array.isArray(planarByChannel) || count < 0 || count >= ATX_FRAME_SAMPLES) {
    return;
  }

  const channelCount = streamChannels | 0;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const samples = planarByChannel[channelIndex];
    if (samples instanceof Float32Array) {
      samples.fill(0, count);
    }
  }
}

export function coerceAtrac3plusInputChannels(planarByChannel, inputChannels, streamChannels) {
  if (!Array.isArray(planarByChannel)) {
    return;
  }

  const inCount = inputChannels | 0;
  const outCount = streamChannels | 0;
  const left = planarByChannel[0];
  const right = planarByChannel[1];

  if (!(left instanceof Float32Array) || !(right instanceof Float32Array)) {
    return;
  }

  if (inCount === 1 && outCount === 2) {
    right.set(left.subarray(0, ATX_FRAME_SAMPLES));
    return;
  }

  if (inCount === 2 && outCount === 1) {
    for (let i = 0; i < ATX_FRAME_SAMPLES; i += 1) {
      left[i] = (left[i] + right[i]) * 0.5;
    }
  }
}

export function updateAtrac3plusFlushFrames(handleLike, sampleCount) {
  const handle = getHandle(handleLike);
  const count = sampleCount | 0;
  if (!handle || count <= 0) {
    return;
  }

  handle.flushFramesRemaining =
    (Math.trunc((count + ATX_FLUSH_LEAD_SAMPLES) / ATX_FRAME_SAMPLES) + 1) >>> 0;
}

export function prepareAtrac3plusInputFrame(runtime, planarByChannel, sampleCount) {
  const handle = getHandle(runtime);
  if (!handle || !Array.isArray(planarByChannel)) {
    setHandleError(runtime, ATX_ENC_ERR_INPUT_SAMPLES);
    return false;
  }

  const streamChannels = handle.streamChannels | 0;
  const inputChannels = handle.inputChannels | 0;
  const count = sampleCount | 0;
  if (count < 0 || count > ATX_FRAME_SAMPLES) {
    setHandleError(runtime, ATX_ENC_ERR_INPUT_SAMPLES);
    return false;
  }

  zeroPadAtrac3plusFramePcm(planarByChannel, streamChannels, count);
  updateAtrac3plusFlushFrames(handle, count);
  coerceAtrac3plusInputChannels(planarByChannel, inputChannels, streamChannels);
  return true;
}

function inputSampleError(runtime, blockResults = []) {
  setHandleError(runtime, ATX_ENC_ERR_INPUT_SAMPLES);
  return {
    ok: false,
    errorCode: ATX_ENC_ERR_INPUT_SAMPLES,
    blockResults,
  };
}

function readSigprocInputs(planarByChannel, channelCursor, channelCount) {
  if ((channelCount | 0) !== 1 && (channelCount | 0) !== 2) {
    return null;
  }

  const inputPtrs = planarByChannel.slice(channelCursor, channelCursor + channelCount);
  return inputPtrs.length === (channelCount | 0) &&
    inputPtrs.every((samples) => samples instanceof Float32Array)
    ? inputPtrs
    : null;
}

export function analyzeAtrac3plusSignalBlocks(runtime, planarByChannel) {
  if (!runtime || !Array.isArray(runtime.blocks) || !Array.isArray(planarByChannel)) {
    return inputSampleError(runtime);
  }

  const handle = getHandle(runtime);
  const callIndex = runtime.frameIndex | 0;
  const sigprocTrace = runtime.sigprocTrace ?? null;
  const disableGh = runtime.disableGh ?? false;
  const blockResults = [];
  let channelCursor = 0;

  for (const block of runtime.blocks) {
    const channelCount = block.channelsInBlock | 0;
    const inputPtrs = readSigprocInputs(planarByChannel, channelCursor, channelCount);
    if (!inputPtrs) {
      return inputSampleError(runtime, blockResults);
    }

    const out = at5SigprocAnalyzeFrame({
      inputPtrs,
      timeStates: block.timeStates,
      shared: block.shared,
      aux: block.aux,
      blocks: block.channelEntries,
      quantizedSpectraByChannel: block.quantizedSpectraByChannel,
      bitallocSpectraByChannel: block.bitallocSpectraByChannel,
      runTime2freq: true,
      encodeMode: block.blockState?.encodeMode ?? handle?.encodeMode ?? 0,
      coreMode: block.shared?.coreMode ?? 0,
      setGaincFn: setGaincAt5,
      detectGaincDataNewFn: detectGaincDataNewAt5,
      channelCount,
      blockMode: block.blockMode | 0,
      ispsIndex: block.ispsIndex | 0,
      callIndex,
      sigprocTrace,
      disableGh,
    });

    blockResults.push({
      blockIndex: block.blockIndex | 0,
      channels: channelCount,
      bandCount: out?.bandCount ?? 0,
      sigproc: out,
    });

    channelCursor += channelCount;
  }

  return {
    ok: true,
    errorCode: handle?.errorCode ?? 0,
    blockResults,
  };
}

function analyzeAtrac3plusSignalBlocksForEncode(runtime, planarByChannel) {
  if (!runtime || !Array.isArray(runtime.blocks) || !Array.isArray(planarByChannel)) {
    setHandleError(runtime, ATX_ENC_ERR_INPUT_SAMPLES);
    return {
      ok: false,
      errorCode: ATX_ENC_ERR_INPUT_SAMPLES,
    };
  }

  const handle = getHandle(runtime);
  const callIndex = runtime.frameIndex | 0;
  const sigprocTrace = runtime.sigprocTrace ?? null;
  const disableGh = runtime.disableGh ?? false;
  let channelCursor = 0;

  for (const block of runtime.blocks) {
    const channelCount = block.channelsInBlock | 0;
    const inputPtrs = readSigprocInputs(planarByChannel, channelCursor, channelCount);
    if (!inputPtrs) {
      setHandleError(runtime, ATX_ENC_ERR_INPUT_SAMPLES);
      return {
        ok: false,
        errorCode: ATX_ENC_ERR_INPUT_SAMPLES,
      };
    }

    at5SigprocAnalyzeFrame({
      inputPtrs,
      timeStates: block.timeStates,
      shared: block.shared,
      aux: block.aux,
      blocks: block.channelEntries,
      quantizedSpectraByChannel: block.quantizedSpectraByChannel,
      bitallocSpectraByChannel: block.bitallocSpectraByChannel,
      runTime2freq: true,
      encodeMode: block.blockState?.encodeMode ?? handle?.encodeMode ?? 0,
      coreMode: block.shared?.coreMode ?? 0,
      setGaincFn: setGaincAt5,
      detectGaincDataNewFn: detectGaincDataNewAt5,
      channelCount,
      blockMode: block.blockMode | 0,
      ispsIndex: block.ispsIndex | 0,
      callIndex,
      sigprocTrace,
      disableGh,
      returnSummary: false,
    });

    channelCursor += channelCount;
  }

  return {
    ok: true,
    errorCode: handle?.errorCode ?? 0,
  };
}

function analyzeAtrac3plusRuntimeFrameForEncode(runtime, planarByChannel, sampleCount) {
  const ok = prepareAtrac3plusInputFrame(runtime, planarByChannel, sampleCount);
  if (!ok) {
    throw new CodecError(
      `ATRAC3plus frame preparation failed with error=0x${(runtime.handle.errorCode >>> 0).toString(16)}`
    );
  }

  const sigproc = analyzeAtrac3plusSignalBlocksForEncode(runtime, planarByChannel);
  if (!sigproc.ok) {
    throw new CodecError(
      `ATRAC3plus frame analysis failed with error=0x${(sigproc.errorCode >>> 0).toString(16)}`
    );
  }
}

/**
 * Prepare one runtime frame for ATRAC3plus analysis and return the per-block
 * signal-processing summary used by study tooling.
 */
export function analyzeAtrac3plusRuntimeFrame(runtime, planarByChannel, sampleCount) {
  const ok = prepareAtrac3plusInputFrame(runtime, planarByChannel, sampleCount);
  if (!ok) {
    throw new CodecError(
      `ATRAC3plus frame preparation failed with error=0x${(runtime.handle.errorCode >>> 0).toString(16)}`
    );
  }

  const sigproc = analyzeAtrac3plusSignalBlocks(runtime, planarByChannel);
  if (!sigproc.ok) {
    throw new CodecError(
      `ATRAC3plus frame analysis failed with error=0x${(sigproc.errorCode >>> 0).toString(16)}`
    );
  }

  return sigproc;
}

function resetEncodeAttemptState(runtime, blocks) {
  runtime.handle.errorCode = 0;
  for (const block of blocks ?? []) {
    if (block) {
      block.blockErrorCode = 0;
    }
  }
}

function consumeDelayFrame(runtime) {
  if (runtime.handle.delayFramesRemaining >>> 0 <= 0) {
    return false;
  }

  runtime.handle.delayFramesRemaining = (runtime.handle.delayFramesRemaining - 1) >>> 0;
  runtime.frameIndex += 1;
  runtime.lastEncodeDebug = null;
  return true;
}

function padFrameToEnd(dst, bitpos, frameBytes) {
  const frameBits = (frameBytes >>> 0) * 8;
  const aligned = ((bitpos >>> 0) + 7) & ~7;
  if (aligned >= frameBits) {
    return;
  }

  for (let bytePos = aligned >>> 3; bytePos < frameBytes >>> 0; bytePos += 1) {
    dst[bytePos] |= 0x01;
  }
}

export function packAtrac3plusFrameFromRegularBlocks(handle, regularBlocks) {
  if (!handle || !Array.isArray(handle.blocks) || !Array.isArray(regularBlocks)) {
    throw new TypeError("invalid ATRAC3plus frame pack state");
  }

  const frameBytes = handle.frameBytes | 0;
  if (frameBytes <= 0) {
    throw new CodecError(`invalid ATRAC3plus frame byte size: ${frameBytes}`);
  }

  const tracePack = readNodeEnvFlag("CARTA_TRACE_ATX_PACK");
  const trace = tracePack ? [] : null;
  const emitTrace = tracePack
    ? (line) => {
        trace.push(line);
      }
    : null;
  const frame = new Uint8Array(frameBytes);
  const frameBits = (frameBytes >>> 0) * 8;
  const bitState = { bitpos: 0 };
  const packResult = (ok) => ({
    ok: !!ok,
    frame,
    bitpos: bitState.bitpos >>> 0,
    trace,
  });

  if (!at5PackStoreFromMsb(ATX_FRAME_SYNC_FLAG, ATX_FRAME_SYNC_BITS, frame, bitState)) {
    return packResult(false);
  }

  for (const [blockIndex, block] of regularBlocks.entries()) {
    const channels = block?.shared?.channels | 0;
    if (channels !== 1 && channels !== 2) {
      throw new CodecError(
        `invalid ATRAC3plus block channel count at index ${blockIndex}: ${channels}`
      );
    }

    const blockType = atxRegularBlockTypeForChannels(channels);
    if (!at5PackStoreFromMsb(blockType, ATX_FRAME_BLOCK_TYPE_BITS, frame, bitState)) {
      return packResult(false);
    }

    const start = bitState.bitpos >>> 0;
    if (!packChannelBlockAt5Reg(block, frame, bitState)) {
      return packResult(false);
    }

    if (emitTrace) {
      const end = bitState.bitpos >>> 0;
      emitTrace(
        `atx_pack_js: block=${blockIndex} type=${atxFrameBlockTypeName(blockType)} start=${start} end=${end} frame_bits=${frameBits}`
      );
    }
  }

  if (!at5PackStoreFromMsb(ATX_FRAME_BLOCK_TYPE_END, ATX_FRAME_BLOCK_TYPE_BITS, frame, bitState)) {
    return packResult(false);
  }

  if (emitTrace) {
    const end = bitState.bitpos >>> 0;
    emitTrace(
      `atx_pack_js: terminator_at=${(end - ATX_FRAME_BLOCK_TYPE_BITS) >>> 0} end_bitpos=${end} frame_bits=${frameBits}`
    );
  }

  padFrameToEnd(frame, bitState.bitpos >>> 0, frameBytes >>> 0);
  return packResult(true);
}

function shouldProbePackedFrames(runtime) {
  if (runtime?.probePackedFrames) {
    return true;
  }

  return readNodeEnvFlag("CARTA_PROBE_ATX_PACK");
}

export function packAndProbeAtrac3plusFrameFromRegularBlocks(handle, regularBlocks) {
  const packed = packAtrac3plusFrameFromRegularBlocks(handle, regularBlocks);
  if (!packed.ok) {
    return { ...packed, unpack: null };
  }

  const decodeHandle = createAtxDecodeHandle({
    sampleRate: handle.sampleRate,
    mode: handle.mode,
    frameBytes: handle.frameBytes,
    outputChannels: handle.streamChannels,
  });
  const unpack = unpackAtxFrame(decodeHandle, packed.frame);
  const block0 = decodeHandle.blocks?.[0];
  const regularBlock = block0?.regularBlock;

  return {
    ...packed,
    unpack: {
      ...unpack,
      blockErrorCode: block0?.blockErrorCode ?? null,
      regularBlockErrorCode: regularBlock?.blockErrorCode ?? null,
      channelBlockErrorCodes: Array.isArray(regularBlock?.channels)
        ? regularBlock.channels.map((channel) => channel?.blockErrorCode ?? null)
        : null,
    },
  };
}

/**
 * Run the prepared-frame ATRAC3plus encode path for one runtime frame: input
 * normalization, signal analysis, shared block-budget solve, pack/probe, and
 * encoder-delay bookkeeping. Returns `null` while the runtime is still
 * consuming delay frames, otherwise returns one packed ATRAC3plus frame.
 */
export function encodeAtrac3plusRuntimeFrame(
  runtime,
  planarByChannel,
  sampleCount,
  { useExactQuant = true } = {}
) {
  const baseFrameIndex = runtime?.frameIndex | 0;
  analyzeAtrac3plusRuntimeFrameForEncode(runtime, planarByChannel, sampleCount);

  if ((sampleCount | 0) === 0 && runtime.handle.delayFramesRemaining >>> 0 > 0) {
    consumeDelayFrame(runtime);
    return null;
  }

  const blocks = runtime.blocks;
  const blockCount = blocks?.length ?? 0;
  const maxBits = ((runtime.handle.frameBytes | 0) * 8 - blockCount * 2 - 3) | 0;
  const traceChannelBlockSolve =
    typeof runtime?.traceChannelBlockSolve === "function"
      ? (info) => runtime.traceChannelBlockSolve({ ...info, frameIndex: baseFrameIndex })
      : typeof runtime?.traceAt5Calc === "function"
        ? (info) => runtime.traceAt5Calc({ ...info, frameIndex: baseFrameIndex })
        : null;
  let budgetBits = maxBits | 0;
  const probePackedFrames = shouldProbePackedFrames(runtime);
  let lastAttempt = null;

  for (let attempt = 0; attempt < ATX_ENC_BUDGET_RETRY_LIMIT; attempt += 1) {
    resetEncodeAttemptState(runtime, blocks);
    const encodeResult = encodeChannelBlocksWithinBudget(
      blocks,
      budgetBits,
      traceChannelBlockSolve
    );

    if (consumeDelayFrame(runtime)) {
      return null;
    }

    const packed = probePackedFrames
      ? packAndProbeAtrac3plusFrameFromRegularBlocks(runtime.handle, blocks)
      : { ...packAtrac3plusFrameFromRegularBlocks(runtime.handle, blocks), unpack: null };
    const unpack = packed.unpack;
    const firstHdr = encodeResult.hdrByUnit?.[0] ?? null;
    const debugBase = {
      budgetBits: budgetBits | 0,
      maxBits: maxBits | 0,
      usedBits: encodeResult.usedBits | 0,
      bitpos: packed.bitpos >>> 0,
    };

    lastAttempt = {
      attempt: attempt | 0,
      ...debugBase,
      hdrBitsTotal: firstHdr?.bitsTotal ?? null,
      packedOk: !!packed.ok,
      unpackOk: probePackedFrames ? !!unpack?.ok : null,
      unpackErrorCode: probePackedFrames ? (unpack?.errorCode ?? null) : null,
      unpackBlockErrorCode: probePackedFrames ? (unpack?.blockErrorCode ?? null) : null,
      unpackRegularBlockErrorCode: probePackedFrames
        ? (unpack?.regularBlockErrorCode ?? null)
        : null,
      unpackChannelBlockErrorCodes: probePackedFrames
        ? (unpack?.channelBlockErrorCodes ?? null)
        : null,
      blockErrorCodes: Array.isArray(blocks)
        ? blocks.map((block) => block?.blockErrorCode ?? null)
        : null,
    };

    if (packed.ok && (!probePackedFrames || unpack?.ok)) {
      const block0Shared = blocks?.[0]?.shared ?? null;
      runtime.lastEncodeDebug = {
        frameIndex: baseFrameIndex | 0,
        bandLimit: (block0Shared?.bandLimit ?? block0Shared?.codedBandLimit ?? 0) | 0,
        quantStepScale: null,
        secondBitOffset: firstHdr?.debugSecondBitOffset ?? null,
        sharedBudget: encodeResult.debug ?? null,
        attempt: attempt | 0,
        ...debugBase,
        useExactQuant: !!useExactQuant,
      };
      runtime.frameIndex += 1;
      return packed.frame;
    }

    if (budgetBits > ATX_ENC_BUDGET_RETRY_STEP_BITS) {
      budgetBits -= ATX_ENC_BUDGET_RETRY_STEP_BITS;
      continue;
    }

    const frameIndex = (runtime.frameIndex += 1);
    throw new CodecError(
      `ATRAC3plus frame pack overflow at frame=${frameIndex | 0} usedBits=${encodeResult.usedBits | 0} budgetBits=${budgetBits | 0} maxBits=${maxBits | 0}`
    );
  }

  const frameIndex = (runtime.frameIndex += 1);
  throw new CodecError(
    `ATRAC3plus frame pack overflow after ${ATX_ENC_BUDGET_RETRY_LIMIT} attempts at frame=${frameIndex | 0} lastAttempt=${JSON.stringify(lastAttempt)}`
  );
}
