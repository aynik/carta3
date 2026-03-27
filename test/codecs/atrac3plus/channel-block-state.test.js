import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import {
  createBitallocHeader,
  createChannelBlock,
  resetBitallocHeader,
  resetChannelBlockEncodeState,
} from "../../../src/atrac3plus/channel-block/construction.js";
import {
  at5BaseMaxQuantModeForCoreMode,
  countPackedGainRecords,
  deriveScalefactorsFromSpectrumAt5,
} from "../../../src/atrac3plus/channel-block/metadata.js";
import {
  resetAt5MainData,
  validateOrResetAt5MainData,
} from "../../../src/atrac3plus/channel-block/packed-state.js";
import { at5RebitallocPackState } from "../../../src/atrac3plus/rebitalloc-layout.js";
import { AT5_SFTBL } from "../../../src/atrac3plus/tables/decode.js";
import { AT5_ISPS } from "../../../src/atrac3plus/tables/unpack.js";

function seedPresenceTable(table, flags) {
  table.enabled = 1;
  table.mixed = 1;
  table.flags.fill(0);
  flags.forEach((flag, index) => {
    table.flags[index] = flag >>> 0;
  });
  return table;
}

test("at5BaseMaxQuantModeForCoreMode preserves current mode thresholds", () => {
  assert.deepEqual(
    Array.from({ length: 21 }, (_, mode) => at5BaseMaxQuantModeForCoreMode(mode, 1, 0)),
    [2, 2, 2, 2, 3, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 7, 7, 7, 7, 7, 7]
  );
  assert.deepEqual(
    Array.from({ length: 21 }, (_, mode) => at5BaseMaxQuantModeForCoreMode(mode, 2, 0)),
    [2, 2, 2, 2, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7]
  );
  assert.equal(at5BaseMaxQuantModeForCoreMode(-1, 2, 0), 2);
  assert.equal(at5BaseMaxQuantModeForCoreMode(6, 1, 1), 7);
});

test("createChannelBlock preserves semantic rebitalloc scratch views", () => {
  const block = createChannelBlock();
  const packState = block.rebitallocScratch.packState;

  block.rebitallocScratch.specIndexByBand[0] = 17;
  block.rebitallocScratch.baseSpecIndexWord[0] = 0x12345678;
  block.quantScratch.quantBufI16[0] = -123;
  block.quantScratch.absBufU16[0] = 321;
  block.hcspecWorkByCtx[0].bestIndexByBand[0] = 9;
  block.hcspecWorkByCtx[0].costsByBand[0] = 11;

  assert.equal(
    block.rebitallocScratch.specIndexByBand.buffer,
    block.rebitallocScratch.bytes.buffer
  );
  assert.equal(packState.bytes, block.rebitallocScratch.packStateBytes);
  assert.equal(block.rebitallocScratch.packStateBytes.length, 0x8c);
  assert.equal(packState.types.length, 32);
  assert.equal(packState.types.buffer, block.rebitallocScratch.bytes.buffer);
  assert.equal(block.rebitallocScratch.baseSpecIndexWord[0], 0x12345678);
  assert.equal(block.quantScratch.quantBufBytes.buffer, block.quantScratch.quantBufI16.buffer);
  assert.equal(block.quantScratch.absBufBytes.buffer, block.quantScratch.absBufU16.buffer);
  assert.equal(block.quantScratch.quantBufI16[0], -123);
  assert.equal(block.quantScratch.absBufU16[0], 321);
  assert.equal(block.hcspecWorkByCtx[1].bestIndexByBand[0], 0);
  assert.equal(block.hcspecWorkByCtx[1].costsByBand[0], 0);
});

