import { CodecError } from "../common/errors.js";
import { ATX_MODE_CHANNEL_COUNT } from "./tables/core.js";
import {
  AT5_ISPS,
  ATX_CMODE4_SCALE_0,
  ATX_CMODE4_SCALE_1,
  ATX_ENCODE_SETTINGS,
} from "./tables/encode-init.js";
import { blockLayoutForMode, resolveBlockMode } from "./topology.js";

/**
 * ATRAC3plus encode-handle configuration and block budgeting.
 *
 * This module owns codec-byte configuration, block budgeting, handle
 * initialization, and block-level encode metadata. Runtime construction lives
 * in `runtime.js`, while frame-stage helpers live in `encode.js`.
 */
// Each settings row stores: bitrate, frame bytes, bandwidth, primary block mode, mode, sample rate.
export const ENCODE_SETTING_FIELDS = 6;

const ATX_SAMPLE_RATE_44100 = 44100;
const ATX_SAMPLE_RATE_48000 = 48000;
const ATX_FRAME_BYTES_MAX = 0x2000;
const ATRAC3PLUS_SAMPLE_RATE_BY_CODE = Object.freeze([32000, 44100, 48000]);
// The ATRAC3plus encoder consumes a fixed number of warm-up frames before
// emitting the first packed output frame.
const ATX_ENCODE_DELAY_FRAMES = 7;
// Default flush frame count for empty/unknown inputs. This matches the steady
// state that `updateAtrac3plusFlushFrames()` derives for full frames.
const ATX_DEFAULT_FLUSH_FRAMES = 9;

const CORE_MODE_THRESHOLDS = [
  [0x5cc5f, 0x1f],
  [0x5572f, 0x1e],
  [0x493df, 0x1d],
  [0x3d08f, 0x1b],
  [0x2bf1f, 0x19],
  [0x249ef, 0x18],
  [0x1d4bf, 0x17],
  [0x1adaf, 0x15],
  [0x1869f, 0x14],
  [0x15f8f, 0x13],
  [0x14fef, 0x12],
  [0x128df, 0x11],
  [0x1116f, 0x10],
  [0xea5f, 0x0f],
  [0xd6d7, 0x0e],
  [0xafc7, 0x0d],
  [0x88b7, 0x0c],
  [0x752f, 0x0b],
  [0x658f, 0x0a],
  [0x55ef, 0x09],
  [0x4a37, 0x08],
  [0x3a97, 0x07],
  [0x34bb, 0x06],
  [0x2ceb, 0x05],
  [0x251b, 0x04],
  [0x1d4b, 0x03],
  [0x157b, 0x02],
];

export function buildAtrac3plusCodecConfig(sampleRate, mode, frameBytes) {
  if (sampleRate !== ATX_SAMPLE_RATE_44100 && sampleRate !== ATX_SAMPLE_RATE_48000) {
    throw new CodecError(`unsupported ATRAC3plus sample rate: ${sampleRate}`);
  }
  if (!Number.isInteger(mode) || mode < 1 || mode > 7) {
    throw new CodecError(`unsupported ATRAC3plus mode: ${mode}`);
  }
  if (
    !Number.isInteger(frameBytes) ||
    frameBytes <= 0 ||
    frameBytes > ATX_FRAME_BYTES_MAX ||
    (frameBytes & 7) !== 0
  ) {
    throw new CodecError(`invalid ATRAC3plus frame byte count: ${frameBytes}`);
  }

  const srCode = sampleRate === ATX_SAMPLE_RATE_44100 ? 1 : 2;
  const frameCode = (frameBytes >>> 3) - 1;
  return new Uint8Array([
    (srCode << 5) | (mode << 2) | ((frameCode >>> 8) & 0x3),
    frameCode & 0xff,
  ]);
}

