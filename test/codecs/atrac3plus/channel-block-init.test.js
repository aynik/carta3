import assert from "node:assert/strict";
import test from "node:test";

import {
  AT5_SECOND_BIT_OFFSET_MAX,
  AT5_SECOND_BIT_OFFSET_MIN,
} from "../../../src/atrac3plus/tables/encode-bitalloc.js";
import { AT5_SFTBL } from "../../../src/atrac3plus/tables/decode.js";
import {
  AT5_CB_TABLE_SET0_A,
  AT5_CB_TABLE_SET0_B,
  AT5_CB_TABLE_SET0_C,
  AT5_CB_TABLE_SET1_A,
  AT5_CB_TABLE_SET1_B,
  AT5_CB_TABLE_SET1_C,
} from "../../../src/atrac3plus/tables/encode-init.js";
import {
  bitallocOffsetTargetMode,
  computeBitallocMode,
  computeInitialModeAnalysis,
  estimateBitallocOffset,
  firstGainRecordHasWideLevels,
  gainRecordRangeFlag,
  prepareQuantOffsets,
  sfAdjustConfigForCoreMode,
} from "../../../src/atrac3plus/channel-block/internal.js";
import { AT5_ISPS, at5MapCountForBandCount } from "../../../src/atrac3plus/tables/unpack.js";

function createRecord(entries = 0, levels = []) {
  return {
    entries,
    levels: Uint32Array.from(levels),
    locations: new Uint32Array(7),
  };
}

function createRuntimeChannel({
  mapSegmentCount = 0,
  firstWide = false,
  allGain = false,
  prevWide = false,
} = {}) {
  return {
    curBuf: {
      records: Array.from({ length: 8 }, (_, index) => {
        if (index === 0 && firstWide) {
          return createRecord(1, [4]);
        }
        if (allGain && index < mapSegmentCount) {
          return createRecord(1, [6]);
        }
        return createRecord(0);
      }),
    },
    prevBuf: {
      records: Array.from({ length: 8 }, (_, index) =>
        index === 1 && prevWide ? createRecord(1, [8]) : createRecord(0)
      ),
    },
  };
}

function createRuntimeBlock({
  channels,
  coreMode,
  sampleRateHz,
  mapSegmentCount = 0,
  firstWide = false,
  allGain = false,
  prevWide = false,
  encodeFlags = 0,
  bitsForBlock = 512,
} = {}) {
  return {
    channelsInBlock: channels,
    bitsForBlock,
    coreMode,
    blockState: { isMode4Block: 0 },
    shared: {
      coreMode,
      sampleRateHz,
      mapSegmentCount,
      encodeFlags,
    },
    quantizedSpectraByChannel: Array.from({ length: channels }, () => new Float32Array(2048)),
    bitallocSpectraByChannel: Array.from({ length: channels }, () => new Float32Array(2048)),
    channelEntries: Array.from({ length: channels }, () =>
      createRuntimeChannel({ mapSegmentCount, firstWide, allGain, prevWide })
    ),
  };
}

function assertApproxArray(actual, expected, epsilon = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= epsilon,
      `index ${i}: expected ${expected[i]}, got ${actual[i]}`
    );
  }
}

test("gain record helpers preserve current current/previous buffer checks", () => {
  const runtimeChannel = createRuntimeChannel({ mapSegmentCount: 1, prevWide: true });
  assert.equal(gainRecordRangeFlag(runtimeChannel), 1);
  assert.equal(firstGainRecordHasWideLevels(runtimeChannel), false);

  runtimeChannel.curBuf.records[0] = createRecord(1, [8]);
  assert.equal(firstGainRecordHasWideLevels(runtimeChannel), true);
});