test("resetChannelBlockEncodeState clears reusable solve state without replacing scratch views", () => {
  const block = createChannelBlock();
  const firstIdwlRow = block.idwlScratch.rowSeq[0];
  const rebitallocBytes = block.rebitallocScratch.bytes;
  const hcspecBestIndex = block.hcspecWorkByCtx[0].bestIndexByBand;

  Object.assign(block, {
    baseMaxQuantMode: 7,
    bitallocMode: 3,
    gainRecordRangeFlag: 2,
    bitallocScale: 1.5,
    avgBandLevel: 2.5,
    wideGainBoostFlag: 1,
    bitallocHeader: {},
    blockState: {},
    quantizedSpectrum: new Float32Array(8),
  });
  block.maxQuantModeByBand[0] = 6;
  block.bitDeltaByCtx[0] = 10;
  block.quantUnitsByBand[0] = 4;
  block.quantOffsetByBand[0] = 3;
  block.quantModeByBand[0] = 2;
  block.quantModeBaseByBand[0] = 1.25;
  block.normalizedBandPeaks[0] = 3.5;
  block.bandPeaks[0] = 4.5;
  block.bitallocBandPeaks[0] = 5.5;
  block.bandLevels[0] = 6.5;
  block.idwlScratch.bestConfigSlot = 2;
  block.idwlScratch.costs[0] = 9;
  block.idwlScratch.rowSeq[0][0] = 7;
  block.idwlScratch.bandCountBySlot[0] = 4;
  block.idwlScratch.mappedGroupBySlot[0] = 3;
  block.idwlScratch.extraWordByIndex[0] = 2;
  block.idwlScratch.work = new Uint8Array(4);
  block.idwlWork[0] = 1;
  block.rebitallocScratch.bytes[0] = 8;
  block.rebitallocScratch.specIndexByBand[0] = 7;
  block.rebitallocScratch.baseSpecIndexWord[0] = 0x12345678;
  block.hcspecWorkByCtx[0].bestIndexByBand[0] = 5;
  block.hcspecWorkByCtx[0].costsByBand[0] = 12;

  resetChannelBlockEncodeState(block);

  assert.equal(block.idwlScratch.rowSeq[0], firstIdwlRow);
  assert.equal(block.rebitallocScratch.bytes, rebitallocBytes);
  assert.equal(block.hcspecWorkByCtx[0].bestIndexByBand, hcspecBestIndex);
  assert.equal(block.baseMaxQuantMode, 0);
  assert.equal(block.bitallocMode, 0);
  assert.equal(block.gainRecordRangeFlag, 0);
  assert.equal(block.bitallocScale, 0);
  assert.equal(block.avgBandLevel, 0);
  assert.equal(block.wideGainBoostFlag, 0);
  assert.equal(block.bitallocHeader, null);
  assert.equal(block.blockState, null);
  assert.equal(block.quantizedSpectrum, null);
  assert.equal(block.maxQuantModeByBand[0], 0);
  assert.equal(block.bitDeltaByCtx[0], 0);
  assert.equal(block.quantUnitsByBand[0], 0);
  assert.equal(block.quantOffsetByBand[0], 0);
  assert.equal(block.quantModeByBand[0], 0);
  assert.equal(block.quantModeBaseByBand[0], 0);
  assert.equal(block.normalizedBandPeaks[0], 0);
  assert.equal(block.bandPeaks[0], 0);
  assert.equal(block.bitallocBandPeaks[0], 0);
  assert.equal(block.bandLevels[0], 0);
  assert.equal(block.idwlScratch.bestConfigSlot, 0);
  assert.equal(block.idwlScratch.costs[0], 0);
  assert.equal(block.idwlScratch.rowSeq[0][0], 0);
  assert.equal(block.idwlScratch.bandCountBySlot[0], 0);
  assert.equal(block.idwlScratch.mappedGroupBySlot[0], 0);
  assert.equal(block.idwlScratch.extraWordByIndex[0], 0);
  assert.equal(block.idwlScratch.work, null);
  assert.equal(block.idwlWork[0], 0);
  assert.equal(block.rebitallocScratch.bytes[0], 0);
  assert.equal(block.rebitallocScratch.specIndexByBand[0], 0);
  assert.equal(block.rebitallocScratch.baseSpecIndexWord[0], 0);
  assert.equal(block.hcspecWorkByCtx[0].bestIndexByBand[0], 0);
  assert.equal(block.hcspecWorkByCtx[0].costsByBand[0], 0);
});

