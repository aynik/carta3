import { at5ReadBits24 } from "./bitstream.js";
import {
  ATX_FRAME_BLOCK_TYPE_BITS,
  ATX_FRAME_BLOCK_TYPE_END,
  ATX_FRAME_BLOCK_TYPE_SKIP,
  ATX_FRAME_SKIP_BLOCK_HEADER_BITS,
  ATX_FRAME_SKIP_BLOCK_LENGTH_BITS,
  ATX_FRAME_SKIP_BLOCK_LENGTH_OFFSET_BITS,
  ATX_FRAME_SKIP_BLOCK_LENGTH_SENTINEL,
  ATX_FRAME_SYNC_BITS,
  atxChannelCountForRegularBlockType,
} from "./frame-protocol.js";
import { unpackChannelBlockAt5Reg } from "./block-regular.js";

const ATX_ERROR_BAD_FRAME_HEADER = 0x208;
const ATX_ERROR_BITPOS_OVERFLOW = 0x209;
const ATX_ERROR_CHANNEL_MODE_MISMATCH = 0x20a;
const ATX_ERROR_UNPACK_FAILED = 0x20b;
const ATX_ERROR_TOO_MANY_BLOCKS = 0x20c;
const ATX_ERROR_MISSING_BLOCKS = 0x20d;
const ATX_ERROR_BITSTREAM_OVERRUN = 0x20e;
const ATX_ERROR_UNTERMINATED_FRAME = 0x214;
const ATX_ERROR_TYPE2_LENGTH = 0x215;

function atxPeekBits24(frame, bitpos, bits) {
  const width = bits | 0;
  if (width <= 0) {
    return 0;
  }

  const pos = bitpos >>> 0;
  const limitBits = frame.length * 8;
  if (pos + width > limitBits) {
    return 0;
  }
  return at5ReadBits24(frame, pos, width) >>> 0;
}

function finishFrameUnpack(handle, bitpos, parsedBlocks, errorCode = 0) {
  const code = errorCode >>> 0;
  handle.errorCode = code;
  return {
    ok: code === 0,
    bitpos: bitpos >>> 0,
    parsedBlocks: parsedBlocks >>> 0,
    errorCode: code,
  };
}

export function unpackAtxFrame(handle, frame) {
  if (!handle || !Array.isArray(handle.blocks)) {
    throw new TypeError("invalid ATRAC3plus decode handle");
  }
  if (!(frame instanceof Uint8Array)) {
    throw new TypeError("invalid ATRAC3plus frame");
  }

  handle.errorCode = 0;
  for (const block of handle.blocks) {
    block.blockErrorCode = 0;
  }

  if ((frame[0] & 0x80) !== 0) {
    return finishFrameUnpack(handle, 0, 0, ATX_ERROR_BAD_FRAME_HEADER);
  }

  const blockCount = handle.blockCount | 0;
  const frameBits = frame.length * 8;
  let bitpos = ATX_FRAME_SYNC_BITS;
  let parsedBlocks = 0;

  while (bitpos <= frameBits - ATX_FRAME_BLOCK_TYPE_BITS) {
    const blockType = atxPeekBits24(frame, bitpos, ATX_FRAME_BLOCK_TYPE_BITS);
    if (blockType === ATX_FRAME_BLOCK_TYPE_END) {
      return finishFrameUnpack(
        handle,
        bitpos,
        parsedBlocks,
        parsedBlocks === blockCount ? 0 : ATX_ERROR_MISSING_BLOCKS
      );
    }

    if (blockType === ATX_FRAME_BLOCK_TYPE_SKIP) {
      const nextBitpos = bitpos + ATX_FRAME_SKIP_BLOCK_HEADER_BITS;
      const length = atxPeekBits24(
        frame,
        bitpos + ATX_FRAME_SKIP_BLOCK_LENGTH_OFFSET_BITS,
        ATX_FRAME_SKIP_BLOCK_LENGTH_BITS
      );
      if (length >= ATX_FRAME_SKIP_BLOCK_LENGTH_SENTINEL) {
        return finishFrameUnpack(handle, nextBitpos, parsedBlocks, ATX_ERROR_TYPE2_LENGTH);
      }
      bitpos = (nextBitpos + length * 8) >>> 0;
      continue;
    }

    if (parsedBlocks >= blockCount) {
      return finishFrameUnpack(handle, bitpos, parsedBlocks, ATX_ERROR_TOO_MANY_BLOCKS);
    }

    const nextBitpos = bitpos + ATX_FRAME_BLOCK_TYPE_BITS;
    if (nextBitpos > frameBits) {
      return finishFrameUnpack(handle, bitpos, parsedBlocks, ATX_ERROR_BITPOS_OVERFLOW);
    }

    const block = handle.blocks[parsedBlocks];
    const regularBlock = block.regularBlock;
    if (!regularBlock || !regularBlock.shared) {
      return finishFrameUnpack(handle, bitpos, parsedBlocks, ATX_ERROR_UNPACK_FAILED);
    }

    const expectedChannels = atxChannelCountForRegularBlockType(blockType);
    if (
      (expectedChannels !== 1 && expectedChannels !== 2) ||
      expectedChannels !== regularBlock.shared.channels >>> 0
    ) {
      return finishFrameUnpack(handle, bitpos, parsedBlocks, ATX_ERROR_CHANNEL_MODE_MISMATCH);
    }
    regularBlock.shared.stereoFlag = expectedChannels === 2 ? 1 : 0;

    const state = { bitpos: nextBitpos >>> 0 };
    const ok = unpackChannelBlockAt5Reg(regularBlock, frame, state);
    if (state.error) {
      block.blockErrorCode = regularBlock.blockErrorCode >>> 0;
      return finishFrameUnpack(handle, state.bitpos, parsedBlocks, ATX_ERROR_BITSTREAM_OVERRUN);
    }

    if (!ok) {
      block.blockErrorCode = regularBlock.blockErrorCode >>> 0;
      return finishFrameUnpack(handle, state.bitpos, parsedBlocks, ATX_ERROR_UNPACK_FAILED);
    }

    block.blockErrorCode = regularBlock.blockErrorCode >>> 0;
    bitpos = state.bitpos >>> 0;
    parsedBlocks = (parsedBlocks + 1) >>> 0;
  }

  return finishFrameUnpack(handle, bitpos, parsedBlocks, ATX_ERROR_UNTERMINATED_FRAME);
}

export const ATX_FRAME_UNPACK_ERROR_CODES = {
  BAD_FRAME_HEADER: ATX_ERROR_BAD_FRAME_HEADER,
  BITPOS_OVERFLOW: ATX_ERROR_BITPOS_OVERFLOW,
  CHANNEL_MODE_MISMATCH: ATX_ERROR_CHANNEL_MODE_MISMATCH,
  UNPACK_FAILED: ATX_ERROR_UNPACK_FAILED,
  TOO_MANY_BLOCKS: ATX_ERROR_TOO_MANY_BLOCKS,
  MISSING_BLOCKS: ATX_ERROR_MISSING_BLOCKS,
  BITSTREAM_OVERRUN: ATX_ERROR_BITSTREAM_OVERRUN,
  UNTERMINATED_FRAME: ATX_ERROR_UNTERMINATED_FRAME,
  TYPE2_LENGTH: ATX_ERROR_TYPE2_LENGTH,
};