test("shared channel-block helpers preserve sf-adjust thresholds and band-count mapping", () => {
  assert.deepEqual(sfAdjustConfigForCoreMode(0x0d, 2), {
    startBand: 12,
    kHi: 1.25992107,
    kLo: 0.793700516,
    stepLimit: 10,
  });
  assert.deepEqual(sfAdjustConfigForCoreMode(0x18, 2), {
    startBand: 18,
    kHi: 1.12246203,
    kLo: 0.707106769,
    stepLimit: 5,
  });
  assert.equal(at5MapCountForBandCount(0), 1);
  assert.equal(at5MapCountForBandCount(14), 3);
  assert.equal(at5MapCountForBandCount(32), 16);
  assert.equal(at5MapCountForBandCount(99), 1);
});

test("prepareQuantOffsets preserves start-band-gated lt16 boosts and clamp behavior", () => {
  const coreMode = 0x06;
  const startBand = AT5_CB_TABLE_SET0_B[coreMode];
  const rowBase = coreMode * 32;
  const bootstrapByChannel = [
    {
      seededIdwlModesByBand: Int32Array.from({ length: 32 }, (_, band) =>
        band === 3 || band === 10 || band === 11 ? 1 : 0
      ),
      quantUnitsByBand: Int32Array.from(
        { length: 32 },
        (_, band) => ({ 3: 6, 10: 6, 11: 20 })[band] ?? 0
      ),
    },
  ];

  const result = prepareQuantOffsets(1, 16, coreMode, 44100, bootstrapByChannel);
  const offsets = result.quantOffsetByChannel[0];

  assert.equal(result.startBand, startBand);
  assert.equal(result.iterLimit, AT5_CB_TABLE_SET0_A[coreMode]);
  assert.equal(offsets[3], AT5_CB_TABLE_SET0_C[rowBase + 3]);
  assert.equal(offsets[10], 0x0f);
  assert.equal(offsets[11], AT5_CB_TABLE_SET0_C[rowBase + 11]);
});

test("prepareQuantOffsets preserves the 48 kHz remap and skips lt16 boosts in high modes", () => {
  const coreMode = 0x18;
  const rowBase = coreMode * 32;
  const band = 23;
  const bootstrapByChannel = [
    {
      seededIdwlModesByBand: Int32Array.from({ length: 32 }, (_, index) =>
        index === band ? 1 : 0
      ),
      quantUnitsByBand: Int32Array.from({ length: 32 }, (_, index) => (index === band ? 6 : 0)),
    },
    null,
  ];

  const result = prepareQuantOffsets(2, 24, coreMode, 48000, bootstrapByChannel);

  assert.equal(result.startBand, AT5_CB_TABLE_SET1_B[coreMode]);
  assert.equal(result.iterLimit, AT5_CB_TABLE_SET1_A[coreMode]);
  assert.equal(result.quantOffsetByChannel[0][band], AT5_CB_TABLE_SET1_C[rowBase + band + 1]);
  assert.equal(result.quantOffsetByChannel[1][band], AT5_CB_TABLE_SET1_C[rowBase + band + 1]);
});

test("prepareQuantOffsets keeps stereo low-mode seed boosts channel-local", () => {
  const coreMode = 0x06;
  const rowBase = coreMode * 32;
  const startBand = AT5_CB_TABLE_SET1_B[coreMode];
  const nextBand = startBand + 1;
  const leadBaseOffset = AT5_CB_TABLE_SET1_C[rowBase + startBand];
  const nextBaseOffset = AT5_CB_TABLE_SET1_C[rowBase + nextBand];
  const leftModes = new Int32Array(32);
  const leftQuantUnits = new Int32Array(32);
  const rightModes = new Int32Array(32);
  const rightQuantUnits = new Int32Array(32);
  leftModes[startBand] = 1;
  leftQuantUnits[startBand] = 6;
  rightModes[startBand] = 1;
  rightModes[nextBand] = 1;
  rightQuantUnits[startBand] = 20;
  rightQuantUnits[nextBand] = 9;
  const result = prepareQuantOffsets(2, 24, coreMode, 44100, [
    {
      seededIdwlModesByBand: leftModes,
      quantUnitsByBand: leftQuantUnits,
    },
    {
      seededIdwlModesByBand: rightModes,
      quantUnitsByBand: rightQuantUnits,
    },
  ]);
  const [leftOffsets, rightOffsets] = result.quantOffsetByChannel;

  assert.equal(result.startBand, startBand);
  assert.equal(leftOffsets[startBand], Math.min(0x0f, leadBaseOffset + 9));
  assert.equal(leftOffsets[nextBand], nextBaseOffset);
  assert.equal(rightOffsets[startBand], leadBaseOffset);
  assert.equal(rightOffsets[nextBand], Math.min(0x0f, nextBaseOffset + 4));
});