test("resetBitallocHeader clears reusable header state without replacing score tables", () => {
  const hdr = createBitallocHeader(2);
  const idsfValues = hdr.idsfValues;
  const hcspecTblA = hdr.hcspecTblA;
  const hcspecTblB = hdr.hcspecTblB;

  hdr.tblIndex = 3;
  hdr.idwlEnabled = 0;
  hdr.idwlInitialized = 1;
  hdr.idsfModeWord = 2;
  hdr.baseBits = 9;
  hdr.cbIterLimit = 4;
  hdr.cbStartBand = 5;
  hdr.bitsFixed = 6;
  hdr.bitsIdwl = 7;
  hdr.bitsIdsf = 8;
  hdr.bitsIdct = 9;
  hdr.bitsStereoMaps = 10;
  hdr.bitsChannelMaps = 11;
  hdr.bitsGain = 12;
  hdr.bitsGha = 13;
  hdr.bitsMisc = 14;
  hdr.bitsTotalBase = 15;
  hdr.bitsTotal = 16;
  hdr.debugSecondBitOffset = 17;
  hdr.idsfValues[0] = 18;
  hdr.mode3BandMask[0] = 1;
  hdr.mode3DeltaFlags[0] = 1;
  hdr.hcspecTblA[0] = {};
  hdr.hcspecTblB[1] = {};

  resetBitallocHeader(hdr, 2);

  assert.equal(hdr.idsfValues, idsfValues);
  assert.equal(hdr.hcspecTblA, hcspecTblA);
  assert.equal(hdr.hcspecTblB, hcspecTblB);
  assert.equal(hdr.tblIndex, 0);
  assert.equal(hdr.idwlEnabled, 1);
  assert.equal(hdr.idwlInitialized, 0);
  assert.equal(hdr.idsfModeWord, 1);
  assert.equal(hdr.baseBits, 0);
  assert.equal(hdr.cbIterLimit, 0);
  assert.equal(hdr.cbStartBand, 0);
  assert.equal(hdr.bitsFixed, 0);
  assert.equal(hdr.bitsIdwl, 0);
  assert.equal(hdr.bitsIdsf, 0);
  assert.equal(hdr.bitsIdct, 0);
  assert.equal(hdr.bitsStereoMaps, 0);
  assert.equal(hdr.bitsChannelMaps, 0);
  assert.equal(hdr.bitsGain, 0);
  assert.equal(hdr.bitsGha, 0);
  assert.equal(hdr.bitsMisc, 0);
  assert.equal(hdr.bitsTotalBase, 0);
  assert.equal(hdr.bitsTotal, 0);
  assert.equal(hdr.debugSecondBitOffset, null);
  assert.equal(hdr.idsfValues[0], 0);
  assert.equal(hdr.mode3BandMask[0], 0);
  assert.equal(hdr.mode3DeltaFlags[0], 0);
  assert.equal(hdr.hcspecTblA[0], null);
  assert.equal(hdr.hcspecTblB[1], null);
});

test("at5RebitallocPackState resolves semantic scratch pack-state fields", () => {
  const scratch = createChannelBlock().rebitallocScratch;
  const semanticScratch = {
    packState: scratch.packState,
    packStateBytes: scratch.packStateBytes,
  };

  assert.equal(at5RebitallocPackState(semanticScratch), scratch.packState);
});

test("createAt5RegularBlockState exposes semantic shared metadata fields", () => {
  const block = createAt5RegularBlockState(1);

  block.shared.mapSegmentCount = 5;
  block.shared.zeroSpectraFlag = 1;
  block.shared.noiseFillEnabled = 1;
  block.shared.noiseFillShift = 3;
  block.shared.noiseFillCursor = 6;
  block.shared.usedBitCount = 9;

  assert.equal(block.shared.mapSegmentCount, 5);
  assert.equal(block.shared.zeroSpectraFlag, 1);
  assert.equal(block.shared.noiseFillEnabled, 1);
  assert.equal(block.shared.noiseFillShift, 3);
  assert.equal(block.shared.noiseFillCursor, 6);
  assert.equal(block.shared.usedBitCount, 9);

  block.shared.mapSegmentCount = 2;
  block.shared.zeroSpectraFlag = 0;
  block.shared.noiseFillEnabled = 0;
  block.shared.noiseFillShift = 5;
  block.shared.noiseFillCursor = 7;
  block.shared.usedBitCount = 4;

  assert.equal(block.shared.mapSegmentCount, 2);
  assert.equal(block.shared.zeroSpectraFlag, 0);
  assert.equal(block.shared.noiseFillEnabled, 0);
  assert.equal(block.shared.noiseFillShift, 5);
  assert.equal(block.shared.noiseFillCursor, 7);
  assert.equal(block.shared.usedBitCount, 4);
});

