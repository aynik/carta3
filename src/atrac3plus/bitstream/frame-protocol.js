export const ATX_FRAME_SYNC_FLAG = 0;
export const ATX_FRAME_SYNC_BITS = 1;
export const ATX_FRAME_BLOCK_TYPE_BITS = 2;
export const ATX_FRAME_SKIP_BLOCK_LENGTH_OFFSET_BITS = 7;
export const ATX_FRAME_SKIP_BLOCK_LENGTH_BITS = 11;
export const ATX_FRAME_SKIP_BLOCK_HEADER_BITS = 18;
export const ATX_FRAME_SKIP_BLOCK_LENGTH_SENTINEL = 0x7ff;

export const ATX_FRAME_BLOCK_TYPE_MONO = 0;
export const ATX_FRAME_BLOCK_TYPE_STEREO = 1;
export const ATX_FRAME_BLOCK_TYPE_SKIP = 2;
export const ATX_FRAME_BLOCK_TYPE_END = 3;

const ATX_FRAME_BLOCK_TYPE_NAMES = Object.freeze({
  [ATX_FRAME_BLOCK_TYPE_MONO]: "mono",
  [ATX_FRAME_BLOCK_TYPE_STEREO]: "stereo",
  [ATX_FRAME_BLOCK_TYPE_SKIP]: "skip",
  [ATX_FRAME_BLOCK_TYPE_END]: "end",
});

export function atxRegularBlockTypeForChannels(channelCount) {
  return (channelCount | 0) === 1
    ? ATX_FRAME_BLOCK_TYPE_MONO
    : (channelCount | 0) === 2
      ? ATX_FRAME_BLOCK_TYPE_STEREO
      : -1;
}

export function atxChannelCountForRegularBlockType(blockType) {
  return (blockType | 0) === ATX_FRAME_BLOCK_TYPE_MONO
    ? 1
    : (blockType | 0) === ATX_FRAME_BLOCK_TYPE_STEREO
      ? 2
      : 0;
}

export function atxFrameBlockTypeName(blockType) {
  return ATX_FRAME_BLOCK_TYPE_NAMES[blockType | 0] ?? `unknown(${blockType | 0})`;
}
