import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3plus from "../../../src/atrac3plus/subsystems.js";
import * as Atrac3plusInternal from "../../../src/atrac3plus/internal.js";
import * as Ghwave from "../../../src/atrac3plus/ghwave/index.js";
import * as GhwaveInternal from "../../../src/atrac3plus/ghwave/internal.js";

test("ATRAC3plus ghwave public barrel exposes major analysis stages only", () => {
  assert.equal(Atrac3plus.Ghwave, Ghwave);

  assert.equal(typeof Ghwave.analysisGeneralAt5, "function");
  assert.equal(typeof Ghwave.extractGhwaveAt5, "function");

  assert.equal("analysisGeneralAt5Sub" in Ghwave, false);
  assert.equal("analysisSineAt5Sub" in Ghwave, false);
  assert.equal("analysisCtxForSlot" in Ghwave, false);
  assert.equal("resolveGhwaveModeConfigAt5" in Ghwave, false);
  assert.equal("at5GhwaveApplySynthesisResidual" in Ghwave, false);
});

test("ATRAC3plus ghwave internal barrel retains selection and slot-state helpers", () => {
  assert.equal(Atrac3plusInternal.Ghwave, GhwaveInternal);

  assert.equal(typeof GhwaveInternal.analysisGeneralAt5, "function");
  assert.equal(typeof GhwaveInternal.extractGhwaveAt5, "function");
  assert.equal(typeof GhwaveInternal.analysisGeneralAt5Sub, "function");
  assert.equal(typeof GhwaveInternal.analysisSineAt5Sub, "function");
  assert.equal(typeof GhwaveInternal.analysisCtxForSlot, "function");
  assert.equal(typeof GhwaveInternal.resolveGhwaveModeConfigAt5, "function");
  assert.equal(typeof GhwaveInternal.computeSineExtractAllocationsAt5, "function");
  assert.equal(typeof GhwaveInternal.runSineModeExtractionAt5, "function");
  assert.equal(typeof GhwaveInternal.at5GhwaveApplySynthesisResidual, "function");
  assert.equal(typeof GhwaveInternal.fineAnalysisAt5, "function");
});
