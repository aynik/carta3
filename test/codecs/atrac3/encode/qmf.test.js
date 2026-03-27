import assert from "node:assert/strict";
import test from "node:test";

import { at3encQmfAnalyze, createAt3encQmfCurveTable } from "../../../../src/atrac3/qmf.js";

function roundSnapshot(values) {
  return values.map((value) => Number(value.toFixed(6)));
}

test("at3encQmfAnalyze preserves the current filtered output and carried history", () => {
  const curve = createAt3encQmfCurveTable();
  const pcm = Float32Array.from(
    { length: 0x400 },
    (_, index) => Math.sin(index / 17) * 0.5 + ((index % 13) - 6) / 10
  );
  const dst = new Float32Array(0x400);
  const hist = Float32Array.from({ length: 0x8a }, (_, index) => Math.cos(index / 5) * 0.25);
  const scratch = new Float32Array(0x48a);

  at3encQmfAnalyze(curve, pcm, dst, hist, scratch);

  assert.deepEqual(
    roundSnapshot(Array.from(dst.slice(0, 12))),
    [
      66137.703125, -46909.804688, -23.928711, 16847.910156, -187931.703125, 185400.828125,
      -198.114746, 9613.193359, 384708.90625, -542013.6875, -586.777832, -3425.709229,
    ]
  );
  assert.deepEqual(
    roundSnapshot(Array.from(dst.slice(-12))),
    [
      -129648264, -164356912, -415297408, 190364176, -1602627712, 1673566848, 160, -943041024,
      -2987288576, -164350592, 415297344, 190378816,
    ]
  );
  assert.deepEqual(
    roundSnapshot(Array.from(hist.slice(0, 12))),
    [
      3173.647461, -25953.125, 46746.3125, 2574.150391, 23492.888672, -854.427734, 21179.189453,
      -384.128906, 5929.191406, 2084.856934, -1255.91333, -5139.40332,
    ]
  );
  assert.deepEqual(
    roundSnapshot(Array.from(hist.slice(-12))),
    [
      0.580078, 0.650924, -0.578406, -0.507811, -0.437188, -0.366437, -0.295457, -0.224146,
      -0.152405, -0.080138, -0.007247, 0.066361,
    ]
  );
});

test("at3encQmfAnalyze preserves current output when scratch is omitted", () => {
  const curve = createAt3encQmfCurveTable();
  const pcm = Float32Array.from(
    { length: 0x400 },
    (_, index) => Math.sin(index / 17) * 0.5 + ((index % 13) - 6) / 10
  );
  const dst = new Float32Array(0x400);
  const hist = Float32Array.from({ length: 0x8a }, (_, index) => Math.cos(index / 5) * 0.25);

  at3encQmfAnalyze(curve, pcm, dst, hist);

  assert.deepEqual(
    roundSnapshot(Array.from(dst.slice(0, 12))),
    [
      66137.703125, -46909.804688, -23.928711, 16847.910156, -187931.703125, 185400.828125,
      -198.114746, 9613.193359, 384708.90625, -542013.6875, -586.777832, -3425.709229,
    ]
  );
  assert.deepEqual(
    roundSnapshot(Array.from(dst.slice(-12))),
    [
      -129648264, -164356912, -415297408, 190364176, -1602627712, 1673566848, 160, -943041024,
      -2987288576, -164350592, 415297344, 190378816,
    ]
  );
  assert.deepEqual(
    roundSnapshot(Array.from(hist.slice(0, 12))),
    [
      3173.647461, -25953.125, 46746.3125, 2574.150391, 23492.888672, -854.427734, 21179.189453,
      -384.128906, 5929.191406, 2084.856934, -1255.91333, -5139.40332,
    ]
  );
  assert.deepEqual(
    roundSnapshot(Array.from(hist.slice(-12))),
    [
      0.580078, 0.650924, -0.578406, -0.507811, -0.437188, -0.366437, -0.295457, -0.224146,
      -0.152405, -0.080138, -0.007247, 0.066361,
    ]
  );
});
