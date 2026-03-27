import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeAtrac3plusRuntimeFrame,
  analyzeAtrac3plusSignalBlocks,
  prepareAtrac3plusInputFrame,
  buildAtrac3plusCodecConfig,
  createAtrac3plusEncodeHandle,
  createAtrac3plusEncodeRuntime,
  decodeAtrac3plusCodecConfig,
  encodeAtrac3plusRuntimeFrame,
  parseAtrac3plusCodecConfig,
  packAndProbeAtrac3plusFrameFromRegularBlocks,
  packAtrac3plusFrameFromRegularBlocks,
} from "../../../src/atrac3plus/encode.js";
import { unpackAtxFrame } from "../../../src/atrac3plus/bitstream/frame-unpack.js";
import { createAtxDecodeHandle } from "../../../src/atrac3plus/handle.js";

test("ATRAC3plus config helpers preserve representative codec bytes", () => {
  assert.deepEqual(Array.from(buildAtrac3plusCodecConfig(44100, 2, 560)), [0x28, 0x45]);
  assert.deepEqual(Array.from(buildAtrac3plusCodecConfig(48000, 7, 2048)), [0x5c, 0xff]);

  assert.deepEqual(parseAtrac3plusCodecConfig(Uint8Array.of(0x28, 0x45)), {
    sampleRate: 44100,
    mode: 2,
    frameBytes: 560,
  });
  assert.deepEqual(parseAtrac3plusCodecConfig(Uint8Array.of(0x5c, 0xff)), {
    sampleRate: 48000,
    mode: 7,
    frameBytes: 2048,
  });
  assert.deepEqual(decodeAtrac3plusCodecConfig(Uint8Array.of(0xe8, 0x45)), {
    sampleRateCode: 7,
    sampleRate: null,
    mode: 2,
    frameBytes: 560,
  });
});