test("computeInitialModeAnalysis preserves stereo low-band sparse-record penalty", () => {
  const runtimeBlock = createRuntimeBlock({
    channels: 2,
    coreMode: 0x0d,
    sampleRateHz: 44100,
    mapSegmentCount: 1,
  });

  const result = computeInitialModeAnalysis(runtimeBlock, 14, null, { secondBitOffset: 0 });
  const state = result.bootstrapByChannel[0];

  assert.equal(result.baseMaxQuantMode, 5);
  assert.equal(result.iterLimit, 12);
  assert.equal(result.secondBitOffset, 0);
  assert.equal(state.hasFullGainPrefix, false);
  assertApproxArray(
    Array.from(state.quantModeBaseByBand.slice(0, 14)),
    [
      0.4500000476837158, 0.4500000476837158, 0.4500000476837158, 0.4500000476837158,
      0.4500000476837158, 0.4500000476837158, 0.4500000476837158, 0.4500000476837158, 0, 0, 0, 0, 0,
      0,
    ]
  );
  assert.deepEqual(
    Array.from(state.maxIdwlModesByBand.slice(0, 14)),
    [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]
  );
});

test("computeInitialModeAnalysis preserves adjacent stereo bitalloc equalization", () => {
  const runtimeBlock = createRuntimeBlock({
    channels: 2,
    coreMode: 0x0d,
    sampleRateHz: 48000,
  });

  for (const spec of [
    ...runtimeBlock.quantizedSpectraByChannel,
    ...runtimeBlock.bitallocSpectraByChannel,
  ]) {
    spec.fill(8e-6, 0, 0x10);
    spec.fill(1e-6, 0x10, 0x80);
  }
  runtimeBlock.quantizedSpectraByChannel[0].fill(2e-6, 0x80, 0x100);
  runtimeBlock.bitallocSpectraByChannel[0].fill(2e-6, 0x80, 0x100);
  runtimeBlock.quantizedSpectraByChannel[1].fill(1.5e-6, 0x80, 0x100);
  runtimeBlock.bitallocSpectraByChannel[1].fill(1.5e-6, 0x80, 0x100);

  const gainRange = gainRecordRangeFlag(runtimeBlock.channelEntries[0]);
  const expectedLeft = computeBitallocMode(runtimeBlock.quantizedSpectraByChannel[0], gainRange);
  const expectedRight = computeBitallocMode(runtimeBlock.quantizedSpectraByChannel[1], gainRange);
  assert.equal(Math.abs(expectedLeft - expectedRight), 1);

  const result = computeInitialModeAnalysis(runtimeBlock, 14, null, { secondBitOffset: 0 });

  assertApproxArray(
    Array.from(result.bootstrapByChannel[0].quantModeBaseByBand.slice(0, 8)),
    Array(8).fill(1.95)
  );
  assertApproxArray(
    Array.from(result.bootstrapByChannel[1].quantModeBaseByBand.slice(0, 8)),
    Array(8).fill(1.95)
  );
});

