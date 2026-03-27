import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3plus from "../../../src/atrac3plus/subsystems.js";
import * as Atrac3plusInternal from "../../../src/atrac3plus/internal.js";
import * as Time2freq from "../../../src/atrac3plus/time2freq/index.js";
import * as Time2freqInternal from "../../../src/atrac3plus/time2freq/internal.js";

test("ATRAC3plus time2freq public barrel exposes MDCT-stage entrypoints only", () => {
  assert.equal(Atrac3plus.Time2freq, Time2freq);

  assert.equal(typeof Time2freq.at5Time2freqMdctStage, "function");
  assert.equal(typeof Time2freq.at5T2fMdctOutputs, "function");
  assert.equal(typeof Time2freq.at5T2fSelectWindow, "function");
  assert.equal(typeof Time2freq.AT5_T2F_BANDS_MAX, "number");

  assert.equal("createAt5EncodeBufBlock" in Time2freq, false);
  assert.equal("time2freqScratch" in Time2freq, false);
  assert.equal("at5GainRecordNormalize" in Time2freq, false);
  assert.equal("at5T2fGaincSetup" in Time2freq, false);
  assert.equal("at5T2fMergeAdjacentBandRecords" in Time2freq, false);
});

test("ATRAC3plus time2freq internal barrel retains buffer and lowmode helpers", () => {
  assert.equal(Atrac3plusInternal.Time2freq, Time2freqInternal);

  assert.equal(typeof Time2freqInternal.createAt5EncodeBufBlock, "function");
  assert.equal(typeof Time2freqInternal.createAt5EncodeBufRecord, "function");
  assert.equal(typeof Time2freqInternal.time2freqScratch, "function");
  assert.equal(typeof Time2freqInternal.at5GainRecordNormalize, "function");
  assert.equal(typeof Time2freqInternal.at5T2fGaincSetup, "function");
  assert.equal(typeof Time2freqInternal.at5T2fMergeAdjacentBandRecords, "function");
  assert.equal(typeof Time2freqInternal.at5T2fLowModeMaximaAndOverflow, "function");
});