test("createAtrac3plusEncodeHandle preserves representative block layouts and bit splits", () => {
  const stereo = createAtrac3plusEncodeHandle({
    sampleRate: 44100,
    mode: 2,
    frameBytes: 560,
    inputChannels: 2,
  });
  const surround = createAtrac3plusEncodeHandle({
    sampleRate: 44100,
    mode: 5,
    frameBytes: 1120,
    inputChannels: 6,
  });
  const eightChannel = createAtrac3plusEncodeHandle({
    sampleRate: 48000,
    mode: 7,
    frameBytes: 2048,
    inputChannels: 8,
  });

  assert.deepEqual(
    {
      bitrateKbps: stereo.bitrateKbps,
      primaryBlockMode: stereo.primaryBlockMode,
      bandwidthHz: stereo.bandwidthHz,
      blockCount: stereo.blockCount,
      requiredBlocks: stereo.requiredBlocks,
      blocks: stereo.blocks.map((block) => ({
        ready: block.ready,
        blockMode: block.blockMode,
        requestedBlockMode: block.requestedBlockMode,
        isMode4Block: block.isMode4Block,
        channelsInBlock: block.channelsInBlock,
        bitsForBlock: block.bitsForBlock,
        coreMode: block.coreMode,
        ispsIndex: block.ispsIndex,
      })),
    },
    {
      bitrateKbps: 96,
      primaryBlockMode: 3,
      bandwidthHz: 15159,
      blockCount: 1,
      requiredBlocks: 1,
      blocks: [
        {
          ready: true,
          blockMode: 3,
          requestedBlockMode: 3,
          isMode4Block: 0,
          channelsInBlock: 2,
          bitsForBlock: 4480,
          coreMode: 19,
          ispsIndex: 27,
        },
      ],
    }
  );

  assert.deepEqual(
    {
      bitrateKbps: surround.bitrateKbps,
      primaryBlockMode: surround.primaryBlockMode,
      bandwidthHz: surround.bandwidthHz,
      blockCount: surround.blockCount,
      requiredBlocks: surround.requiredBlocks,
      blocks: surround.blocks.map((block) => ({
        ready: block.ready,
        blockMode: block.blockMode,
        requestedBlockMode: block.requestedBlockMode,
        isMode4Block: block.isMode4Block,
        channelsInBlock: block.channelsInBlock,
        bitsForBlock: block.bitsForBlock,
        coreMode: block.coreMode,
      })),
    },
    {
      bitrateKbps: 192,
      primaryBlockMode: 3,
      bandwidthHz: 13781,
      blockCount: 4,
      requiredBlocks: 4,
      blocks: [
        {
          ready: true,
          blockMode: 3,
          requestedBlockMode: 3,
          isMode4Block: 0,
          channelsInBlock: 2,
          bitsForBlock: 3528,
          coreMode: 16,
        },
        {
          ready: true,
          blockMode: 1,
          requestedBlockMode: 1,
          isMode4Block: 0,
          channelsInBlock: 1,
          bitsForBlock: 1764,
          coreMode: 12,
        },
        {
          ready: true,
          blockMode: 3,
          requestedBlockMode: 3,
          isMode4Block: 0,
          channelsInBlock: 2,
          bitsForBlock: 3528,
          coreMode: 16,
        },
        {
          ready: true,
          blockMode: 1,
          requestedBlockMode: 4,
          isMode4Block: 1,
          channelsInBlock: 1,
          bitsForBlock: 136,
          coreMode: 0,
        },
      ],
    }
  );

  assert.deepEqual(
    {
      bitrateKbps: eightChannel.bitrateKbps,
      primaryBlockMode: eightChannel.primaryBlockMode,
      bandwidthHz: eightChannel.bandwidthHz,
      blockCount: eightChannel.blockCount,
      requiredBlocks: eightChannel.requiredBlocks,
      blocks: eightChannel.blocks.map((block) => ({
        ready: block.ready,
        blockMode: block.blockMode,
        requestedBlockMode: block.requestedBlockMode,
        isMode4Block: block.isMode4Block,
        channelsInBlock: block.channelsInBlock,
        bitsForBlock: block.bitsForBlock,
        coreMode: block.coreMode,
      })),
    },
    {
      bitrateKbps: 384,
      primaryBlockMode: 3,
      bandwidthHz: 15000,
      blockCount: 5,
      requiredBlocks: 5,
      blocks: [
        {
          ready: true,
          blockMode: 3,
          requestedBlockMode: 3,
          isMode4Block: 0,
          channelsInBlock: 2,
          bitsForBlock: 4642,
          coreMode: 20,
        },
        {
          ready: true,
          blockMode: 1,
          requestedBlockMode: 1,
          isMode4Block: 0,
          channelsInBlock: 1,
          bitsForBlock: 2321,
          coreMode: 15,
        },
        {
          ready: true,
          blockMode: 3,
          requestedBlockMode: 3,
          isMode4Block: 0,
          channelsInBlock: 2,
          bitsForBlock: 4642,
          coreMode: 20,
        },
        {
          ready: true,
          blockMode: 3,
          requestedBlockMode: 3,
          isMode4Block: 0,
          channelsInBlock: 2,
          bitsForBlock: 4642,
          coreMode: 20,
        },
        {
          ready: true,
          blockMode: 1,
          requestedBlockMode: 4,
          isMode4Block: 1,
          channelsInBlock: 1,
          bitsForBlock: 136,
          coreMode: 0,
        },
      ],
    }
  );
});

test("createAtrac3plusEncodeHandle preserves encode-mode flag gating", () => {
  const defaultMode = createAtrac3plusEncodeHandle({
    sampleRate: 48000,
    mode: 2,
    frameBytes: 512,
    inputChannels: 2,
    encodeMode: 1,
  });
  const modeTwo = createAtrac3plusEncodeHandle({
    sampleRate: 44100,
    mode: 2,
    frameBytes: 560,
    inputChannels: 2,
    encodeMode: 2,
  });

  assert.deepEqual(
    defaultMode.blocks.map((block) => ({
      coreMode: block.coreMode,
      encodeFlagCc: block.encodeFlagCc,
      encodeFlagD0: block.encodeFlagD0,
    })),
    [{ coreMode: 19, encodeFlagCc: 1, encodeFlagD0: 1 }]
  );
  assert.deepEqual(
    modeTwo.blocks.map((block) => ({
      coreMode: block.coreMode,
      encodeFlagCc: block.encodeFlagCc,
      encodeFlagD0: block.encodeFlagD0,
    })),
    [{ coreMode: 19, encodeFlagCc: 0, encodeFlagD0: 0 }]
  );
});

