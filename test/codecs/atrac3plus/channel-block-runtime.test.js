import assert from "node:assert/strict";
import test from "node:test";

import { createAt5PresenceTable } from "../../../src/atrac3plus/bitstream/bitstream.js";
import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import { AT5_ISPS } from "../../../src/atrac3plus/tables/unpack.js";
import {
  applySwapMapToSpectraInPlace,
  applyRuntimeStereoSwapPresence,
  buildSwapAdjustedSpectra,
  clearBandTail,
  copyGainRecordsFromRuntime,
  copyPresenceFromRuntime,
} from "../../../src/atrac3plus/channel-block/runtime.js";

function seedPresenceTable(table) {
  table.enabled = 1;
  table.mixed = 1;
  table.flags.fill(1);
  return table;
}

test("copyPresenceFromRuntime resets stale state and prefers copied flags", () => {
  const channel = {
    channelPresence: seedPresenceTable(createAt5PresenceTable()),
  };

  copyPresenceFromRuntime(
    channel,
    {
      curBuf: {
        tlevFlagsCopy: Uint32Array.of(1, 0, 1),
        records: [{ tlevFlag: 0 }, { tlevFlag: 1 }, { tlevFlag: 0 }],
      },
    },
    3
  );

  assert.equal(channel.channelPresence.enabled, 1);
  assert.equal(channel.channelPresence.mixed, 1);
  assert.deepEqual(Array.from(channel.channelPresence.flags.slice(0, 5)), [1, 0, 1, 0, 0]);
});

test("copyPresenceFromRuntime falls back to record flags and clears missing runtime data", () => {
  const channel = {
    channelPresence: createAt5PresenceTable(),
  };

  copyPresenceFromRuntime(
    channel,
    {
      curBuf: {
        records: [{ tlevFlag: 1 }, { tlevFlag: 1 }, { tlevFlag: 1 }],
      },
    },
    3
  );

  assert.equal(channel.channelPresence.enabled, 1);
  assert.equal(channel.channelPresence.mixed, 0);
  assert.deepEqual(Array.from(channel.channelPresence.flags.slice(0, 5)), [1, 1, 1, 0, 0]);

  seedPresenceTable(channel.channelPresence);
  copyPresenceFromRuntime(channel, null, 3);

  assert.equal(channel.channelPresence.enabled, 0);
  assert.equal(channel.channelPresence.mixed, 0);
  assert.deepEqual(Array.from(channel.channelPresence.flags.slice(0, 5)), [0, 0, 0, 0, 0]);
});

test("copyPresenceFromRuntime falls back to bufA when curBuf is missing", () => {
  const channel = {
    channelPresence: createAt5PresenceTable(),
  };

  copyPresenceFromRuntime(
    channel,
    {
      bufA: {
        records: [{ tlevFlag: 0 }, { tlevFlag: 1 }, { tlevFlag: 1 }],
      },
    },
    3
  );

  assert.equal(channel.channelPresence.enabled, 1);
  assert.equal(channel.channelPresence.mixed, 1);
  assert.deepEqual(Array.from(channel.channelPresence.flags.slice(0, 5)), [0, 1, 1, 0, 0]);
});

test("clearBandTail clears staged metadata from the requested band onward", () => {
  const [channel] = createAt5RegularBlockState(1).channels;
  const start = AT5_ISPS[2] >>> 0;

  channel.idwl.values.fill(5);
  channel.idsf.values.fill(7);
  channel.scratchSpectra.fill(3);

  clearBandTail(channel, 2);

  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [5, 5, 0, 0]);
  assert.deepEqual(Array.from(channel.idsf.values.slice(0, 4)), [7, 7, 0, 0]);
  assert.equal(channel.scratchSpectra[start - 1], 3);
  assert.equal(channel.scratchSpectra[start], 0);
});