test("countPackedGainRecords collapses only the trailing run of identical records", () => {
  const bufA = {
    records: [
      {
        entries: 1,
        locations: Uint8Array.of(0),
        levels: Uint8Array.of(1),
      },
      {
        entries: 2,
        locations: Uint8Array.of(1, 3),
        levels: Uint8Array.of(2, 4),
      },
      {
        entries: 2,
        locations: Uint8Array.of(1, 3),
        levels: Uint8Array.of(2, 4),
      },
      {
        entries: 2,
        locations: Uint8Array.of(1, 3),
        levels: Uint8Array.of(2, 4),
      },
    ],
  };

  assert.equal(countPackedGainRecords(bufA, 4), 2);

  bufA.records[1].levels[1] = 5;
  assert.equal(countPackedGainRecords(bufA, 4), 3);
});

test("deriveScalefactorsFromSpectrumAt5 preserves upper-bound threshold search and trailing clears", () => {
  const idsfOut = Int32Array.from([99, 99, 99, 99]);
  const maxOut = Float32Array.from([99, 99, 99, 99]);
  const quantizedSpectrum = new Float32Array(AT5_ISPS[2] >>> 0);
  const thresholdPeak = Math.fround(AT5_SFTBL[0] / AT5_SFTBL[15]);
  const saturatedPeak = Math.fround((AT5_SFTBL[63] * 2) / AT5_SFTBL[15]);

  quantizedSpectrum[0] = thresholdPeak;
  quantizedSpectrum[AT5_ISPS[1] >>> 0] = saturatedPeak;

  deriveScalefactorsFromSpectrumAt5(quantizedSpectrum, idsfOut, maxOut, 2);

  assert.equal(idsfOut[0], 1);
  assert.equal(idsfOut[1], 0x3f);
  assert.equal(maxOut[0], thresholdPeak);
  assert.equal(maxOut[1], saturatedPeak);
  assert.deepEqual(Array.from(idsfOut.slice(2)), [0, 0]);
  assert.deepEqual(Array.from(maxOut.slice(2)), [0, 0]);
});

test("deriveScalefactorsFromSpectrumAt5 keeps bands below threshold at zero", () => {
  const idsfOut = Int32Array.of(99);
  const maxOut = Float32Array.of(99);
  const quantizedSpectrum = new Float32Array(AT5_ISPS[1] >>> 0);
  const belowThresholdPeak = Math.fround((AT5_SFTBL[0] * 0.99) / AT5_SFTBL[15]);

  quantizedSpectrum[0] = belowThresholdPeak;

  deriveScalefactorsFromSpectrumAt5(quantizedSpectrum, idsfOut, maxOut, 1);

  assert.equal(idsfOut[0], 0);
  assert.equal(maxOut[0], belowThresholdPeak);
});

