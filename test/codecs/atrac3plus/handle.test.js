import assert from "node:assert/strict";
import test from "node:test";

import { createAtxDecodeHandle } from "../../../src/atrac3plus/handle.js";

test("createAtxDecodeHandle preserves representative block topologies", () => {
  const stereo = createAtxDecodeHandle({
    sampleRate: 44100,
    mode: 2,
    frameBytes: 560,
    outputChannels: 2,
  });
  const surround = createAtxDecodeHandle({
    sampleRate: 44100,
    mode: 5,
    frameBytes: 1528,
    outputChannels: 6,
  });
  const eightChannel = createAtxDecodeHandle({
    sampleRate: 48000,
    mode: 7,
    frameBytes: 2240,
    outputChannels: 8,
  });

  assert.deepEqual(
    {
      streamChannels: stereo.streamChannels,
      blockCount: stereo.blockCount,
      requiredBlocks: stereo.requiredBlocks,
      blockChannels: stereo.blockChannels,
      ready: stereo.blocks.map((block) => block.ready),
      mode4Flags: stereo.blocks.map((block) => block.isMode4Block),
      channelsInBlock: stereo.blocks.map((block) => block.channelsInBlock),
      regularBlockChannels: stereo.blocks.map((block) => block.regularBlock?.channels.length ?? 0),
    },
    {
      streamChannels: 2,
      blockCount: 1,
      requiredBlocks: 1,
      blockChannels: [2],
      ready: [true],
      mode4Flags: [0],
      channelsInBlock: [2],
      regularBlockChannels: [2],
    }
  );

  assert.deepEqual(
    {
      streamChannels: surround.streamChannels,
      blockCount: surround.blockCount,
      requiredBlocks: surround.requiredBlocks,
      blockChannels: surround.blockChannels,
      ready: surround.blocks.map((block) => block.ready),
      mode4Flags: surround.blocks.map((block) => block.isMode4Block),
      channelsInBlock: surround.blocks.map((block) => block.channelsInBlock),
    },
    {
      streamChannels: 6,
      blockCount: 4,
      requiredBlocks: 4,
      blockChannels: [2, 1, 2, 1],
      ready: [true, true, true, true],
      mode4Flags: [0, 0, 0, 1],
      channelsInBlock: [2, 1, 2, 1],
    }
  );

  assert.deepEqual(
    {
      streamChannels: eightChannel.streamChannels,
      blockCount: eightChannel.blockCount,
      requiredBlocks: eightChannel.requiredBlocks,
      blockChannels: eightChannel.blockChannels,
      ready: eightChannel.blocks.map((block) => block.ready),
      mode4Flags: eightChannel.blocks.map((block) => block.isMode4Block),
      channelsInBlock: eightChannel.blocks.map((block) => block.channelsInBlock),
    },
    {
      streamChannels: 8,
      blockCount: 5,
      requiredBlocks: 5,
      blockChannels: [2, 1, 2, 2, 1],
      ready: [true, true, true, true, true],
      mode4Flags: [0, 0, 0, 0, 1],
      channelsInBlock: [2, 1, 2, 2, 1],
    }
  );
});

test("createAtxDecodeHandle preserves current validation errors", () => {
  assert.throws(() => createAtxDecodeHandle(null), /config must be an object/);
  assert.throws(
    () => createAtxDecodeHandle({ sampleRate: 32000, mode: 2, frameBytes: 560, outputChannels: 2 }),
    /unsupported ATRAC3plus sample rate: 32000/
  );
  assert.throws(
    () => createAtxDecodeHandle({ sampleRate: 44100, mode: 0, frameBytes: 560, outputChannels: 2 }),
    /unsupported ATRAC3plus mode: 0/
  );
  assert.throws(
    () => createAtxDecodeHandle({ sampleRate: 44100, mode: 2, frameBytes: 562, outputChannels: 2 }),
    /invalid ATRAC3plus frame byte count: 562/
  );
  assert.throws(
    () => createAtxDecodeHandle({ sampleRate: 44100, mode: 2, frameBytes: 560, outputChannels: 0 }),
    /invalid ATRAC3plus output channel count: 0/
  );
  assert.throws(
    () => createAtxDecodeHandle({ sampleRate: 44100, mode: 2, frameBytes: 560, outputChannels: 6 }),
    /unsupported ATRAC3plus output channel count: 6 for streamChannels=2/
  );
});