test("computeInitialModeAnalysis preserves the first-record wide-level boost", () => {
  const runtimeBlock = createRuntimeBlock({
    channels: 2,
    coreMode: 0x0d,
    sampleRateHz: 44100,
    mapSegmentCount: 1,
    firstWide: true,
    allGain: true,
  });

  const state = computeInitialModeAnalysis(runtimeBlock, 14, null, { secondBitOffset: 0 })
    .bootstrapByChannel[0];

  assert.equal(state.firstGainRecordIsWide, true);
  assert.equal(state.hasFullGainPrefix, true);
  assertApproxArray(
    Array.from(state.quantModeBaseByBand.slice(0, 14)),
    [
      1.4500000476837158, 1.4500000476837158, 1.4500000476837158, 1.4500000476837158,
      1.4500000476837158, 1.4500000476837158, 1.4500000476837158, 1.4500000476837158, 0, 0, 0, 0, 0,
      0,
    ]
  );
  assert.deepEqual(
    Array.from(state.maxIdwlModesByBand.slice(0, 14)),
    [6, 6, 6, 6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5]
  );
});

test("computeInitialModeAnalysis preserves mono low-band offsets and band-limit clamping", () => {
  const mono48 = computeInitialModeAnalysis(
    createRuntimeBlock({
      channels: 1,
      coreMode: 0x0b,
      sampleRateHz: 48000,
    }),
    10,
    null,
    { secondBitOffset: 0 }
  ).bootstrapByChannel[0];

  assertApproxArray(
    Array.from(mono48.quantModeBaseByBand.slice(0, 14)),
    [
      1.2000000476837158, 1.2000000476837158, 1.2000000476837158, 1.2000000476837158,
      1.2000000476837158, 1.2000000476837158, 1.2000000476837158, 1.2000000476837158, 0.25, 0.25, 0,
      0, 0, 0,
    ]
  );

  const mono44 = computeInitialModeAnalysis(
    createRuntimeBlock({
      channels: 1,
      coreMode: 0x0d,
      sampleRateHz: 44100,
    }),
    14,
    null,
    { secondBitOffset: 0 }
  ).bootstrapByChannel[0];

  assertApproxArray(
    Array.from(mono44.quantModeBaseByBand.slice(0, 14)),
    [1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0, 0]
  );
});

test("computeInitialModeAnalysis preserves the late 48 kHz stereo low-band cutoff", () => {
  const stereo48 = computeInitialModeAnalysis(
    createRuntimeBlock({
      channels: 2,
      coreMode: 0x18,
      sampleRateHz: 48000,
    }),
    10,
    null,
    { secondBitOffset: 0 }
  ).bootstrapByChannel[0];

  assertApproxArray(
    Array.from(stereo48.quantModeBaseByBand.slice(0, 10)),
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0]
  );
});

test("computeInitialModeAnalysis preserves bitalloc-offset override fallback and clamping", () => {
  const runtimeBlock = createRuntimeBlock({
    channels: 2,
    coreMode: 0x0d,
    sampleRateHz: 44100,
    mapSegmentCount: 1,
  });

  const auto = computeInitialModeAnalysis(runtimeBlock, 14).secondBitOffset;
  assert.equal(
    computeInitialModeAnalysis(runtimeBlock, 14, null, { secondBitOffset: Number.NaN })
      .secondBitOffset,
    auto
  );
  assert.equal(
    computeInitialModeAnalysis(runtimeBlock, 14, null, {
      secondBitOffset: AT5_SECOND_BIT_OFFSET_MAX + 10,
    }).secondBitOffset,
    AT5_SECOND_BIT_OFFSET_MAX
  );
  assert.equal(
    computeInitialModeAnalysis(runtimeBlock, 14, null, {
      secondBitOffset: AT5_SECOND_BIT_OFFSET_MIN - 10,
    }).secondBitOffset,
    AT5_SECOND_BIT_OFFSET_MIN
  );
});