export function decodeAtrac3plusCodecConfig(codecBytes) {
  if (!codecBytes || codecBytes.length < 2) {
    throw new CodecError("ATRAC3plus codec config requires 2 bytes");
  }

  const b0 = codecBytes[0] | 0;
  const b1 = codecBytes[1] | 0;
  const sampleRateCode = b0 >>> 5;

  return {
    sampleRateCode,
    sampleRate: ATRAC3PLUS_SAMPLE_RATE_BY_CODE[sampleRateCode] ?? null,
    mode: (b0 & 0x1c) >>> 2,
    frameBytes: (((b0 & 0x03) << 8) | b1) * 8 + 8,
  };
}

export function parseAtrac3plusCodecConfig(codecBytes) {
  const { sampleRateCode, sampleRate, mode, frameBytes } = decodeAtrac3plusCodecConfig(codecBytes);
  if (sampleRate === null) {
    throw new CodecError(`unsupported ATRAC3plus sample rate code: ${sampleRateCode}`);
  }

  return {
    sampleRate,
    mode,
    frameBytes,
  };
}

export function channelCountForBlockMode(blockMode) {
  if (!Number.isInteger(blockMode) || blockMode < 1 || blockMode > 4) {
    throw new CodecError(`unsupported ATRAC3plus block mode: ${blockMode}`);
  }
  return blockMode === 1 || blockMode === 4 ? 1 : 2;
}

export function findAtrac3plusEncodeSetting({ sampleRate, mode, frameBytes, bitrateKbps = null }) {
  for (let i = 0; i < ATX_ENCODE_SETTINGS.length; i += ENCODE_SETTING_FIELDS) {
    const rowBitrate = ATX_ENCODE_SETTINGS[i] >>> 0;
    const rowFrameBytes = ATX_ENCODE_SETTINGS[i + 1] >>> 0;
    const rowBandwidthHz = ATX_ENCODE_SETTINGS[i + 2] >>> 0;
    const rowPrimaryBlockMode = ATX_ENCODE_SETTINGS[i + 3] >>> 0;
    const rowMode = ATX_ENCODE_SETTINGS[i + 4] >>> 0;
    const rowSampleRate = ATX_ENCODE_SETTINGS[i + 5] >>> 0;

    if (
      rowFrameBytes !== frameBytes >>> 0 ||
      rowMode !== mode >>> 0 ||
      rowSampleRate !== sampleRate >>> 0
    ) {
      continue;
    }
    if (bitrateKbps !== null && rowBitrate !== bitrateKbps >>> 0) {
      continue;
    }

    return {
      bitrateKbps: rowBitrate,
      frameBytes: rowFrameBytes,
      bandwidthHz: rowBandwidthHz,
      primaryBlockMode: rowPrimaryBlockMode,
      mode: rowMode,
      sampleRate: rowSampleRate,
    };
  }

  return null;
}

function computeBlockBitBudget(mode, frameBytes) {
  const totalBits = Math.trunc(frameBytes) * 8;
  const reservedBits = mode >= 5 ? 0x88 : 0;
  const unitBits = Math.trunc((totalBits - reservedBits) / (mode < 3 ? 1 : mode));
  return { reservedBits, unitBits };
}

function buildBlockSpecsForMode(mode, frameBytes, primaryBlockMode) {
  const layout = blockLayoutForMode(mode);
  if (layout.length === 0) {
    return [];
  }

  const { reservedBits, unitBits } = computeBlockBitBudget(mode, frameBytes);
  return layout.map(({ blockIndex, bitUnits, requestedBlockMode, channelsInBlock }) => {
    const resolvedBlockMode = resolveBlockMode(requestedBlockMode, primaryBlockMode);
    const isMode4Block = Number(resolvedBlockMode === 4);

    return {
      blockIndex,
      channelsInBlock,
      requestedBlockMode: resolvedBlockMode,
      blockMode: isMode4Block ? 1 : resolvedBlockMode,
      isMode4Block,
      bitsForBlock: bitUnits === 0 ? reservedBits : unitBits * bitUnits,
    };
  });
}

