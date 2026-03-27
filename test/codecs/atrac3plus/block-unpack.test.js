import assert from "node:assert/strict";
import test from "node:test";

import {
  createAt5RegularBlockState,
  at5ActiveBandCount,
} from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  AT5_CHANNEL_BLOCK_ERROR_CODES,
  unpackChannelBlockAt5Reg,
} from "../../../src/atrac3plus/bitstream/block-regular.js";
import {
  ATX_FRAME_UNPACK_ERROR_CODES,
  unpackAtxFrame,
} from "../../../src/atrac3plus/bitstream/frame-unpack.js";
import { packChannelBlockAt5Reg } from "../../../src/atrac3plus/bitstream/block-regular.js";
import { at5PackStoreFromMsb } from "../../../src/atrac3plus/bitstream/bitstream.js";

function packBits(fields, { bytes = 64, bitpos = 0 } = {}) {
  const frame = new Uint8Array(bytes);
  const state = { bitpos };

  for (const [value, bits] of fields) {
    assert.equal(at5PackStoreFromMsb(value, bits, frame, state), true);
  }

  return { frame, bitpos: state.bitpos >>> 0 };
}

function zeroedRegularBlockFields(idwlLimit, channelCount) {
  const fields = [
    [(idwlLimit - 1) >>> 0, 5],
    [0, 1],
  ];

  for (let channel = 0; channel < channelCount; channel += 1) {
    fields.push([0, 2]);
    for (let band = 0; band < idwlLimit; band += 1) {
      fields.push([0, 3]);
    }
  }

  if (channelCount === 2) {
    fields.push([0, 1], [0, 1]);
  }

  for (let channel = 0; channel < channelCount; channel += 1) {
    fields.push([0, 1]);
  }
  for (let channel = 0; channel < channelCount; channel += 1) {
    fields.push([0, 1]);
  }

  fields.push([0, 1], [0, 1]);
  return fields;
}

function createUnpackHandle(channelCount, frameBytes = 8) {
  return {
    blockCount: 1,
    frameBytes,
    errorCode: 0,
    blocks: [
      {
        blockErrorCode: 0,
        regularBlock: createAt5RegularBlockState(channelCount),
      },
    ],
  };
}

test("at5ActiveBandCount trims only trailing inactive mono and stereo bands", () => {
  assert.equal(at5ActiveBandCount(Uint32Array.from([1, 0, 0, 0]), null, 4, 1), 1);
  assert.equal(
    at5ActiveBandCount(Uint32Array.from([1, 0, 0, 0]), Uint32Array.from([0, 0, 2, 0]), 4, 2),
    3
  );
  assert.equal(
    at5ActiveBandCount(Uint32Array.from([1, 0, 0, 3]), Uint32Array.from([0, 0, 0, 0]), 4, 2),
    4
  );
  assert.equal(at5ActiveBandCount(Uint32Array.of(), Uint32Array.of(), 0, 2), 0);
});

test("createAt5RegularBlockState links secondary channel state back to channel 0", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;

  assert.equal(left.block0, left);
  assert.equal(right.block0, left);
  assert.equal(right.shared, left.shared);

  assert.notEqual(right.idwl, left.idwl);
  assert.notEqual(right.idsf, left.idsf);
  assert.notEqual(right.idct, left.idct);
  assert.notEqual(right.gain, left.gain);
  assert.notEqual(right.gh, left.gh);

  assert.equal(right.idwlState.block0, left.idwlState);
  assert.equal(right.idsfState.block0, left.idsfState);
  assert.equal(right.idctState.block0, left.idctState);
  assert.equal(right.gainState.block0, left.gainState);
  assert.equal(right.ghState.block0, left.ghState);
});