test("computeInitialModeAnalysis preserves spectrum-derived per-band analysis", () => {
  const runtimeBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
  });
  const bandStarts = [AT5_ISPS[0] >>> 0, AT5_ISPS[1] >>> 0, AT5_ISPS[2] >>> 0];

  runtimeBlock.quantizedSpectraByChannel[0][bandStarts[0]] = AT5_SFTBL[12];
  runtimeBlock.bitallocSpectraByChannel[0][bandStarts[0]] = AT5_SFTBL[10];
  runtimeBlock.quantizedSpectraByChannel[0][bandStarts[1]] = AT5_SFTBL[16];
  runtimeBlock.bitallocSpectraByChannel[0][bandStarts[1]] = AT5_SFTBL[18];
  runtimeBlock.quantizedSpectraByChannel[0][bandStarts[2]] = AT5_SFTBL[8];
  runtimeBlock.bitallocSpectraByChannel[0][bandStarts[2]] = AT5_SFTBL[8];

  const result = computeInitialModeAnalysis(runtimeBlock, 8, null, { secondBitOffset: 0 });
  const state = result.bootstrapByChannel[0];

  assert.equal(result.baseMaxQuantMode, 6);
  assert.equal(result.iterLimit, 9);
  assert.equal(result.secondBitOffset, 0);
  assert.deepEqual(Array.from(state.scaleFactorIndexByBand.slice(0, 4)), [10, 18, 8, 0]);
  assertApproxArray(
    Array.from(state.peakMagnitudeByBand.slice(0, 4)),
    [0.280731201171875, 1.78253173828125, 0.176849365234375, 0]
  );
  assert.deepEqual(Array.from(state.quantUnitsByBand.slice(0, 4)), [11, 17, 8, 0]);
  assertApproxArray(Array.from(state.bandLevels.slice(0, 4)), [16, 16, 16, 1]);
  assertApproxArray(
    Array.from(state.quantModeBaseByBand.slice(0, 8)),
    [4.882352828979492, 7, 3.8235294818878174, 1, 1, 1, 1, 1]
  );
  assert.deepEqual(Array.from(state.maxIdwlModesByBand.slice(0, 8)), [7, 7, 7, 6, 6, 6, 6, 6]);
  assert.deepEqual(Array.from(state.seededIdwlModesByBand.slice(0, 4)), [5, 7, 4, 0]);
  assert.equal(state.avgBandLevel, 6.625);
});

test("computeInitialModeAnalysis falls back to the scale-factor spectrum when the analysis view is missing", () => {
  const runtimeBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
  });
  const bandStart = AT5_ISPS[0] >>> 0;

  runtimeBlock.quantizedSpectraByChannel[0] = undefined;
  runtimeBlock.bitallocSpectraByChannel[0][bandStart] = AT5_SFTBL[10];

  const state = computeInitialModeAnalysis(runtimeBlock, 8, null, { secondBitOffset: 0 })
    .bootstrapByChannel[0];

  assert.equal(state.scaleFactorIndexByBand[0], 10);
  assert.equal(state.peakMagnitudeByBand[0], AT5_SFTBL[10]);
  assert.equal(state.quantUnitsByBand[0], 10);
  assert.equal(state.bandLevels[0], 16);
});