export function computeCoreModeForBitBudget(sampleRate, bitsForBlock) {
  const tmp = Math.trunc((bitsForBlock + 7) / 8);
  const scaled = Math.trunc((sampleRate * tmp) / 256);

  for (const [threshold, mode] of CORE_MODE_THRESHOLDS) {
    if (scaled > threshold) {
      return mode;
    }
  }
  if (scaled >= 0xdac) {
    return 0x01;
  }
  return 0x00;
}

function adjustCoreModeForLayout(mode, sampleRate, frameBytes, blockIndex, coreMode) {
  if (mode === 5) {
    if (sampleRate === 0xac44 && frameBytes === 0x5d0) {
      if (blockIndex === 0 || blockIndex === 2) {
        return coreMode - 1;
      }
      if (blockIndex === 1) {
        return coreMode + 2;
      }
    } else if (sampleRate === 0xbb80 && frameBytes === 0x558) {
      if (blockIndex === 0 || blockIndex === 2) {
        return coreMode - 1;
      }
      if (blockIndex === 1) {
        return coreMode + 2;
      }
    }
  } else if (mode === 7) {
    if (sampleRate === 0xac44 && frameBytes === 0x8b8 && blockIndex === 1) {
      return coreMode + 2;
    }
    if (sampleRate === 0xbb80 && frameBytes === 0x800 && blockIndex === 1) {
      return coreMode + 2;
    }
  }

  return coreMode;
}

function computeBlockEncodeFlags(encodeMode, channels, coreMode) {
  const baseFlagThreshold =
    channels === 1 ? 0x0e : channels === 2 ? 0x12 : Number.POSITIVE_INFINITY;
  const baseFlag = coreMode > baseFlagThreshold ? 1 : 0;

  return {
    encodeFlagCc: encodeMode === 2 ? 0 : baseFlag,
    encodeFlagD0: encodeMode === 2 ? Number(channels === 2 && coreMode > 0x16) : baseFlag,
  };
}

function assertSupportedEncodeMode(sampleRate, mode, encodeMode) {
  if (encodeMode === 0 || encodeMode === 2) {
    return;
  }
  if (encodeMode === 1 && mode === 2 && sampleRate === ATX_SAMPLE_RATE_48000) {
    return;
  }
  throw new CodecError(
    `unsupported ATRAC3plus encode mode=${encodeMode} for sampleRate=${sampleRate} mode=${mode}`
  );
}

function resolveBandwidthIspsIndex(sampleRate, bandwidthHz) {
  const ratioQ12 = sampleRate > 0 ? Math.trunc((bandwidthHz << 12) / sampleRate) : 0;
  let ispsIndex = 1;

  while (ispsIndex < 0x20 && (AT5_ISPS[ispsIndex] | 0) < ratioQ12) {
    ispsIndex += 1;
  }

  return ispsIndex;
}

function createEncodeHandleBlock(
  spec,
  { mode, sampleRate, frameBytes, bandwidthHz, encodeMode, sinusoidEncodeFlag }
) {
  const { blockIndex, bitsForBlock, channelsInBlock, blockMode, isMode4Block, requestedBlockMode } =
    spec;
  const blockBandwidthHz = isMode4Block
    ? Math.trunc(sampleRate * ATX_CMODE4_SCALE_0[0] * 16 * ATX_CMODE4_SCALE_1[0])
    : bandwidthHz;
  const ispsIndex = resolveBandwidthIspsIndex(sampleRate, blockBandwidthHz);
  const coreMode = adjustCoreModeForLayout(
    mode,
    sampleRate,
    frameBytes,
    blockIndex,
    computeCoreModeForBitBudget(sampleRate, bitsForBlock)
  );
  const { encodeFlagCc, encodeFlagD0 } = computeBlockEncodeFlags(
    encodeMode,
    channelsInBlock,
    coreMode
  );

  return {
    blockIndex,
    ready: true,
    blockMode,
    requestedBlockMode,
    isMode4Block,
    channelsInBlock,
    bitsForBlock,
    bandwidthHz: blockBandwidthHz,
    ispsIndex,
    ispsValueQ12: AT5_ISPS[ispsIndex] | 0,
    coreMode,
    encodeMode,
    encodeFlagCc,
    encodeFlagD0,
    sinusoidEncodeFlag,
    blockErrorCode: 0,
  };
}

