import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3plus from "../../../src/atrac3plus/subsystems.js";
import * as Atrac3plusInternal from "../../../src/atrac3plus/internal.js";
import * as Sigproc from "../../../src/atrac3plus/sigproc/index.js";
import * as SigprocInternal from "../../../src/atrac3plus/sigproc/internal.js";

test("ATRAC3plus sigproc public barrel exposes frame-analysis stages only", () => {
  assert.equal(Atrac3plus.Sigproc, Sigproc);

  assert.equal(typeof Sigproc.at5SigprocAnalyzeFrame, "function");
  assert.equal(typeof Sigproc.at5SigprocAnalyzeChannel, "function");
  assert.equal(typeof Sigproc.at5SigprocModulate16band, "function");
  assert.equal(typeof Sigproc.AT5_SIGPROC_BANDS_MAX, "number");

  assert.equal("createAt5SigprocAux" in Sigproc, false);
  assert.equal("createAt5Time2freqState" in Sigproc, false);
  assert.equal("at5SigprocRotateChannelBlocks" in Sigproc, false);
  assert.equal("at5BandPtr" in Sigproc, false);
  assert.equal("at5SigprocUpdateDbDiff" in Sigproc, false);
});

test("ATRAC3plus sigproc internal barrel retains runtime-state helpers", () => {
  assert.equal(Atrac3plusInternal.Sigproc, SigprocInternal);

  assert.equal(typeof SigprocInternal.createAt5SigprocAux, "function");
  assert.equal(typeof SigprocInternal.createAt5Time2freqState, "function");
  assert.equal(typeof SigprocInternal.at5SigprocCorrHistoryViews, "function");
  assert.equal(typeof SigprocInternal.at5SigprocMode3Views, "function");
  assert.equal(typeof SigprocInternal.at5SigprocIntensityBandView, "function");
  assert.equal(typeof SigprocInternal.at5SigprocTime2freqBandFlagsView, "function");
  assert.equal(typeof SigprocInternal.at5SigprocRotateChannelBlocks, "function");
  assert.equal(typeof SigprocInternal.at5BandPtr, "function");
  assert.equal(typeof SigprocInternal.buildAt5SigprocBandPtrTable, "function");
  assert.equal(typeof SigprocInternal.at5SigprocUpdateDbDiff, "function");
  assert.equal(typeof SigprocInternal.at5SigprocApplyIntensityStereo, "function");
});