test("copyGainRecordsFromRuntime normalizes locations and trims inactive tails", () => {
  const [channel] = createAt5RegularBlockState(1).channels;

  copyGainRecordsFromRuntime(
    channel,
    {
      curBuf: {
        records: [
          {
            entries: 4,
            locations: Int32Array.from([-5, 0, 0, 40]),
            levels: Int32Array.from([-3, 20, 7, 2]),
          },
          {
            entries: 2,
            locations: Int32Array.from([31, 31]),
            levels: Int32Array.from([3, 4]),
          },
          {
            entries: 0,
            locations: new Int32Array(7),
            levels: new Int32Array(7),
          },
        ],
      },
    },
    3
  );

  assert.equal(channel.gain.hasData, 1);
  assert.equal(channel.gain.activeCount, 2);
  assert.equal(channel.gain.uniqueCount, 2);
  assert.equal(channel.gain.hasDeltaFlag, 0);
  assert.deepEqual(Array.from(channel.gain.records[0].locations.slice(0, 4)), [0, 1, 2, 31]);
  assert.deepEqual(Array.from(channel.gain.records[0].levels.slice(0, 4)), [0, 15, 7, 2]);
  assert.equal(channel.gain.records[0].entries, 4);
  assert.deepEqual(Array.from(channel.gain.records[1].locations.slice(0, 3)), [31, 0, 0]);
  assert.deepEqual(Array.from(channel.gain.records[1].levels.slice(0, 3)), [3, 0, 0]);
  assert.equal(channel.gain.records[1].entries, 1);
  assert.equal(channel.gain.ngcMode, 0);
  assert.equal(channel.gain.idlevMode, 0);
  assert.equal(channel.gain.idlocMode, 0);
});

