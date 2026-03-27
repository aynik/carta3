import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import { computeIdwlBitsAt5 } from "../../../src/atrac3plus/channel-block/packed-state.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";

function createIdwlBitsFixture({ bandLimit = 1, idwlEnabled = 1, idwlInitialized = 0 } = {}) {
  const regularBlock = createAt5RegularBlockState(1);
  regularBlock.shared.bandLimit = bandLimit;
  const [channel] = regularBlock.channels;
  const block = createChannelBlock();
  block.idwlScratch.work = block.idwlWork;

  const hdr = createBitallocHeader(1);
  hdr.idwlEnabled = idwlEnabled;
  hdr.idwlInitialized = idwlInitialized;

  return { hdr, blocks: [block], channels: [channel] };
}

test("computeIdwlBitsAt5 advances from init to incremental IDWL sizing", () => {
  const fixture = createIdwlBitsFixture();

  const initBits = computeIdwlBitsAt5(fixture.hdr, fixture.channels, fixture.blocks, 1);
  const incrementalBits = computeIdwlBitsAt5(
    fixture.hdr,
    fixture.channels,
    fixture.blocks,
    1,
    0,
    0
  );

  assert.equal(initBits, 5);
  assert.equal(incrementalBits, 5);
  assert.equal(fixture.hdr.idwlInitialized, 1);
  assert.equal(fixture.blocks[0].idwlScratch.bestConfigSlot, 0);
});

test("computeIdwlBitsAt5 seeds disabled-IDWL scratch state from bandLimit", () => {
  const fixture = createIdwlBitsFixture({
    bandLimit: 3,
    idwlEnabled: 0,
  });

  const bits = computeIdwlBitsAt5(fixture.hdr, fixture.channels, fixture.blocks, 1);

  assert.equal(bits, 11);
  assert.equal(fixture.hdr.idwlInitialized, 0);
  assert.equal(fixture.blocks[0].idwlScratch.bestConfigSlot, 0);
  assert.deepEqual(Array.from(fixture.blocks[0].idwlScratch.slot0Config), [0, 0, 3, 0, 0]);
});