test("unpackChannelBlockAt5Reg decodes a minimal mono block with no active bands", () => {
  const block = createAt5RegularBlockState(1);
  const { frame, bitpos } = packBits(zeroedRegularBlockFields(1, 1));
  const state = { bitpos: 0 };

  assert.equal(unpackChannelBlockAt5Reg(block, frame, state), true);
  assert.equal(state.bitpos, bitpos);
  assert.equal(block.blockErrorCode, 0);
  assert.deepEqual(
    {
      codedBandLimit: block.shared.codedBandLimit,
      idsfCount: block.shared.idsfCount,
      mapCount: block.shared.mapCount,
      mapSegmentCount: block.shared.mapSegmentCount,
      noiseFillEnabled: block.shared.noiseFillEnabled,
      zeroSpectraFlag: block.shared.zeroSpectraFlag,
    },
    {
      codedBandLimit: 1,
      idsfCount: 0,
      mapCount: 1,
      mapSegmentCount: 1,
      noiseFillEnabled: 0,
      zeroSpectraFlag: 0,
    }
  );
  assert.equal(block.channels[0].gain.hasData, 0);
  assert.equal(block.ghShared.headers[1].enabled, 0);
  assert.equal(block.ghShared.headers[1].bandCount, 0);
});

test("unpackChannelBlockAt5Reg keeps BAD_IDWL_LIMIT while finishing a zeroed block", () => {
  const block = createAt5RegularBlockState(1);
  const { frame, bitpos } = packBits(zeroedRegularBlockFields(29, 1), { bytes: 32 });
  const state = { bitpos: 0 };

  assert.equal(unpackChannelBlockAt5Reg(block, frame, state), true);
  assert.equal(state.bitpos, bitpos);
  assert.equal(block.blockErrorCode, AT5_CHANNEL_BLOCK_ERROR_CODES.BAD_IDWL_LIMIT);
  assert.equal(block.shared.codedBandLimit, 29);
  assert.equal(block.idwlShared.codedBandLimit, 29);
  assert.equal(block.shared.idsfCount, 0);
});

test("packChannelBlockAt5Reg round-trips zeroed-spectrum and noise-fill metadata", () => {
  const block = createAt5RegularBlockState(1);
  block.shared.bandLimit = 1;
  block.shared.codedBandLimit = 1;
  block.shared.zeroSpectraFlag = 1;
  block.shared.noiseFillEnabled = 1;
  block.shared.noiseFillShift = 3;
  block.shared.noiseFillCursor = 5;

  const frame = new Uint8Array(64);
  const writeState = { bitpos: 0 };
  assert.equal(packChannelBlockAt5Reg(block, frame, writeState), true);

  const unpacked = createAt5RegularBlockState(1);
  const readState = { bitpos: 0 };
  assert.equal(unpackChannelBlockAt5Reg(unpacked, frame, readState), true);
  assert.equal(readState.bitpos, writeState.bitpos);
  assert.equal(unpacked.shared.zeroSpectraFlag, 1);
  assert.equal(unpacked.shared.noiseFillEnabled, 1);
  assert.equal(unpacked.shared.noiseFillShift, 3);
  assert.equal(unpacked.shared.noiseFillCursor, 5);
});

test("unpackAtxFrame decodes a minimal mono frame end to end", () => {
  const handle = createUnpackHandle(1);
  const { frame } = packBits([[0, 2], ...zeroedRegularBlockFields(1, 1), [3, 2]], {
    bytes: handle.frameBytes,
    bitpos: 1,
  });

  const result = unpackAtxFrame(handle, frame);

  assert.deepEqual(
    {
      ok: result.ok,
      parsedBlocks: result.parsedBlocks,
      errorCode: result.errorCode,
      handleErrorCode: handle.errorCode,
      blockErrorCode: handle.blocks[0].blockErrorCode,
    },
    {
      ok: true,
      parsedBlocks: 1,
      errorCode: 0,
      handleErrorCode: 0,
      blockErrorCode: 0,
    }
  );
});