test("resetAt5MainData clears channel state and recomputes packed bit totals", () => {
  const block = createAt5RegularBlockState(2);
  const [left, right] = block.channels;
  const shared = block.shared;
  const hdr = createBitallocHeader(2);

  shared.bandLimit = 4;
  shared.mapSegmentCount = 3;
  shared.idsfCount = 7;
  shared.mapCount = 5;
  shared.zeroSpectraFlag = 0;

  left.idwlPackMode = 1;
  right.idwlPackMode = 2;
  left.idwl.values.fill(3);
  right.idwl.values.fill(4);
  left.scratchSpectra.fill(1);
  right.scratchSpectra.fill(2);

  seedPresenceTable(left.channelPresence, [1, 0, 1]);
  seedPresenceTable(right.channelPresence, [1, 1, 1]);
  seedPresenceTable(shared.stereoSwapPresence, [1, 0, 1]);
  seedPresenceTable(shared.stereoFlipPresence, [1, 1, 0]);

  Object.assign(hdr, {
    bitsGain: 10,
    bitsFixed: 6,
    bitsGha: 5,
    bitsMisc: 4,
  });

  resetAt5MainData(shared, block.channels, 2, hdr);

  assert.equal(shared.idsfCount, 0);
  assert.equal(shared.mapCount, 0);
  assert.equal(shared.zeroSpectraFlag, 1);
  assert.equal(left.idwlPackMode, 0);
  assert.equal(right.idwlPackMode, 0);
  assert.deepEqual(Array.from(left.idwl.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(right.idwl.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(left.scratchSpectra.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(right.scratchSpectra.slice(0, 4)), [0, 0, 0, 0]);

  assert.equal(shared.stereoSwapPresence.enabled, 0);
  assert.equal(shared.stereoSwapPresence.mixed, 0);
  assert.equal(shared.stereoFlipPresence.enabled, 0);
  assert.equal(shared.stereoFlipPresence.mixed, 0);
  assert.equal(left.channelPresence.enabled, 1);
  assert.equal(left.channelPresence.mixed, 1);
  assert.equal(right.channelPresence.enabled, 1);
  assert.equal(right.channelPresence.mixed, 0);

  assert.equal(hdr.bitsIdwl, 28);
  assert.equal(hdr.bitsIdsf, 0);
  assert.equal(hdr.bitsIdct, 0);
  assert.equal(hdr.bitsStereoMaps, 2);
  assert.equal(hdr.bitsChannelMaps, 7);
  assert.equal(hdr.bitsTotalBase, 60);
  assert.equal(hdr.bitsTotal, 62);
});

test("resetAt5MainData skips stereo map recounts for mono blocks", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const shared = block.shared;
  const hdr = createBitallocHeader(1);

  shared.bandLimit = 4;
  shared.mapSegmentCount = 2;
  shared.idsfCount = 5;
  shared.mapCount = 3;
  shared.zeroSpectraFlag = 0;

  channel.idwlPackMode = 1;
  channel.idwl.values.fill(6);
  channel.scratchSpectra.fill(4);

  seedPresenceTable(channel.channelPresence, [1, 1]);
  seedPresenceTable(shared.stereoSwapPresence, [1, 1]);
  seedPresenceTable(shared.stereoFlipPresence, [1, 1]);

  Object.assign(hdr, {
    bitsGain: 8,
    bitsFixed: 6,
    bitsGha: 3,
    bitsMisc: 2,
    bitsStereoMaps: 99,
  });

  resetAt5MainData(shared, block.channels, 1, hdr);

  assert.equal(shared.idsfCount, 0);
  assert.equal(shared.mapCount, 0);
  assert.equal(shared.zeroSpectraFlag, 1);
  assert.equal(channel.idwlPackMode, 0);
  assert.deepEqual(Array.from(channel.idwl.values.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(channel.scratchSpectra.slice(0, 4)), [0, 0, 0, 0]);
  assert.equal(hdr.bitsIdwl, 14);
  assert.equal(hdr.bitsStereoMaps, 0);
  assert.equal(hdr.bitsChannelMaps, 2);
  assert.equal(hdr.bitsTotalBase, 35);
  assert.equal(hdr.bitsTotal, 35);
});

test("validateOrResetAt5MainData accepts the default regular-block state", () => {
  const block = createAt5RegularBlockState(2);
  const hdr = createBitallocHeader(2);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 3;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 2, hdr), true);
});

test("validateOrResetAt5MainData normalizes invalid band limits before clearing", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 0x1d;
  block.shared.mapSegmentCount = 2;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 5;
  channel.scratchSpectra[0] = 9;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), false);
  assert.equal(block.shared.bandLimit, 0x20);
  assert.equal(block.shared.channelPresenceMapCount, 0x10);
  assert.equal(block.shared.idsfCount, 0);
  assert.equal(channel.idwlPackMode, 0);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.scratchSpectra[0], 0);
  assert.equal(hdr.bitsIdwl, 98);
});

test("validateOrResetAt5MainData clears mirror configurations that overrun idsfCount", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);
  const mirror = new Uint8Array(12);
  const mirrorView = new DataView(mirror.buffer);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 2;
  channel.scratchSpectra[0] = 7;
  mirrorView.setInt32(0, 2, true);
  mirrorView.setInt32(4, 5, true);
  mirrorView.setUint32(8, 1, true);
  channel.rebitallocMirrorBytes = mirror;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), false);
  assert.equal(channel.idwlPackMode, 0);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.scratchSpectra[0], 0);
});

test("validateOrResetAt5MainData ignores disabled mirror ranges even when the count is out of range", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);
  const mirror = new Uint8Array(12);
  const mirrorView = new DataView(mirror.buffer);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 2;
  channel.scratchSpectra[0] = 7;
  mirrorView.setInt32(0, 2, true);
  mirrorView.setInt32(4, 99, true);
  mirrorView.setUint32(8, 0, true);
  channel.rebitallocMirrorBytes = mirror;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), true);
  assert.equal(channel.idwlPackMode, 1);
  assert.equal(channel.idwl.values[0], 2);
  assert.equal(channel.scratchSpectra[0], 7);
});

