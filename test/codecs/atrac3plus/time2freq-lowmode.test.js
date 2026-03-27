import assert from "node:assert/strict";
import test from "node:test";

import { createAt5SigprocAux } from "../../../src/atrac3plus/sigproc/aux.js";
import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/buf.js";
import { at5T2fCorrByBandFromAux } from "../../../src/atrac3plus/time2freq/runtime.js";
import {
  at5T2fAdjustBand0RecordFromBand1,
  at5T2fAdjustMaximaStereo,
  at5T2fComputeMaxima,
  at5T2fCopyRecordsStereoLowModes,
  at5T2fLowModeMaximaAndOverflow,
  at5T2fMergeAdjacentBandRecords,
  at5T2fMergeCloseRecordsBetweenChannels,
  at5T2fReduceGainOverflow,
} from "../../../src/atrac3plus/time2freq/lowmode.js";
import { at5T2fAlignTlevFlagsStereo } from "../../../src/atrac3plus/time2freq/tlev.js";

function createSharedBlock(sharedAux, shared = {}) {
  return {
    header: {
      shared,
      sharedAux,
    },
  };
}

function setSingleGainPoint(record, location, level, extra = {}) {
  record.entries = 1;
  record.locations[0] = location;
  record.levels[0] = level;
  Object.assign(record, extra);
}

function setGainPoints(record, points, extra = {}) {
  record.entries = points.length;
  for (let i = 0; i < points.length; i += 1) {
    const [location, level] = points[i];
    record.locations[i] = location;
    record.levels[i] = level;
  }
  Object.assign(record, extra);
}

function createAnalysisBand(value) {
  return new Float32Array(256).fill(value);
}

