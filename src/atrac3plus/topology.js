export const ATX_MAX_BLOCKS = 5;

// Stereo-capable layouts inherit their main block mode from the first regular block.
const PRIMARY_BLOCK_MODE = "primary";

const MODE_LAYOUTS = Object.freeze({
  1: Object.freeze([{ channelsInBlock: 1, bitUnits: 1, requestedBlockMode: PRIMARY_BLOCK_MODE }]),
  2: Object.freeze([{ channelsInBlock: 2, bitUnits: 1, requestedBlockMode: PRIMARY_BLOCK_MODE }]),
  3: Object.freeze([
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
  ]),
  4: Object.freeze([
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
    { channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
  ]),
  5: Object.freeze([
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 0, requestedBlockMode: 4 },
  ]),
  6: Object.freeze([
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
    { channelsInBlock: 1, bitUnits: 0, requestedBlockMode: 4 },
  ]),
  7: Object.freeze([
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 1, requestedBlockMode: 1 },
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 2, bitUnits: 2, requestedBlockMode: PRIMARY_BLOCK_MODE },
    { channelsInBlock: 1, bitUnits: 0, requestedBlockMode: 4 },
  ]),
});

export function blockLayoutForMode(mode) {
  const layout = MODE_LAYOUTS[mode];
  return layout ? layout.map((entry, blockIndex) => ({ blockIndex, ...entry })) : [];
}

export function blockCountForMode(mode) {
  return blockLayoutForMode(mode).length;
}

export function blockChannelsForMode(mode) {
  return blockLayoutForMode(mode).map(({ channelsInBlock }) => channelsInBlock);
}

export function resolveBlockMode(requestedBlockMode, primaryBlockMode) {
  return requestedBlockMode === PRIMARY_BLOCK_MODE ? primaryBlockMode : requestedBlockMode;
}
