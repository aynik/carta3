import assert from "node:assert/strict";
import test from "node:test";

import { createAtxDecodeHandle } from "../../../src/atrac3plus/handle.js";
import {
  AT5_CHANNEL_BLOCK_ERROR_CODES,
  ATX_FRAME_UNPACK_ERROR_CODES,
  unpackAtxFrame,
} from "../../../src/atrac3plus/bitstream/index.js";
import * as BitstreamInternal from "../../../src/atrac3plus/bitstream/internal.js";

test("AT5 bit readers mark overruns on the shared bitState", () => {
  const frame = new Uint8Array([0xff]);
  const bitState = { bitpos: 7 };

  assert.equal(BitstreamInternal.at5ReadBits(frame, bitState, 2), 0);
  assert.equal(bitState.error, true);
});

test("unpackAtxFrame returns BITSTREAM_OVERRUN when a block reads past the frame", () => {
  const handle = createAtxDecodeHandle({
    sampleRate: 44100,
    mode: 1,
    frameBytes: 8,
    outputChannels: 1,
  });

  const frame = new Uint8Array(8);
  frame[0] = 0x1f; // sync=0, blockType=mono, codedBandLimitMinus1=31 (forces a read overrun)

  const result = unpackAtxFrame(handle, frame);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, ATX_FRAME_UNPACK_ERROR_CODES.BITSTREAM_OVERRUN);
  assert.equal(
    handle.blocks[0].blockErrorCode >>> 0,
    AT5_CHANNEL_BLOCK_ERROR_CODES.BITSTREAM_OVERRUN
  );
});