test("validateOrResetAt5MainData clears invalid idwl metadata ranges", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 2;
  channel.idwl.metaFlag = 1;
  channel.idwl.metaMode = 2;
  channel.idwl.metaA = 2;
  channel.idwl.metaB = 7;
  channel.scratchSpectra[0] = 5;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), false);
  assert.equal(channel.idwlPackMode, 0);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.scratchSpectra[0], 0);
});

test("validateOrResetAt5MainData preserves mode-3 metadata ranges that bypass the metaB cap", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 2;
  channel.idwl.metaFlag = 1;
  channel.idwl.metaMode = 3;
  channel.idwl.metaA = 2;
  channel.idwl.metaB = 7;
  channel.scratchSpectra[0] = 5;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), true);
  assert.equal(channel.idwlPackMode, 1);
  assert.equal(channel.idwl.values[0], 2);
  assert.equal(channel.scratchSpectra[0], 5);
});

test("validateOrResetAt5MainData clears invalid pack-mode lead counts", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.count = 2;
  channel.idwl.lead = 3;
  channel.idwl.values[0] = 2;
  channel.scratchSpectra[0] = 8;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), false);
  assert.equal(channel.idwlPackMode, 0);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.scratchSpectra[0], 0);
});

test("validateOrResetAt5MainData clears out-of-range idwl values", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 8;
  channel.scratchSpectra[0] = 8;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), false);
  assert.equal(channel.idwlPackMode, 0);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.scratchSpectra[0], 0);
});

test("validateOrResetAt5MainData preserves channel-0 mirror ranges for high mirror modes", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);
  const mirror = new Uint8Array(12);
  const mirrorView = new DataView(mirror.buffer);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 2;
  channel.scratchSpectra[0] = 7;
  mirrorView.setInt32(0, 3, true);
  mirrorView.setInt32(4, 5, true);
  mirrorView.setUint32(8, 1, true);
  channel.rebitallocMirrorBytes = mirror;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), true);
  assert.equal(channel.idwlPackMode, 1);
  assert.equal(channel.idwl.values[0], 2);
  assert.equal(channel.scratchSpectra[0], 7);
});

test("validateOrResetAt5MainData clears invalid mode-3 tails on channel 0", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.mode = 3;
  channel.idwl.count = 4;
  channel.idwl.extra = 1;
  channel.idwl.values[0] = 2;
  channel.scratchSpectra[0] = 8;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), false);
  assert.equal(channel.idwlPackMode, 0);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.scratchSpectra[0], 0);
});

test("validateOrResetAt5MainData clears invalid mode-3 tails on channel 1", () => {
  const block = createAt5RegularBlockState(2);
  const [, right] = block.channels;
  const hdr = createBitallocHeader(2);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  right.idwlPackMode = 2;
  right.idwl.mode = 3;
  right.idwl.count = 2;
  right.idwl.extra = 3;
  right.idwl.values[0] = 2;
  right.scratchSpectra[0] = 8;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 2, hdr), false);
  assert.equal(right.idwlPackMode, 0);
  assert.equal(right.idwl.values[0], 0);
  assert.equal(right.scratchSpectra[0], 0);
});

test("validateOrResetAt5MainData accepts higher idct values when gain mode widens the range", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  block.shared.gainModeFlag = 1;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 2;
  channel.idct.values[0] = 7;
  channel.scratchSpectra[0] = 6;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), true);
  assert.equal(channel.idwlPackMode, 1);
  assert.equal(channel.idwl.values[0], 2);
  assert.equal(channel.idct.values[0], 7);
  assert.equal(channel.scratchSpectra[0], 6);
});

test("validateOrResetAt5MainData clears out-of-range idct values", () => {
  const block = createAt5RegularBlockState(1);
  const [channel] = block.channels;
  const hdr = createBitallocHeader(1);

  block.shared.bandLimit = 4;
  block.shared.idsfCount = 4;
  channel.idwlPackMode = 1;
  channel.idwl.values[0] = 2;
  channel.idct.values[0] = 4;
  channel.scratchSpectra[0] = 6;

  assert.equal(validateOrResetAt5MainData(block.shared, block.channels, 1, hdr), false);
  assert.equal(channel.idwlPackMode, 0);
  assert.equal(channel.idwl.values[0], 0);
  assert.equal(channel.scratchSpectra[0], 0);
});
