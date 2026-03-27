import assert from "node:assert/strict";
import test from "node:test";

import { analysisComputeGate } from "../../../src/atrac3plus/ghwave/gate.js";
import { analysisGeneralAt5Sub } from "../../../src/atrac3plus/ghwave/general.js";
import { analysisSineAt5Sub } from "../../../src/atrac3plus/ghwave/sine.js";

test("GHwave analysis helpers tolerate null state inputs", () => {
  assert.doesNotThrow(() => analysisComputeGate(new Float32Array(0x140), null, 4, 0));
  assert.doesNotThrow(() => analysisSineAt5Sub(new Float32Array(0x100), null, -1, 0));
  assert.doesNotThrow(() =>
    analysisGeneralAt5Sub(new Float32Array(0x100), null, 0, 0, null, 0, 0, 0, null)
  );
});