function assertAlmostEqual(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("at5T2fCorrByBandFromAux resolves shared aux from block headers", () => {
  const aux = createAt5SigprocAux();
  aux.corrMetric0Hist[2] = 1.25;

  const corrByBand = at5T2fCorrByBandFromAux(createSharedBlock(aux));

  assert.equal(corrByBand?.[2], 1.25);
});

test("at5T2fCopyRecordsStereoLowModes updates the shared aux band-flag row after copying high-correlation records", () => {
  const aux = createAt5SigprocAux();
  aux.mode3ToneActiveFlags.fill(0);

  const prev0 = createAt5EncodeBufBlock();
  const prev1 = createAt5EncodeBufBlock();
  const cur0 = createAt5EncodeBufBlock();
  const cur1 = createAt5EncodeBufBlock();

  cur0.records[0].entries = 1;
  cur0.records[0].locations[0] = 2;
  cur0.records[0].levels[0] = 9;
  cur0.records[0].tlevFlag = 1;
  cur0.records[0].minAll = 3.5;

  const blocks = [createSharedBlock(aux, { encodeFlagCc: 0 }), createSharedBlock(aux, {})];
  const corrByBand = new Float32Array(16);
  corrByBand[0] = 25;

  at5T2fCopyRecordsStereoLowModes(blocks, prev0, prev1, cur0, cur1, 0x12, corrByBand, aux);

  assert.equal(aux.mode3ToneActiveFlags[0], 1);
  assert.equal(cur0.records[0].entries, 0);
  assert.equal(cur0.records[0].locations[0], 0);
  assert.equal(cur0.records[0].levels[0], 0);
  assert.equal(cur0.records[0].tlevFlag, 0);
});

test("at5T2fCopyRecordsStereoLowModes copies moderate-correlation bands when the stereo neighborhood already agrees", () => {
  const aux = createAt5SigprocAux();
  aux.intensityBand[0] = 2;
  aux.mode3ToneActiveFlags.fill(0);
  aux.mode3ToneActiveFlags[3] = 1;
  aux.mode3ToneActiveFlags[4] = 1;
  aux.mode3ToneActiveFlags[5] = 1;

  const prev0 = createAt5EncodeBufBlock();
  const prev1 = createAt5EncodeBufBlock();
  const cur0 = createAt5EncodeBufBlock();
  const cur1 = createAt5EncodeBufBlock();

  setSingleGainPoint(cur0.records[4], 3, 7, { minAll: 3.5, tlevFlag: 1 });

  const corrByBand = new Float32Array(16);
  corrByBand[4] = 15;

  at5T2fCopyRecordsStereoLowModes(
    [createSharedBlock(aux, { encodeFlagCc: 0 }), createSharedBlock(aux)],
    prev0,
    prev1,
    cur0,
    cur1,
    0x12,
    corrByBand,
    aux
  );

  assert.equal(cur0.records[4].entries, 0);
  assert.equal(cur0.records[4].locations[0], 0);
  assert.equal(cur0.records[4].levels[0], 0);
  assert.equal(aux.mode3ToneActiveFlags[4], 1);
});

test("at5T2fCopyRecordsStereoLowModes falls back to the low-correlation copy pass when both current and lead correlation stay strong", () => {
  const aux = createAt5SigprocAux();
  aux.mode3ToneActiveFlags.fill(0);
  aux.corrMetric0Lead[5] = 13;

  const prev0 = createAt5EncodeBufBlock();
  const prev1 = createAt5EncodeBufBlock();
  const cur0 = createAt5EncodeBufBlock();
  const cur1 = createAt5EncodeBufBlock();

  setSingleGainPoint(cur0.records[5], 4, 7, { minAll: 3.5, tlevFlag: 1 });

  const corrByBand = new Float32Array(16);
  corrByBand[5] = 13;

  at5T2fCopyRecordsStereoLowModes(
    [createSharedBlock(aux, { encodeFlagCc: 0 }), createSharedBlock(aux)],
    prev0,
    prev1,
    cur0,
    cur1,
    0x12,
    corrByBand,
    aux
  );

  assert.equal(cur0.records[5].entries, 0);
  assert.equal(cur0.records[5].locations[0], 0);
  assert.equal(cur0.records[5].levels[0], 0);
  assert.equal(aux.mode3ToneActiveFlags[5], 1);
});

test("at5T2fComputeMaxima preserves raw peaks when the gain window stays neutral", () => {
  const prev0 = createAt5EncodeBufBlock();
  const cur0 = createAt5EncodeBufBlock();
  const maxPre = new Float32Array(32);
  const maxPost = new Float32Array(32);

  setSingleGainPoint(cur0.records[0], 0, 6);

  at5T2fComputeMaxima([prev0], [cur0], [createAnalysisBand(1.5)], 1, 1, maxPre, maxPost, {});

  assert.equal(maxPre[0], 1.5);
  assert.equal(maxPost[0], 1.5);
});

test("at5T2fAdjustMaximaStereo harmonizes near-equal stereo maxima around the dominant channel", () => {
  const maxPre = new Float32Array(32);
  const maxPost = new Float32Array(32);

  maxPre[0] = 10;
  maxPre[16] = 10.2;
  maxPost[0] = 10;
  maxPost[16] = 10.1;

  at5T2fAdjustMaximaStereo(maxPre, maxPost, 1, 0.95, 1.05);

  assertAlmostEqual(maxPre[0], 10.2);
  assertAlmostEqual(maxPre[16], 10.2);
  assertAlmostEqual(maxPost[0], 10.1);
  assertAlmostEqual(maxPost[16], 10.1);
});

test("at5T2fReduceGainOverflow trims hot bands and re-syncs stereo records that started identical", () => {
  const prev0 = createAt5EncodeBufBlock();
  const prev1 = createAt5EncodeBufBlock();
  const cur0 = createAt5EncodeBufBlock();
  const cur1 = createAt5EncodeBufBlock();
  const maxPre = new Float32Array(32);
  const maxPost = new Float32Array(32);

  setSingleGainPoint(cur0.records[0], 0, 15);
  setSingleGainPoint(cur1.records[0], 0, 15);

  const analysisRows = [createAnalysisBand(1)];
  at5T2fComputeMaxima([prev0, prev1], [cur0, cur1], analysisRows, 2, 1, maxPre, maxPost, {});
  at5T2fReduceGainOverflow(
    [prev0, prev1],
    [cur0, cur1],
    analysisRows,
    2,
    1,
    maxPre,
    maxPost,
    8,
    65536,
    {}
  );

  assert.equal(cur0.records[0].levels[0], 13);
  assert.equal(cur1.records[0].levels[0], 13);
  assert.equal(cur0.records[0].entries, 1);
  assert.equal(cur1.records[0].entries, 1);
  assert.equal(maxPost[0], 128);
});

test("at5T2fLowModeMaximaAndOverflow reuses caller-owned maxima buffers", () => {
  const prev0 = createAt5EncodeBufBlock();
  const cur0 = createAt5EncodeBufBlock();
  const out = {
    maxPre: new Float32Array(32),
    maxPost: new Float32Array(32),
  };

  setSingleGainPoint(cur0.records[0], 0, 6);

  const result = at5T2fLowModeMaximaAndOverflow(
    [prev0],
    [cur0],
    [createAnalysisBand(2)],
    1,
    1,
    out
  );

  assert.equal(result, out);
  assert.equal(result.maxPre, out.maxPre);
  assert.equal(result.maxPost, out.maxPost);
  assert.equal(result.maxPre[0], 2);
  assert.equal(result.maxPost[0], 2);
});

test("at5T2fMergeCloseRecordsBetweenChannels promotes sparse matches to the denser shared shape", () => {
  const block0 = createAt5EncodeBufBlock();
  const block1 = createAt5EncodeBufBlock();

  setGainPoints(block0.records[0], [
    [2, 10],
    [4, 8],
  ]);
  setGainPoints(block1.records[0], [
    [2, 10],
    [4, 8],
    [6, 7],
  ]);

  at5T2fMergeCloseRecordsBetweenChannels(block0.records[0], block1.records[0], {});

  assert.equal(block0.records[0].entries, 3);
  assert.deepEqual(Array.from(block0.records[0].locations.slice(0, 3)), [2, 4, 6]);
  assert.deepEqual(Array.from(block0.records[0].levels.slice(0, 3)), [10, 8, 7]);
  assert.equal(block1.records[0].entries, 3);
});

test("at5T2fMergeCloseRecordsBetweenChannels snaps close equal-sized stereo records to a shared envelope", () => {
  const block0 = createAt5EncodeBufBlock();
  const block1 = createAt5EncodeBufBlock();

  setGainPoints(block0.records[0], [
    [3, 8],
    [6, 7],
  ]);
  setGainPoints(block1.records[0], [
    [2, 9],
    [7, 6],
  ]);

  at5T2fMergeCloseRecordsBetweenChannels(block0.records[0], block1.records[0], {});

  assert.deepEqual(Array.from(block0.records[0].locations.slice(0, 2)), [2, 6]);
  assert.deepEqual(Array.from(block0.records[0].levels.slice(0, 2)), [9, 7]);
  assert.deepEqual(Array.from(block1.records[0].locations.slice(0, 2)), [2, 6]);
  assert.deepEqual(Array.from(block1.records[0].levels.slice(0, 2)), [9, 7]);
});

test("at5T2fAdjustBand0RecordFromBand1 seeds a missing band-0 record from the peer channel when higher bands agree", () => {
  const cur = createAt5EncodeBufBlock();
  const peer = createAt5EncodeBufBlock();

  setGainPoints(cur.records[1], [
    [4, 10],
    [7, 7],
  ]);
  setSingleGainPoint(cur.records[2], 4, 8);
  setSingleGainPoint(cur.records[3], 5, 8);
  setSingleGainPoint(peer.records[1], 4, 8);

  at5T2fAdjustBand0RecordFromBand1(cur, peer, 2, 0, 4);

  assert.equal(cur.records[0].entries, 1);
  assert.equal(cur.records[0].locations[0], 4);
  assert.equal(cur.records[0].levels[0], 7);
});

test("at5T2fAdjustBand0RecordFromBand1 prepends an earlier dominant location onto band 0", () => {
  const cur = createAt5EncodeBufBlock();

  setSingleGainPoint(cur.records[0], 8, 7);
  setGainPoints(cur.records[1], [
    [4, 10],
    [8, 7],
  ]);
  setSingleGainPoint(cur.records[2], 4, 8);
  setSingleGainPoint(cur.records[3], 5, 8);

  at5T2fAdjustBand0RecordFromBand1(cur, null, 1, 0, 4);

  assert.equal(cur.records[0].entries, 2);
  assert.deepEqual(Array.from(cur.records[0].locations.slice(0, 2)), [4, 8]);
  assert.deepEqual(Array.from(cur.records[0].levels.slice(0, 2)), [8, 7]);
});

test("at5T2fAdjustBand0RecordFromBand1 appends a later dominant location onto band 0", () => {
  const cur = createAt5EncodeBufBlock();

  setSingleGainPoint(cur.records[0], 4, 7);
  setGainPoints(cur.records[1], [
    [4, 8],
    [9, 10],
  ]);
  setSingleGainPoint(cur.records[2], 9, 8);
  setSingleGainPoint(cur.records[3], 8, 8);

  at5T2fAdjustBand0RecordFromBand1(cur, null, 1, 0, 4);

  assert.equal(cur.records[0].entries, 2);
  assert.deepEqual(Array.from(cur.records[0].locations.slice(0, 2)), [4, 9]);
  assert.deepEqual(Array.from(cur.records[0].levels.slice(0, 2)), [8, 7]);
});

test("at5T2fAdjustBand0RecordFromBand1 boosts the leading point when the dominant location already aligns", () => {
  const cur = createAt5EncodeBufBlock();

  setGainPoints(cur.records[0], [
    [4, 7],
    [8, 6],
  ]);
  setGainPoints(cur.records[1], [
    [5, 10],
    [8, 7],
  ]);
  setSingleGainPoint(cur.records[2], 5, 8);
  setSingleGainPoint(cur.records[3], 6, 8);

  at5T2fAdjustBand0RecordFromBand1(cur, null, 1, 0, 4);

  assert.equal(cur.records[0].entries, 1);
  assert.deepEqual(Array.from(cur.records[0].locations.slice(0, 1)), [4]);
  assert.deepEqual(Array.from(cur.records[0].levels.slice(0, 1)), [8]);
});

test("at5T2fMergeAdjacentBandRecords folds close adjacent bands into band 2", () => {
  const cur = createAt5EncodeBufBlock();

  setGainPoints(cur.records[2], [
    [5, 9],
    [8, 7],
  ]);
  setGainPoints(cur.records[3], [
    [4, 10],
    [9, 6],
  ]);

  at5T2fMergeAdjacentBandRecords(cur, 4);

  assert.deepEqual(Array.from(cur.records[2].locations.slice(0, 2)), [4, 8]);
  assert.deepEqual(Array.from(cur.records[2].levels.slice(0, 2)), [10, 7]);
  assert.deepEqual(Array.from(cur.records[3].locations.slice(0, 2)), [4, 9]);
});

test("at5T2fAlignTlevFlagsStereo uses the shared intensity-band boundary from aux", () => {
  const aux = createAt5SigprocAux();
  aux.intensityBand[0] = 4;

  const shared = { swapMap: new Uint32Array(16) };
  const block = createSharedBlock(aux, shared);
  const cur0 = createAt5EncodeBufBlock();
  const cur1 = createAt5EncodeBufBlock();

  cur0.records[3].tlev = 3;
  cur1.records[3].tlev = 1;
  cur0.records[3].tlevFlag = 1;
  cur1.records[3].tlevFlag = 0;
  cur0.tlevFlagsCopy[3] = 1;
  cur1.tlevFlagsCopy[3] = 0;

  cur0.records[5].tlev = 3;
  cur1.records[5].tlev = 1;
  cur0.records[5].tlevFlag = 1;
  cur1.records[5].tlevFlag = 0;
  cur0.tlevFlagsCopy[5] = 1;
  cur1.tlevFlagsCopy[5] = 0;

  at5T2fAlignTlevFlagsStereo([block], cur0, cur1, new Float32Array(16), 16);

  assert.equal(cur1.records[3].tlevFlag, 0);
  assert.equal(cur1.tlevFlagsCopy[3], 0);
  assert.equal(cur1.records[5].tlevFlag, 1);
  assert.equal(cur1.tlevFlagsCopy[5], 1);
});