export function createAtrac3plusEncodeHandle({
  sampleRate,
  mode,
  frameBytes,
  inputChannels,
  bitrateKbps = null,
  primaryBlockMode = null,
  bandwidthHz = null,
  encodeMode = 0,
  sinusoidEncodeFlag = 1,
}) {
  if (sampleRate !== ATX_SAMPLE_RATE_44100 && sampleRate !== ATX_SAMPLE_RATE_48000) {
    throw new CodecError(`unsupported ATRAC3plus sample rate: ${sampleRate}`);
  }
  if (!Number.isInteger(mode) || mode < 1 || mode > 7) {
    throw new CodecError(`unsupported ATRAC3plus mode: ${mode}`);
  }
  if (
    !Number.isInteger(frameBytes) ||
    frameBytes <= 0 ||
    frameBytes > ATX_FRAME_BYTES_MAX ||
    (frameBytes & 7) !== 0
  ) {
    throw new CodecError(`invalid ATRAC3plus frame byte count: ${frameBytes}`);
  }
  if (!Number.isInteger(inputChannels) || inputChannels < 1 || inputChannels > 8) {
    throw new CodecError(`invalid ATRAC3plus input channel count: ${inputChannels}`);
  }
  if (!Number.isInteger(encodeMode) || encodeMode < 0 || encodeMode > 2) {
    throw new CodecError(`invalid ATRAC3plus encode mode: ${encodeMode}`);
  }
  assertSupportedEncodeMode(sampleRate, mode, encodeMode);

  const setting = findAtrac3plusEncodeSetting({ sampleRate, mode, frameBytes, bitrateKbps });
  const resolvedPrimaryBlockMode = primaryBlockMode ?? setting?.primaryBlockMode ?? null;
  const resolvedBandwidthHz = bandwidthHz ?? setting?.bandwidthHz ?? null;
  if (resolvedPrimaryBlockMode === null || resolvedBandwidthHz === null) {
    throw new CodecError(
      `unsupported ATRAC3plus encode setting: sampleRate=${sampleRate} mode=${mode} frameBytes=${frameBytes}`
    );
  }

  const configBytes = buildAtrac3plusCodecConfig(sampleRate, mode, frameBytes);
  const specs = buildBlockSpecsForMode(mode, frameBytes, resolvedPrimaryBlockMode);
  const blockCount = specs.length;
  if (blockCount <= 0) {
    throw new CodecError(`invalid ATRAC3plus block topology for mode: ${mode}`);
  }
  const blocks = specs.map((spec) =>
    createEncodeHandleBlock(spec, {
      mode,
      sampleRate,
      frameBytes,
      bandwidthHz: resolvedBandwidthHz,
      encodeMode,
      sinusoidEncodeFlag: sinusoidEncodeFlag ? 1 : 0,
    })
  );

  return {
    sampleRate,
    mode,
    streamChannels: ATX_MODE_CHANNEL_COUNT[mode] | 0,
    frameBytes,
    inputChannels,
    bitrateKbps: setting?.bitrateKbps ?? bitrateKbps,
    primaryBlockMode: resolvedPrimaryBlockMode,
    bandwidthHz: resolvedBandwidthHz,
    encodeMode,
    configBytes,
    blockCount,
    requiredBlocks: blockCount,
    delayFramesRemaining: ATX_ENCODE_DELAY_FRAMES,
    flushFramesRemaining: ATX_DEFAULT_FLUSH_FRAMES,
    errorCode: 0,
    blocks,
  };
}