test("createAtrac3plusEncodeRuntime preserves runtime scratch layout", () => {
  const runtime = createAtrac3plusEncodeRuntime(
    createAtrac3plusEncodeHandle({
      sampleRate: 44100,
      mode: 5,
      frameBytes: 1120,
      inputChannels: 6,
    })
  );
  const [stereo, mono, secondStereo, mode4Block] = runtime.blocks;
  const channel0 = stereo.channelEntries[0];

  assert.equal(runtime.frameIndex, 0);
  assert.equal(runtime.handle.mode, 5);
  assert.equal(stereo.shared.coreMode, 16);
  assert.equal(stereo.shared.channels, 2);
  assert.equal(stereo.shared.sampleRateHz, 44100);
  assert.equal(stereo.shared.swapMap, stereo.shared.stereoSwapPresence.flags);
  assert.deepEqual(stereo.blockState, {
    blockIndex: 0,
    encodeMode: 0,
    isMode4Block: 0,
    sinusoidEncodeFlag: 1,
  });
  assert.equal(stereo.channelsInBlock, 2);
  assert.equal(mono.channelsInBlock, 1);
  assert.equal(secondStereo.channelsInBlock, 2);
  assert.equal(mode4Block.isMode4Block, 1);
  assert.equal(channel0.sharedAux, stereo.aux);
  assert.equal(channel0.blockState, stereo.blockState);
  assert.equal(channel0.curBuf, channel0.bufA);
  assert.equal(channel0.prevBuf, channel0.bufB);
  assert.equal(channel0.slots.length, 5);
  assert.equal(channel0.slots[0].sharedPtr, stereo.analysisGlobals[0]);
  assert.deepEqual(
    Array.from(channel0.table0.slice(0, 35)),
    [
      4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
      4, 0, 4, 4,
    ]
  );
  assert.deepEqual(Array.from(channel0.table1.slice(0, 35)), new Array(35).fill(4));
  assert.deepEqual(Array.from(channel0.windowScaleHistory.slice(0, 4)), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(channel0.stereoBandEnergyRatioHistory.slice(0, 4)), [1, 1, 1, 1]);
  assert.equal(channel0.gainPointHistoryBytes.length, 0x18000);
});

test("prepareAtrac3plusInputFrame preserves channel coercion, zero padding, and validation", () => {
  const monoToStereo = createAtrac3plusEncodeRuntime(
    createAtrac3plusEncodeHandle({
      sampleRate: 44100,
      mode: 2,
      frameBytes: 560,
      inputChannels: 1,
    })
  );
  const upmix = [new Float32Array(2048).fill(3), new Float32Array(2048).fill(9)];

  assert.equal(prepareAtrac3plusInputFrame(monoToStereo, upmix, 3), true);
  assert.equal(monoToStereo.handle.flushFramesRemaining, 8);
  assert.deepEqual(Array.from(upmix[0].slice(0, 6)), [3, 3, 3, 0, 0, 0]);
  assert.deepEqual(Array.from(upmix[1].slice(0, 6)), [3, 3, 3, 0, 0, 0]);

  const stereoToMono = createAtrac3plusEncodeRuntime(
    createAtrac3plusEncodeHandle({
      sampleRate: 44100,
      mode: 1,
      frameBytes: 280,
      inputChannels: 2,
      bitrateKbps: 48,
    })
  );
  const downmix = [new Float32Array(2048), new Float32Array(2048)];
  downmix[0].set([2, 6, 4]);
  downmix[1].set([10, 14, 8]);

  assert.equal(prepareAtrac3plusInputFrame(stereoToMono, downmix, 2), true);
  assert.equal(stereoToMono.handle.flushFramesRemaining, 8);
  assert.deepEqual(Array.from(downmix[0].slice(0, 4)), [6, 10, 4, 0]);

  assert.equal(prepareAtrac3plusInputFrame(stereoToMono, [new Float32Array(2048)], 2049), false);
  assert.equal(stereoToMono.handle.errorCode, 0x210);
});

test("analyzeAtrac3plusSignalBlocks preserves multiblock traversal and band counts", () => {
  const runtime = createAtrac3plusEncodeRuntime(
    createAtrac3plusEncodeHandle({
      sampleRate: 44100,
      mode: 5,
      frameBytes: 1120,
      inputChannels: 6,
    })
  );
  const planar = Array.from({ length: 6 }, () => new Float32Array(2048));
  const result = analyzeAtrac3plusSignalBlocks(runtime, planar);

  assert.deepEqual(
    {
      ok: result.ok,
      errorCode: result.errorCode,
      blockResults: result.blockResults.map(({ blockIndex, channels, bandCount }) => ({
        blockIndex,
        channels,
        bandCount,
      })),
    },
    {
      ok: true,
      errorCode: 0,
      blockResults: [
        { blockIndex: 0, channels: 2, bandCount: 10 },
        { blockIndex: 1, channels: 1, bandCount: 10 },
        { blockIndex: 2, channels: 2, bandCount: 10 },
        { blockIndex: 3, channels: 1, bandCount: 1 },
      ],
    }
  );
});

