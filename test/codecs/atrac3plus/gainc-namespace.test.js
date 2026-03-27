import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3plus from "../../../src/atrac3plus/subsystems.js";
import * as Atrac3plusInternal from "../../../src/atrac3plus/internal.js";
import * as Gainc from "../../../src/atrac3plus/gainc/index.js";
import * as GaincInternal from "../../../src/atrac3plus/gainc/internal.js";

test("ATRAC3plus gainc public barrel exposes only the subsystem stages", () => {
  assert.equal(Atrac3plus.Gainc, Gainc);

  assert.equal(typeof Gainc.detectGaincDataNewAt5, "function");
  assert.equal(typeof Gainc.setGaincAt5, "function");
  assert.equal(typeof Gainc.gaincWindowEncAt5, "function");

  assert.equal("attackPassAt5" in Gainc, false);
  assert.equal("releasePassAt5" in Gainc, false);
  assert.equal("at5GaincBuildNormalizedCurve" in Gainc, false);
  assert.equal("attackPassAt5" in Atrac3plus.Gainc, false);
});

test("ATRAC3plus gainc internal barrel retains pass helpers", () => {
  assert.equal(Atrac3plusInternal.Gainc, GaincInternal);

  assert.equal(typeof GaincInternal.detectGaincDataNewAt5, "function");
  assert.equal(typeof GaincInternal.setGaincAt5, "function");
  assert.equal(typeof GaincInternal.gaincWindowEncAt5, "function");
  assert.equal(typeof GaincInternal.attackPassAt5, "function");
  assert.equal(typeof GaincInternal.releasePassAt5, "function");
  assert.equal(typeof GaincInternal.at5GaincBuildNormalizedCurve, "function");
  assert.equal(typeof GaincInternal.createGainPassOutput, "function");
});