test("copyGainRecordsFromRuntime clears stale gain records when runtime data is missing", () => {
  const [channel] = createAt5RegularBlockState(1).channels;
  channel.gain.records[0].entries = 1;
  channel.gain.records[0].locations[0] = 9;
  channel.gain.records[0].levels[0] = 6;
  channel.gain.ngcMode = 3;
  channel.gain.idlevMode = 4;
  channel.gain.idlocMode = 5;

  copyGainRecordsFromRuntime(channel, null, 2);

  assert.equal(channel.gain.hasData, 0);
  assert.equal(channel.gain.activeCount, 0);
  assert.equal(channel.gain.uniqueCount, 0);
  assert.equal(channel.gain.records[0].entries, 0);
  assert.deepEqual(Array.from(channel.gain.records[0].locations.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(channel.gain.records[0].levels.slice(0, 3)), [0, 0, 0]);
  assert.equal(channel.gain.ngcMode, 0);
  assert.equal(channel.gain.idlevMode, 0);
  assert.equal(channel.gain.idlocMode, 0);
});

test("copyGainRecordsFromRuntime falls back to bufA when curBuf is missing", () => {
  const [channel] = createAt5RegularBlockState(1).channels;

  copyGainRecordsFromRuntime(
    channel,
    {
      bufA: {
        records: [
          {
            entries: 2,
            locations: Int32Array.from([4, 7]),
            levels: Int32Array.from([3, 5]),
          },
        ],
      },
    },
    1
  );

  assert.equal(channel.gain.hasData, 1);
  assert.equal(channel.gain.activeCount, 1);
  assert.equal(channel.gain.uniqueCount, 1);
  assert.equal(channel.gain.records[0].entries, 2);
  assert.deepEqual(Array.from(channel.gain.records[0].locations.slice(0, 3)), [4, 7, 0]);
  assert.deepEqual(Array.from(channel.gain.records[0].levels.slice(0, 3)), [3, 5, 0]);
});

test("buildSwapAdjustedSpectra preserves the original buffers when stereo swap is inactive", () => {
  const quantizedSpectraByChannel = [new Float32Array([1, 2]), new Float32Array([3, 4])];
  const bitallocSpectraByChannel = [new Float32Array([5, 6]), new Float32Array([7, 8])];

  const result = buildSwapAdjustedSpectra(
    {
      quantizedSpectraByChannel,
      bitallocSpectraByChannel,
      shared: { swapMap: Uint32Array.of(0, 0, 0) },
    },
    2,
    14
  );

  assert.equal(result.quantizedSpectraByChannel, quantizedSpectraByChannel);
  assert.equal(result.bitallocSpectraByChannel, bitallocSpectraByChannel);
});

test("buildSwapAdjustedSpectra clones and swaps only the mapped stereo segments", () => {
  const quantizedSpectraByChannel = [
    Float32Array.from({ length: 256 }, (_, i) => i),
    Float32Array.from({ length: 256 }, (_, i) => i + 1000),
  ];
  const bitallocSpectraByChannel = [
    Float32Array.from({ length: 256 }, (_, i) => i + 2000),
    Float32Array.from({ length: 256 }, (_, i) => i + 3000),
  ];

  const result = buildSwapAdjustedSpectra(
    {
      quantizedSpectraByChannel,
      bitallocSpectraByChannel,
      shared: { swapMap: Uint32Array.of(0, 1, 0) },
    },
    2,
    14
  );

  assert.notEqual(result.quantizedSpectraByChannel[0], quantizedSpectraByChannel[0]);
  assert.equal(quantizedSpectraByChannel[0][128], 128);
  assert.equal(bitallocSpectraByChannel[0][128], 2128);
  assert.equal(result.quantizedSpectraByChannel[0][127], 127);
  assert.equal(result.quantizedSpectraByChannel[0][128], 1128);
  assert.equal(result.quantizedSpectraByChannel[1][128], 128);
  assert.equal(result.bitallocSpectraByChannel[0][128], 3128);
  assert.equal(result.bitallocSpectraByChannel[1][128], 2128);
});

test("applySwapMapToSpectraInPlace swaps mapped stereo segments across both working views", () => {
  const quantizedSpectraByChannel = [
    Float32Array.from({ length: 256 }, (_, i) => i),
    Float32Array.from({ length: 256 }, (_, i) => i + 1000),
  ];
  const bitallocSpectraByChannel = [
    Float32Array.from({ length: 256 }, (_, i) => i + 2000),
    Float32Array.from({ length: 256 }, (_, i) => i + 3000),
  ];

  assert.equal(
    applySwapMapToSpectraInPlace(
      quantizedSpectraByChannel,
      bitallocSpectraByChannel,
      Uint32Array.of(0, 1, 0),
      3
    ),
    true
  );
  assert.equal(quantizedSpectraByChannel[0][127], 127);
  assert.equal(quantizedSpectraByChannel[0][128], 1128);
  assert.equal(quantizedSpectraByChannel[1][128], 128);
  assert.equal(bitallocSpectraByChannel[0][128], 3128);
  assert.equal(bitallocSpectraByChannel[1][128], 2128);
});

test("applyRuntimeStereoSwapPresence clears stale state and mirrors stereo swap maps", () => {
  const block = {
    shared: {
      channels: 2,
      mapCount: 3,
      stereoSwapPresence: seedPresenceTable(createAt5PresenceTable()),
      stereoFlipPresence: seedPresenceTable(createAt5PresenceTable()),
    },
  };

  applyRuntimeStereoSwapPresence(block, { shared: { swapMap: Uint32Array.of(1, 0, 1) } });

  assert.equal(block.shared.stereoSwapPresence.enabled, 1);
  assert.equal(block.shared.stereoSwapPresence.mixed, 1);
  assert.deepEqual(Array.from(block.shared.stereoSwapPresence.flags.slice(0, 5)), [1, 0, 1, 0, 0]);
  assert.equal(block.shared.stereoFlipPresence.enabled, 0);
  assert.equal(block.shared.stereoFlipPresence.mixed, 0);
  assert.deepEqual(Array.from(block.shared.stereoFlipPresence.flags.slice(0, 5)), [0, 0, 0, 0, 0]);
});

test("applyRuntimeStereoSwapPresence clears stale state when stereo swap data is unavailable", () => {
  const block = {
    shared: {
      channels: 1,
      mapCount: 3,
      stereoSwapPresence: seedPresenceTable(createAt5PresenceTable()),
      stereoFlipPresence: seedPresenceTable(createAt5PresenceTable()),
    },
  };

  applyRuntimeStereoSwapPresence(block, null);

  assert.equal(block.shared.stereoSwapPresence.enabled, 0);
  assert.equal(block.shared.stereoSwapPresence.mixed, 0);
  assert.deepEqual(Array.from(block.shared.stereoSwapPresence.flags.slice(0, 5)), [0, 0, 0, 0, 0]);
  assert.equal(block.shared.stereoFlipPresence.enabled, 0);
  assert.equal(block.shared.stereoFlipPresence.mixed, 0);
  assert.deepEqual(Array.from(block.shared.stereoFlipPresence.flags.slice(0, 5)), [0, 0, 0, 0, 0]);
});
