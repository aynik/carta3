import assert from "node:assert/strict";
import test from "node:test";

import { sfAdjustConfigForCoreMode } from "../../../src/atrac3plus/channel-block/internal.js";
import {
  quantizeBandScalar,
  quantizeBandScalarWithIdsfRefine,
} from "../../../src/atrac3plus/channel-block/quantize.js";
import { AT5_ISPS, AT5_NSPS } from "../../../src/atrac3plus/tables/unpack.js";

function runIdsfRefineCase({
  values,
  idsf,
  band = 18,
  mode = 5,
  quantStepScale = 1,
  bandScale = 0.95,
  sfAdjustConfig = null,
  bandLevel = 1,
}) {
  const start = AT5_ISPS[band] >>> 0;
  const nsps = AT5_NSPS[band] >>> 0;
  const spec = new Float32Array(start + nsps + 16);

  values.forEach((value, index) => {
    spec[start + index] = value;
  });

  const channel = {
    scratchSpectra: new Int16Array(start + nsps + 16),
  };
  const result = quantizeBandScalarWithIdsfRefine(
    spec,
    channel,
    band,
    mode,
    idsf,
    quantStepScale,
    bandScale,
    sfAdjustConfig,
    bandLevel
  );

  return {
    result,
    coeffs: Array.from(channel.scratchSpectra.slice(start, start + Math.min(nsps, 8))),
  };
}

test("quantizeBandScalarWithIdsfRefine clears quiet bands that never quantize", () => {
  const { result, coeffs } = runIdsfRefineCase({
    values: [0.01],
    idsf: 35,
  });

  assert.deepEqual(result, { idsf: 35, nonzero: 0 });
  assert.deepEqual(coeffs, [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("quantizeBandScalar preserves rounded saturation and nonzero counting", () => {
  const scratch = new Int16Array(8);
  const spec = Float32Array.from([10, -10, 0.49, 0.51]);

  const nonzero = quantizeBandScalar(spec, 0, 4, 1, 1, scratch);

  assert.equal(nonzero, 3);
  assert.deepEqual(Array.from(scratch.slice(0, 4)), [1, -2, 0, 1]);
});

test("quantizeBandScalarWithIdsfRefine keeps the heuristic idsf winner", () => {
  const { result, coeffs } = runIdsfRefineCase({
    values: [0.5],
    idsf: 10,
  });

  assert.deepEqual(result, { idsf: 12, nonzero: 1 });
  assert.deepEqual(coeffs, [7, 0, 0, 0, 0, 0, 0, 0]);
});

test("quantizeBandScalarWithIdsfRefine preserves sf-adjust raised refinement", () => {
  const withoutAdjust = runIdsfRefineCase({
    values: [4],
    idsf: 10,
  });
  const withAdjust = runIdsfRefineCase({
    values: [4],
    idsf: 10,
    sfAdjustConfig: sfAdjustConfigForCoreMode(0x18, 1),
  });

  assert.deepEqual(withoutAdjust.result, { idsf: 15, nonzero: 1 });
  assert.deepEqual(withAdjust.result, { idsf: 16, nonzero: 1 });
  assert.deepEqual(withAdjust.coeffs, [7, 0, 0, 0, 0, 0, 0, 0]);
});