test("analyzeAtrac3plusRuntimeFrame preserves preparation, analysis, and frame reuse", () => {
  const runtime = createAtrac3plusEncodeRuntime(
    createAtrac3plusEncodeHandle({
      sampleRate: 44100,
      mode: 2,
      frameBytes: 560,
      inputChannels: 2,
    })
  );
  const planar = [new Float32Array(2048), new Float32Array(2048)];
  planar[0].set([2, 4, 6]);
  planar[1].set([8, 10, 12]);

  const result = analyzeAtrac3plusRuntimeFrame(runtime, planar, 2);

  assert.deepEqual(
    {
      ok: result.ok,
      errorCode: result.errorCode,
      blockResults: result.blockResults.map(({ blockIndex, channels, bandCount }) => ({
        blockIndex,
        channels,
        bandCount,
      })),
      flushFramesRemaining: runtime.handle.flushFramesRemaining,
      leftSamples: Array.from(planar[0].slice(0, 4)),
      rightSamples: Array.from(planar[1].slice(0, 4)),
    },
    {
      ok: true,
      errorCode: 0,
      blockResults: [{ blockIndex: 0, channels: 2, bandCount: 11 }],
      flushFramesRemaining: 8,
      leftSamples: [2, 4, 0, 0],
      rightSamples: [8, 10, 0, 0],
    }
  );
});

test("packAtrac3plusFrameFromRegularBlocks round-trips a minimal mono frame", () => {
  const handle = createAtrac3plusEncodeHandle({
    sampleRate: 44100,
    mode: 1,
    frameBytes: 280,
    inputChannels: 1,
    bitrateKbps: 48,
  });
  const runtime = createAtrac3plusEncodeRuntime(handle);
  const packed = packAtrac3plusFrameFromRegularBlocks(handle, runtime.blocks);

  assert.equal(packed.ok, true);
  assert.equal(packed.bitpos, 20);

  const decodeHandle = createAtxDecodeHandle({
    sampleRate: 44100,
    mode: 1,
    frameBytes: 280,
    outputChannels: 1,
  });
  assert.deepEqual(unpackAtxFrame(decodeHandle, packed.frame), {
    ok: true,
    bitpos: 18,
    parsedBlocks: 1,
    errorCode: 0,
  });
  assert.equal(decodeHandle.blocks[0].regularBlock.shared.codedBandLimit, 1);
  assert.equal(decodeHandle.blocks[0].regularBlock.shared.idsfCount, 0);
});

test("packAtrac3plusFrameFromRegularBlocks round-trips a minimal stereo frame", () => {
  const handle = createAtrac3plusEncodeHandle({
    sampleRate: 44100,
    mode: 2,
    frameBytes: 560,
    inputChannels: 2,
  });
  const runtime = createAtrac3plusEncodeRuntime(handle);
  const packed = packAtrac3plusFrameFromRegularBlocks(handle, runtime.blocks);

  assert.equal(packed.ok, true);

  const decodeHandle = createAtxDecodeHandle({
    sampleRate: 44100,
    mode: 2,
    frameBytes: 560,
    outputChannels: 2,
  });
  const unpacked = unpackAtxFrame(decodeHandle, packed.frame);

  assert.equal(unpacked.ok, true);
  assert.equal(unpacked.parsedBlocks, 1);
  assert.equal(decodeHandle.blocks[0].regularBlock.shared.channels, 2);
  assert.equal(decodeHandle.blocks[0].regularBlock.shared.stereoFlag, 1);
});

test("packAtrac3plusFrameFromRegularBlocks traces without writing to stderr", () => {
  const previousTrace = process.env.CARTA_TRACE_ATX_PACK;
  const originalConsoleError = console.error;
  process.env.CARTA_TRACE_ATX_PACK = "1";

  let called = false;
  console.error = () => {
    called = true;
  };

  try {
    const handle = createAtrac3plusEncodeHandle({
      sampleRate: 44100,
      mode: 1,
      frameBytes: 280,
      inputChannels: 1,
      bitrateKbps: 48,
    });
    const runtime = createAtrac3plusEncodeRuntime(handle);
    const packed = packAtrac3plusFrameFromRegularBlocks(handle, runtime.blocks);

    assert.equal(packed.ok, true);
    assert.ok(Array.isArray(packed.trace));
    assert.ok(packed.trace.length >= 2);
    assert.equal(called, false);
  } finally {
    console.error = originalConsoleError;
    if (previousTrace === undefined) {
      delete process.env.CARTA_TRACE_ATX_PACK;
    } else {
      process.env.CARTA_TRACE_ATX_PACK = previousTrace;
    }
  }
});