test("unpackAtxFrame clears stale block errors before rejecting a bad frame header", () => {
  const handle = createUnpackHandle(1);
  handle.errorCode = 123;
  handle.blocks[0].blockErrorCode = 456;

  const result = unpackAtxFrame(handle, Uint8Array.of(0x80));

  assert.deepEqual(
    {
      ok: result.ok,
      parsedBlocks: result.parsedBlocks,
      errorCode: result.errorCode,
      handleErrorCode: handle.errorCode,
      blockErrorCode: handle.blocks[0].blockErrorCode,
    },
    {
      ok: false,
      parsedBlocks: 0,
      errorCode: ATX_FRAME_UNPACK_ERROR_CODES.BAD_FRAME_HEADER,
      handleErrorCode: ATX_FRAME_UNPACK_ERROR_CODES.BAD_FRAME_HEADER,
      blockErrorCode: 0,
    }
  );
});

test("unpackAtxFrame rejects a block type that mismatches the regular block channel mode", () => {
  const handle = createUnpackHandle(2);
  const { frame } = packBits([[0, 2]], { bytes: handle.frameBytes, bitpos: 1 });

  const result = unpackAtxFrame(handle, frame);

  assert.deepEqual(
    {
      ok: result.ok,
      parsedBlocks: result.parsedBlocks,
      errorCode: result.errorCode,
      handleErrorCode: handle.errorCode,
      blockErrorCode: handle.blocks[0].blockErrorCode,
    },
    {
      ok: false,
      parsedBlocks: 0,
      errorCode: ATX_FRAME_UNPACK_ERROR_CODES.CHANNEL_MODE_MISMATCH,
      handleErrorCode: ATX_FRAME_UNPACK_ERROR_CODES.CHANNEL_MODE_MISMATCH,
      blockErrorCode: 0,
    }
  );
});

test("unpackAtxFrame skips type-2 blocks before decoding the next regular block", () => {
  const handle = createUnpackHandle(1);
  const { frame, bitpos } = packBits(
    [[2, 2], [0, 5], [1, 11], [0, 8], [0, 2], ...zeroedRegularBlockFields(1, 1), [3, 2]],
    { bytes: handle.frameBytes, bitpos: 1 }
  );

  const result = unpackAtxFrame(handle, frame);

  assert.deepEqual(
    {
      ok: result.ok,
      bitpos: result.bitpos,
      parsedBlocks: result.parsedBlocks,
      errorCode: result.errorCode,
      blockErrorCode: handle.blocks[0].blockErrorCode,
      idsfCount: handle.blocks[0].regularBlock.shared.idsfCount,
    },
    {
      ok: true,
      bitpos: bitpos - 2,
      parsedBlocks: 1,
      errorCode: 0,
      blockErrorCode: 0,
      idsfCount: 0,
    }
  );
});

test("unpackAtxFrame rejects type-2 blocks with the reserved length sentinel", () => {
  const handle = createUnpackHandle(1);
  const { frame } = packBits(
    [
      [2, 2],
      [0, 5],
      [0x7ff, 11],
    ],
    { bytes: handle.frameBytes, bitpos: 1 }
  );

  const result = unpackAtxFrame(handle, frame);

  assert.deepEqual(
    {
      ok: result.ok,
      parsedBlocks: result.parsedBlocks,
      errorCode: result.errorCode,
      handleErrorCode: handle.errorCode,
    },
    {
      ok: false,
      parsedBlocks: 0,
      errorCode: ATX_FRAME_UNPACK_ERROR_CODES.TYPE2_LENGTH,
      handleErrorCode: ATX_FRAME_UNPACK_ERROR_CODES.TYPE2_LENGTH,
    }
  );
});

test("unpackAtxFrame rejects a frame terminator before all required blocks", () => {
  const handle = createUnpackHandle(1);
  const { frame } = packBits([[3, 2]], { bytes: handle.frameBytes, bitpos: 1 });

  const result = unpackAtxFrame(handle, frame);

  assert.deepEqual(
    {
      ok: result.ok,
      parsedBlocks: result.parsedBlocks,
      errorCode: result.errorCode,
      handleErrorCode: handle.errorCode,
    },
    {
      ok: false,
      parsedBlocks: 0,
      errorCode: ATX_FRAME_UNPACK_ERROR_CODES.MISSING_BLOCKS,
      handleErrorCode: ATX_FRAME_UNPACK_ERROR_CODES.MISSING_BLOCKS,
    }
  );
});