test("computeInitialModeAnalysis preserves absolute-magnitude band analysis", () => {
  const positiveBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
  });
  const negativeBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
  });
  const bandStarts = [AT5_ISPS[0] >>> 0, AT5_ISPS[1] >>> 0, AT5_ISPS[2] >>> 0];

  for (const runtimeBlock of [positiveBlock, negativeBlock]) {
    runtimeBlock.quantizedSpectraByChannel[0][bandStarts[0]] = AT5_SFTBL[12];
    runtimeBlock.bitallocSpectraByChannel[0][bandStarts[0]] = AT5_SFTBL[10];
    runtimeBlock.quantizedSpectraByChannel[0][bandStarts[1]] = AT5_SFTBL[16];
    runtimeBlock.bitallocSpectraByChannel[0][bandStarts[1]] = AT5_SFTBL[18];
    runtimeBlock.quantizedSpectraByChannel[0][bandStarts[2]] = AT5_SFTBL[8];
    runtimeBlock.bitallocSpectraByChannel[0][bandStarts[2]] = AT5_SFTBL[8];
  }

  negativeBlock.quantizedSpectraByChannel[0][bandStarts[0]] *= -1;
  negativeBlock.bitallocSpectraByChannel[0][bandStarts[0]] *= -1;
  negativeBlock.quantizedSpectraByChannel[0][bandStarts[1]] *= -1;
  negativeBlock.bitallocSpectraByChannel[0][bandStarts[1]] *= -1;
  negativeBlock.quantizedSpectraByChannel[0][bandStarts[2]] *= -1;
  negativeBlock.bitallocSpectraByChannel[0][bandStarts[2]] *= -1;

  const positive = computeInitialModeAnalysis(positiveBlock, 8, null, { secondBitOffset: 0 })
    .bootstrapByChannel[0];
  const negative = computeInitialModeAnalysis(negativeBlock, 8, null, { secondBitOffset: 0 })
    .bootstrapByChannel[0];

  assert.deepEqual(
    Array.from(negative.scaleFactorIndexByBand.slice(0, 4)),
    Array.from(positive.scaleFactorIndexByBand.slice(0, 4))
  );
  assertApproxArray(
    Array.from(negative.peakMagnitudeByBand.slice(0, 4)),
    Array.from(positive.peakMagnitudeByBand.slice(0, 4))
  );
  assert.deepEqual(
    Array.from(negative.quantUnitsByBand.slice(0, 4)),
    Array.from(positive.quantUnitsByBand.slice(0, 4))
  );
  assertApproxArray(
    Array.from(negative.bandLevels.slice(0, 4)),
    Array.from(positive.bandLevels.slice(0, 4))
  );
  assertApproxArray(
    Array.from(negative.quantModeBaseByBand.slice(0, 8)),
    Array.from(positive.quantModeBaseByBand.slice(0, 8))
  );
  assert.deepEqual(
    Array.from(negative.maxIdwlModesByBand.slice(0, 8)),
    Array.from(positive.maxIdwlModesByBand.slice(0, 8))
  );
  assert.deepEqual(
    Array.from(negative.seededIdwlModesByBand.slice(0, 4)),
    Array.from(positive.seededIdwlModesByBand.slice(0, 4))
  );
});

test("computeInitialModeAnalysis preserves encode-flag direct bitalloc scaling", () => {
  const weightedBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
    encodeFlags: 0,
  });
  const directBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
    encodeFlags: 0x04,
  });
  const bandStart = AT5_ISPS[8] >>> 0;

  for (const runtimeBlock of [weightedBlock, directBlock]) {
    runtimeBlock.quantizedSpectraByChannel[0][bandStart] = AT5_SFTBL[12];
    runtimeBlock.bitallocSpectraByChannel[0][bandStart] = AT5_SFTBL[10];
  }

  const weighted = computeInitialModeAnalysis(weightedBlock, 14, null, { secondBitOffset: 0 })
    .bootstrapByChannel[0];
  const direct = computeInitialModeAnalysis(directBlock, 14, null, { secondBitOffset: 0 })
    .bootstrapByChannel[0];

  assert.equal(weighted.quantUnitsByBand[8], 11);
  assert.equal(direct.quantUnitsByBand[8], 11);
  assert.equal(weighted.maxIdwlModesByBand[8], 7);
  assert.equal(direct.maxIdwlModesByBand[8], 7);
  assert.equal(weighted.seededIdwlModesByBand[8], 6);
  assert.equal(direct.seededIdwlModesByBand[8], 7);
  assert.equal(weighted.avgBandLevel, 3.2142857142857144);
  assert.equal(direct.avgBandLevel, 3.2142857142857144);
  assertApproxArray(
    [weighted.quantModeBaseByBand[8], direct.quantModeBaseByBand[8]],
    [5.954545497894287, 6.5]
  );
});

test("bitallocOffsetTargetMode preserves 48 kHz weight remapping and flagged positive offsets", () => {
  const bitallocOffsetState = {
    sampleRate: 48000,
    encodeFlags: 0,
    posWeights: Float32Array.from({ length: 32 }, (_, index) => index + 1),
    negWeights: Float32Array.from({ length: 32 }, (_, index) => 101 + index),
  };

  assert.equal(bitallocOffsetTargetMode(10, 0x11, 2, bitallocOffsetState), 46);
  assert.equal(bitallocOffsetTargetMode(10, 0x12, 2, bitallocOffsetState), 50);
  assert.equal(bitallocOffsetTargetMode(10, 0x12, -1, bitallocOffsetState), -110);
  assert.equal(
    bitallocOffsetTargetMode(10, 0x12, 2, { ...bitallocOffsetState, encodeFlags: 0x04 }),
    12
  );
});