test("packAndProbeAtrac3plusFrameFromRegularBlocks preserves current probe diagnostics", () => {
  const handle = createAtrac3plusEncodeHandle({
    sampleRate: 44100,
    mode: 1,
    frameBytes: 280,
    inputChannels: 1,
    bitrateKbps: 48,
  });
  const runtime = createAtrac3plusEncodeRuntime(handle);
  const packed = packAndProbeAtrac3plusFrameFromRegularBlocks(handle, runtime.blocks);

  assert.deepEqual(
    {
      ok: packed.ok,
      bitpos: packed.bitpos,
      unpack: packed.unpack,
    },
    {
      ok: true,
      bitpos: 20,
      unpack: {
        ok: true,
        bitpos: 18,
        parsedBlocks: 1,
        errorCode: 0,
        blockErrorCode: 0,
        regularBlockErrorCode: 0,
        channelBlockErrorCodes: [0],
      },
    }
  );
});

test("encodeAtrac3plusRuntimeFrame preserves delay-frame and debug bookkeeping", () => {
  const runtime = createAtrac3plusEncodeRuntime(
    createAtrac3plusEncodeHandle({
      sampleRate: 44100,
      mode: 2,
      frameBytes: 560,
      inputChannels: 2,
    })
  );
  const fullFrame = [new Float32Array(2048), new Float32Array(2048)];
  const flushFrame = [new Float32Array(2048), new Float32Array(2048)];
  let packed = null;

  for (let pass = 0; pass < 8; pass += 1) {
    packed = encodeAtrac3plusRuntimeFrame(
      runtime,
      pass === 0 ? fullFrame : flushFrame,
      pass === 0 ? 2048 : 0
    );
    if (pass < 7) {
      assert.equal(packed, null);
      assert.equal(runtime.lastEncodeDebug, null);
    }
  }

  assert.ok(packed instanceof Uint8Array);
  assert.equal(packed.length, 560);
  assert.deepEqual(
    {
      frameIndex: runtime.frameIndex,
      debugFrameIndex: runtime.lastEncodeDebug?.frameIndex ?? null,
      debugBudgetBits: runtime.lastEncodeDebug?.budgetBits ?? null,
      debugUsedBits: runtime.lastEncodeDebug?.usedBits ?? null,
      debugUseExactQuant: runtime.lastEncodeDebug?.useExactQuant ?? null,
    },
    {
      frameIndex: 8,
      debugFrameIndex: 7,
      debugBudgetBits: 4475,
      debugUsedBits: 51,
      debugUseExactQuant: true,
    }
  );
});

test("ATRAC3plus encode handle helpers preserve current validation errors", () => {
  assert.throws(
    () => parseAtrac3plusCodecConfig(Uint8Array.of(0x28)),
    /codec config requires 2 bytes/
  );
  assert.throws(
    () => parseAtrac3plusCodecConfig(Uint8Array.of(0xe8, 0x45)),
    /unsupported ATRAC3plus sample rate code: 7/
  );
  assert.throws(
    () =>
      createAtrac3plusEncodeHandle({
        sampleRate: 32000,
        mode: 2,
        frameBytes: 560,
        inputChannels: 2,
      }),
    /unsupported ATRAC3plus sample rate: 32000/
  );
  assert.throws(
    () =>
      createAtrac3plusEncodeHandle({
        sampleRate: 44100,
        mode: 0,
        frameBytes: 560,
        inputChannels: 2,
      }),
    /unsupported ATRAC3plus mode: 0/
  );
  assert.throws(
    () =>
      createAtrac3plusEncodeHandle({
        sampleRate: 44100,
        mode: 2,
        frameBytes: 562,
        inputChannels: 2,
      }),
    /invalid ATRAC3plus frame byte count: 562/
  );
  assert.throws(
    () =>
      createAtrac3plusEncodeHandle({
        sampleRate: 44100,
        mode: 2,
        frameBytes: 560,
        inputChannels: 0,
      }),
    /invalid ATRAC3plus input channel count: 0/
  );
  assert.throws(
    () =>
      createAtrac3plusEncodeHandle({
        sampleRate: 44100,
        mode: 2,
        frameBytes: 560,
        inputChannels: 2,
        encodeMode: 9,
      }),
    /invalid ATRAC3plus encode mode: 9/
  );
  assert.throws(
    () =>
      createAtrac3plusEncodeHandle({
        sampleRate: 44100,
        mode: 5,
        frameBytes: 1528,
        inputChannels: 6,
      }),
    /unsupported ATRAC3plus encode setting: sampleRate=44100 mode=5 frameBytes=1528/
  );
});
