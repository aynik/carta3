import { CodecError } from "../common/errors.js";
import { createAt5RegularBlockState } from "./bitstream/internal.js";
import { ATRAC3PLUS_FRAME_SAMPLES } from "./constants.js";
import { blockLayoutForMode } from "./topology.js";
import { ATX_MODE_CHANNEL_COUNT } from "./tables/core.js";
export const ATX_FRAME_SAMPLES = ATRAC3PLUS_FRAME_SAMPLES;

const ATX_SAMPLE_RATE_44100 = 44100;
const ATX_SAMPLE_RATE_48000 = 48000;
const ATX_FRAME_BYTES_MAX = 0x2000;

function createDecodeBlocks(blockLayout) {
  return blockLayout.map(({ blockIndex, channelsInBlock, requestedBlockMode }) => ({
    blockIndex,
    channelsInBlock,
    blockErrorCode: 0,
    isMode4Block: requestedBlockMode === 4 ? 1 : 0,
    ready: true,
    regularBlock: createAt5RegularBlockState(channelsInBlock),
  }));
}

function assertAtxDecodeHandleConfig(config) {
  if (!config || typeof config !== "object") {
    throw new CodecError("config must be an object");
  }

  const { sampleRate, mode, frameBytes, outputChannels } = config;
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
  if (!Number.isInteger(outputChannels) || outputChannels <= 0) {
    throw new CodecError(`invalid ATRAC3plus output channel count: ${outputChannels}`);
  }

  const streamChannels = ATX_MODE_CHANNEL_COUNT[mode];
  if (outputChannels !== streamChannels && !(streamChannels === 2 && outputChannels === 1)) {
    throw new CodecError(
      `unsupported ATRAC3plus output channel count: ${outputChannels} for streamChannels=${streamChannels}`
    );
  }
}

/**
 * Creates the low-level ATRAC3plus block decode handle used by frame unpack
 * and synthesis code.
 *
 * @param {object} config
 * @returns {object}
 */
export function createAtxDecodeHandle(config) {
  assertAtxDecodeHandleConfig(config);

  const { sampleRate, mode, frameBytes, outputChannels } = config;
  const blockLayout = blockLayoutForMode(mode);
  if (blockLayout.length === 0) {
    throw new CodecError(`invalid ATRAC3plus block topology for mode: ${mode}`);
  }
  const blockChannels = blockLayout.map(({ channelsInBlock }) => channelsInBlock);
  const blockCount = blockLayout.length;
  const blocks = createDecodeBlocks(blockLayout);

  return {
    sampleRate,
    mode,
    streamChannels: ATX_MODE_CHANNEL_COUNT[mode],
    frameBytes,
    outputChannels,
    frameSamples: ATX_FRAME_SAMPLES,
    blockCount,
    requiredBlocks: blockCount,
    blockChannels,
    errorCode: 0,
    blocks,
  };
}
