import assert from "node:assert/strict";
import test from "node:test";

import { createAt5SigprocAux } from "../../../src/atrac3plus/sigproc/aux.js";
import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/buf.js";
import { AT5_T2F_BANDS_MAX } from "../../../src/atrac3plus/time2freq/constants.js";
import {
  AT5_TIME2FREQ_SCALE_HIGH,
  AT5_TIME2FREQ_SCALE_LOW,
} from "../../../src/atrac3plus/tables/encode-init.js";
import {
  at5T2fAlignTlevFlagsStereo,
  at5T2fComputeTlevForChannel,
  at5T2fThresholdTable,
} from "../../../src/atrac3plus/time2freq/tlev.js";

function createAnalysisRows(factory = () => new Float32Array(256)) {
  return Array.from({ length: AT5_T2F_BANDS_MAX }, (_, band) => factory(band));
}

function createSharedBlock(sharedAux, shared = {}) {
  return {
    header: {
      shared,
      sharedAux,
    },
  };
}

test("at5T2fThresholdTable prefers the shared core mode when selecting thresholds", () => {
  assert.equal(at5T2fThresholdTable({ coreMode: 0x13 }, 0x00), AT5_TIME2FREQ_SCALE_HIGH);
  assert.equal(at5T2fThresholdTable({}, 0x12), AT5_TIME2FREQ_SCALE_LOW);
  assert.equal(at5T2fThresholdTable(null, 0x13), AT5_TIME2FREQ_SCALE_HIGH);
});

test("at5T2fComputeTlevForChannel clears all tlev flags in bypass mode", () => {
  const cur = createAt5EncodeBufBlock();
  const analysisPtrs = createAnalysisRows();

  cur.records[0].tlevFlag = 1;
  cur.records[1].tlevFlag = 1;
  cur.tlevFlagsCopy[0] = 1;
  cur.tlevFlagsCopy[1] = 1;
  cur.records[0].gainBase = 2;
  cur.records[1].gainBase = 4;

  at5T2fComputeTlevForChannel(cur, analysisPtrs, 0, { encodeFlags: 0x10, encodeFlagCc: 0 }, 0x12);

  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    assert.equal(cur.records[band].tlevFlag, 0);
    assert.equal(cur.tlevFlagsCopy[band], 0);
    assert.equal(cur.records[band].gainBase, 8);
  }
});

test("at5T2fComputeTlevForChannel keeps the band-0 analysis but suppresses tlev flags in CC mode", () => {
  const cur = createAt5EncodeBufBlock();
  const analysisPtrs = createAnalysisRows(() => new Float32Array(256).fill(1));
  const thresholds = new Float32Array(AT5_T2F_BANDS_MAX).fill(9999);

  at5T2fComputeTlevForChannel(
    cur,
    analysisPtrs,
    0,
    { encodeFlags: 0, encodeFlagCc: 1 },
    0x12,
    thresholds,
    {}
  );

  assert.equal(cur.records[0].tlev, 64);
  assert.equal(cur.records[0].gainBase, 8);
  assert.equal(cur.records[0].tlevFlag, 0);
  assert.equal(cur.tlevFlagsCopy[0], 0);

  assert.equal(cur.records[1].tlev, 1);
  assert.equal(cur.records[1].gainBase, 1);
  assert.equal(cur.records[1].tlevFlag, 0);
  assert.equal(cur.tlevFlagsCopy[1], 0);
});

test("at5T2fComputeTlevForChannel expands high-core flags once enough bands cross the first threshold pass", () => {
  const cur = createAt5EncodeBufBlock();
  const analysisPtrs = createAnalysisRows();
  const thresholds = new Float32Array(AT5_T2F_BANDS_MAX).fill(0.5);

  thresholds[0] = 2;
  thresholds[1] = 2;
  thresholds[2] = 2;
  thresholds[3] = 2;

  at5T2fComputeTlevForChannel(
    cur,
    analysisPtrs,
    0,
    { encodeFlags: 0, encodeFlagCc: 0 },
    0x1b,
    thresholds,
    {}
  );

  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    assert.equal(cur.records[band].tlev, 1);
    assert.equal(cur.records[band].tlevFlag, 1);
    assert.equal(cur.tlevFlagsCopy[band], 1);
  }
});

test("at5T2fAlignTlevFlagsStereo lets the stronger stereo side win when the bands are close or highly correlated", () => {
  const cur0 = createAt5EncodeBufBlock();
  const cur1 = createAt5EncodeBufBlock();
  const corrByBand = new Float32Array(AT5_T2F_BANDS_MAX);

  cur0.records[0].tlev = 1.5;
  cur1.records[0].tlev = 1.0;
  cur0.records[0].tlevFlag = 1;
  cur1.records[0].tlevFlag = 0;
  cur0.tlevFlagsCopy[0] = 1;
  cur1.tlevFlagsCopy[0] = 0;

  cur0.records[1].tlev = 5.0;
  cur1.records[1].tlev = 1.0;
  cur0.records[1].tlevFlag = 1;
  cur1.records[1].tlevFlag = 0;
  cur0.tlevFlagsCopy[1] = 1;
  cur1.tlevFlagsCopy[1] = 0;
  corrByBand[1] = 25;

  at5T2fAlignTlevFlagsStereo(
    [createSharedBlock(createAt5SigprocAux(), {})],
    cur0,
    cur1,
    corrByBand,
    16
  );

  assert.equal(cur1.records[0].tlevFlag, 1);
  assert.equal(cur1.tlevFlagsCopy[0], 1);
  assert.equal(cur1.records[1].tlevFlag, 1);
  assert.equal(cur1.tlevFlagsCopy[1], 1);
});

test("at5T2fAlignTlevFlagsStereo propagates flags across the swap-map boundary from the shared intensity band", () => {
  const aux = createAt5SigprocAux();
  aux.intensityBand[0] = 3;

  const swapMap = new Uint32Array(AT5_T2F_BANDS_MAX);
  swapMap[3] = 0;
  swapMap[4] = 1;

  const cur0 = createAt5EncodeBufBlock();
  const cur1 = createAt5EncodeBufBlock();

  cur0.records[3].tlev = 3;
  cur1.records[3].tlev = 1;
  cur0.records[3].tlevFlag = 1;
  cur0.tlevFlagsCopy[3] = 1;

  cur0.records[4].tlev = 1;
  cur1.records[4].tlev = 3;
  cur1.records[4].tlevFlag = 1;
  cur1.tlevFlagsCopy[4] = 1;

  at5T2fAlignTlevFlagsStereo(
    [createSharedBlock(aux, { swapMap })],
    cur0,
    cur1,
    new Float32Array(AT5_T2F_BANDS_MAX),
    16
  );

  assert.equal(cur1.records[3].tlevFlag, 1);
  assert.equal(cur1.tlevFlagsCopy[3], 1);
  assert.equal(cur0.records[4].tlevFlag, 1);
  assert.equal(cur0.tlevFlagsCopy[4], 1);
});
