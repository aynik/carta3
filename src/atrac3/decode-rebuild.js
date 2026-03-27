import {
  AT3_DEC_BLOCK_FLOATS,
  AT3_DEC_MAX_UNITS,
  ATRAC3_FRAME_SAMPLES,
  ATRAC3_RESIDUAL_DELAY_SAMPLES,
} from "./constants.js";
import { applyAtrac3BlockTransform } from "./decode-rebuild-block.js";

const AT3_DEC_MIX_STRIDE = 4;

function clearAtrac3InactiveBlocks(channelState, clearStartBlock) {
  const { spectrumHistory, workF32 } = channelState;

  for (let block = clearStartBlock; block < AT3_DEC_MAX_UNITS; block += 1) {
    spectrumHistory[block].fill(0);

    for (let index = block; index < ATRAC3_FRAME_SAMPLES; index += AT3_DEC_MIX_STRIDE) {
      workF32[ATRAC3_RESIDUAL_DELAY_SAMPLES + index] = 0;
    }
  }
}

/**
 * Rebuilds one ATRAC3 channel overlap/add work area from decoded spectrum
 * blocks and the staged gain-ramp table for the next frame.
 *
 * The rebuild span stays explicit here: when the current payload shrinks, the
 * previous frame's active block tail still needs one overlap/add pass before
 * it can be cleared from the channel work area.
 */
export function rebuildAtrac3ChannelWorkArea(channelState, spectrumScratch, decodedBlockCount) {
  const stagedGainTables = channelState.gainTables.staged;
  const previousBlockCount = Math.min(channelState.prevBlockCount, AT3_DEC_MAX_UNITS);
  const currentBlockCount = Math.min(decodedBlockCount, AT3_DEC_MAX_UNITS);
  const rebuildBlockCount = Math.max(currentBlockCount, previousBlockCount);
  const inactiveClearStartBlock = Math.max(rebuildBlockCount, 1);

  channelState.prevBlockCount = currentBlockCount;
  channelState.workF32.copyWithin(
    0,
    ATRAC3_FRAME_SAMPLES,
    ATRAC3_FRAME_SAMPLES + ATRAC3_RESIDUAL_DELAY_SAMPLES
  );

  for (let block = 0; block < rebuildBlockCount; block += 1) {
    applyAtrac3BlockTransform(
      spectrumScratch,
      block * AT3_DEC_BLOCK_FLOATS,
      block,
      stagedGainTables[block][0].gain,
      channelState
    );
  }

  clearAtrac3InactiveBlocks(channelState, inactiveClearStartBlock);
  [channelState.gainTables.active, channelState.gainTables.staged] = [
    channelState.gainTables.staged,
    channelState.gainTables.active,
  ];
}