test("estimateBitallocOffset preserves the lower-bound escape when estimates stay over budget", () => {
  const bitallocOffsetState = {
    channelCount: 1,
    sampleRate: 44100,
    encodeFlags: 0,
    posWeights: new Float32Array(32).fill(1),
    negWeights: new Float32Array(32).fill(1),
  };

  assert.equal(
    estimateBitallocOffset(
      [
        {
          quantUnitsByBand: Int32Array.from([1]),
          quantModeBaseByBand: Float32Array.from([1000]),
          maxIdwlModesByBand: Int32Array.from([7]),
        },
      ],
      1,
      1,
      bitallocOffsetState
    ),
    AT5_SECOND_BIT_OFFSET_MIN
  );
});

test("estimateBitallocOffset preserves the upper-bound escape when estimates stay below threshold", () => {
  const bitallocOffsetState = {
    channelCount: 1,
    sampleRate: 44100,
    encodeFlags: 0,
    posWeights: new Float32Array(32).fill(1),
    negWeights: new Float32Array(32).fill(1),
  };

  assert.equal(
    estimateBitallocOffset(
      [
        {
          quantUnitsByBand: Int32Array.from([0]),
          quantModeBaseByBand: Float32Array.from([0]),
          maxIdwlModesByBand: Int32Array.from([7]),
        },
      ],
      1,
      500,
      bitallocOffsetState
    ),
    AT5_SECOND_BIT_OFFSET_MAX
  );
});

test("estimateBitallocOffset preserves fractional step halving after target crossover", () => {
  const bitallocOffsetState = {
    channelCount: 1,
    sampleRate: 44100,
    encodeFlags: 0,
    posWeights: new Float32Array(32).fill(1),
    negWeights: new Float32Array(32).fill(1),
  };

  assert.equal(
    estimateBitallocOffset(
      [
        {
          quantUnitsByBand: Int32Array.from([1, 0, 0]),
          quantModeBaseByBand: Float32Array.from([3, 0, 0]),
          maxIdwlModesByBand: Int32Array.from([7, 7, 7]),
        },
      ],
      3,
      150,
      bitallocOffsetState
    ),
    -0.5
  );
});

test("computeInitialModeAnalysis raises bitalloc-offset modes when the bit budget grows", () => {
  const constrainedBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
    bitsForBlock: 256,
  });
  const relaxedBlock = createRuntimeBlock({
    channels: 1,
    coreMode: 0x0d,
    sampleRateHz: 44100,
    bitsForBlock: 320,
  });
  const secondBandStart = AT5_ISPS[1] >>> 0;

  for (const runtimeBlock of [constrainedBlock, relaxedBlock]) {
    runtimeBlock.quantizedSpectraByChannel[0][0] = 100;
    runtimeBlock.bitallocSpectraByChannel[0][0] = 100;
    runtimeBlock.quantizedSpectraByChannel[0][secondBandStart] = 10;
    runtimeBlock.bitallocSpectraByChannel[0][secondBandStart] = 10;
  }

  const constrained = computeInitialModeAnalysis(constrainedBlock, 8);
  const relaxed = computeInitialModeAnalysis(relaxedBlock, 8);

  assert.equal(constrained.secondBitOffset, -2);
  assert.equal(relaxed.secondBitOffset, 5);
  assert.deepEqual(
    Array.from(constrained.bootstrapByChannel[0].seededIdwlModesByBand.slice(0, 4)),
    [6, 5, 0, 0]
  );
  assert.deepEqual(
    Array.from(relaxed.bootstrapByChannel[0].seededIdwlModesByBand.slice(0, 4)),
    [7, 7, 0, 0]
  );
});
