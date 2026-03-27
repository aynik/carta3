import assert from "node:assert/strict";
import test from "node:test";

import { gaincWindowEncAt5 } from "../../../src/atrac3plus/gainc/window.js";
import { AT5_GAINC_WINDOW } from "../../../src/atrac3plus/tables/decode.js";

const FLAT_WINDOW_END = 0xff;
const EPSILON = 1e-6;

function createGainParams(points) {
  const params = new Uint32Array(16);
  params[0] = points.length;
  for (let i = 0; i < points.length; i += 1) {
    const [location, level] = points[i];
    params[1 + i] = location >>> 0;
    params[8 + i] = level >>> 0;
  }
  return params;
}

function assertSamplesClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= EPSILON,
      `sample ${i}: ${actual[i]} != ${expected[i]}`
    );
  }
}

function assertConstantWindow(out, start, end, expected) {
  for (let i = start; i <= end; i += 1) {
    assert.ok(Math.abs(out[i] - expected) <= EPSILON, `sample ${i}: ${out[i]} != ${expected}`);
  }
}

test("gaincWindowEncAt5 keeps a neutral envelope flat", () => {
  const out = new Float32Array(256);

  const last = gaincWindowEncAt5(null, null, out);

  assert.equal(last, FLAT_WINDOW_END);
  assertConstantWindow(out, 0, 255, 1);
});

test("gaincWindowEncAt5 applies release ramps across the leading half of the window", () => {
  const release = createGainParams([[0, 7]]);
  const out = new Float32Array(256);

  const last = gaincWindowEncAt5(null, release, out);

  assert.equal(last, 131);
  assertConstantWindow(out, 0, 127, 2);
  assertSamplesClose(out.slice(128, 132), [
    2,
    2 * AT5_GAINC_WINDOW[2],
    2 * AT5_GAINC_WINDOW[1],
    2 * AT5_GAINC_WINDOW[0],
  ]);
  assertConstantWindow(out, 132, 255, 1);
});

test("gaincWindowEncAt5 applies attack ramps at the start of the window", () => {
  const attack = createGainParams([[0, 7]]);
  const out = new Float32Array(256);

  const last = gaincWindowEncAt5(attack, null, out);

  assert.equal(last, 3);
  assertSamplesClose(out.slice(0, 4), [
    2,
    2 * AT5_GAINC_WINDOW[2],
    2 * AT5_GAINC_WINDOW[1],
    2 * AT5_GAINC_WINDOW[0],
  ]);
  assertConstantWindow(out, 4, 255, 1);
});

test("gaincWindowEncAt5 accumulates attack and release gains in the shared lead segment", () => {
  const attack = createGainParams([[0, 7]]);
  const release = createGainParams([[0, 7]]);
  const out = new Float32Array(256);

  const last = gaincWindowEncAt5(attack, release, out);

  assert.equal(last, 131);
  assertSamplesClose(out.slice(0, 4), [
    4,
    4 * AT5_GAINC_WINDOW[2],
    4 * AT5_GAINC_WINDOW[1],
    4 * AT5_GAINC_WINDOW[0],
  ]);
  assertConstantWindow(out, 4, 127, 2);
  assertSamplesClose(out.slice(128, 132), [
    2,
    2 * AT5_GAINC_WINDOW[2],
    2 * AT5_GAINC_WINDOW[1],
    2 * AT5_GAINC_WINDOW[0],
  ]);
  assertConstantWindow(out, 132, 255, 1);
});

test("gaincWindowEncAt5 renders descending transitions when later release segments drop back to unity", () => {
  const release = createGainParams([
    [0, 6],
    [10, 8],
  ]);
  const out = new Float32Array(256);

  const last = gaincWindowEncAt5(null, release, out);

  assert.equal(last, 171);
  assertConstantWindow(out, 0, 127, 1);
  assertSamplesClose(out.slice(128, 132), [
    1,
    4 * AT5_GAINC_WINDOW[3],
    4 * AT5_GAINC_WINDOW[4],
    4 * AT5_GAINC_WINDOW[5],
  ]);
  assertConstantWindow(out, 132, 167, 4);
  assertSamplesClose(out.slice(168, 172), [
    4,
    4 * AT5_GAINC_WINDOW[5],
    4 * AT5_GAINC_WINDOW[4],
    4 * AT5_GAINC_WINDOW[3],
  ]);
  assertConstantWindow(out, 172, 255, 1);
});
