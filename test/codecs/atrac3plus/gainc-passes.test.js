import assert from "node:assert/strict";
import test from "node:test";

import {
  at5GaincBuildNormalizedCurve,
  at5GaincSpikeCount,
  attackPassAt5,
  createGainPassOutput,
  releasePassAt5,
} from "../../../src/atrac3plus/gainc/passes.js";

test("at5GaincBuildNormalizedCurve merges attack and release intervals into a tail-normalized curve", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const curve = new Int32Array(33).fill(99);

  attackOut.len.set([2, 1]);
  attackOut.idx.set([0, 1, 3]);
  releaseOut.len.set([2, 1]);
  releaseOut.idx.set([0, 4, 2]);

  at5GaincBuildNormalizedCurve(attackOut, 2, releaseOut, 2, curve);

  assert.deepEqual(Array.from(curve.slice(0, 6)), [0, 0, -1, -1, 0, 0]);
  assert.ok(Array.from(curve.slice(6)).every((value) => value === 0));
});

test("at5GaincSpikeCount counts a strong rise followed by a strong fall in the current window", () => {
  const window = new Float32Array(64).fill(1);
  window[32] = 1;
  window[33] = 5;
  window[34] = 5;
  window[35] = 5;
  window[36] = 1;

  assert.equal(at5GaincSpikeCount(window), 2);
});

test("at5GaincSpikeCount does not double-count a continuing upward run", () => {
  const window = new Float32Array(64).fill(25);
  window[31] = 1;
  window[32] = 1;
  window[33] = 5;
  window[34] = 25;

  assert.equal(at5GaincSpikeCount(window), 1);
});

test("attackPassAt5 rounds the first integer attack to nearest when no carry is pending", () => {
  const out = createGainPassOutput();

  const result = attackPassAt5({
    count: 1,
    step: 1,
    roundDownCarry: 0,
    totalBits: 0,
    bitLimit: 6,
    usedBits: 0,
    values: Float32Array.of(4, 7),
    currentPeak: 4,
    peakLimit: -1,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(result.eventCount, 1);
  assert.equal(out.len[0], 1);
  assert.equal(out.idx[1], 0);
  assert.equal(result.totalBits, 1);
  assert.equal(result.usedBits, 1);
  assert.equal(result.roundDownCarry, 0);
});

test("attackPassAt5 consumes a carried round-down before the first integer attack", () => {
  const out = createGainPassOutput();

  const result = attackPassAt5({
    count: 1,
    step: 1,
    roundDownCarry: 1,
    totalBits: 0,
    bitLimit: 6,
    usedBits: 0,
    values: Float32Array.of(4, 7),
    currentPeak: 4,
    peakLimit: -1,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(result.eventCount, 0);
  assert.equal(result.totalBits, 0);
  assert.equal(result.usedBits, 0);
  assert.equal(result.roundDownCarry, 0);
});

test("attackPassAt5 clamps a stale peak after the late scan window", () => {
  const out = createGainPassOutput();
  const values = new Float32Array(28).fill(10);
  values[27] = 25;

  const result = attackPassAt5({
    count: 27,
    step: 1,
    roundDownCarry: 0,
    totalBits: 0,
    bitLimit: 6,
    usedBits: 0,
    values,
    currentPeak: 100,
    peakLimit: 4,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(result.eventCount, 1);
  assert.equal(out.len[0], 1);
  assert.equal(out.idx[1], 26);
  assert.equal(result.totalBits, 1);
  assert.equal(result.usedBits, 1);
});

test("attackPassAt5 keeps the stepped coarse scan in event order", () => {
  const out = createGainPassOutput();

  const result = attackPassAt5({
    count: 4,
    step: 2,
    roundDownCarry: 0,
    totalBits: 0,
    bitLimit: 6,
    usedBits: 0,
    values: Float32Array.of(4, 0, 8, 0, 16),
    currentPeak: 4,
    peakLimit: -1,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(result.eventCount, 2);
  assert.deepEqual(Array.from(out.len.slice(0, 2)), [1, 1]);
  assert.deepEqual(Array.from(out.idx.slice(1, 3)), [1, 3]);
  assert.equal(result.totalBits, 2);
  assert.equal(result.usedBits, 2);
});

test("attackPassAt5 carries fractional remainder into the next large gain step", () => {
  const out = createGainPassOutput();

  const result = attackPassAt5({
    count: 2,
    step: 1,
    roundDownCarry: 0,
    totalBits: 0,
    bitLimit: 6,
    usedBits: 0,
    values: Float32Array.of(4, 7, 28),
    currentPeak: 4,
    peakLimit: -1,
    scale: 1,
    output: out,
    withFrac: 1,
  });

  assert.equal(result.eventCount, 2);
  assert.equal(result.totalBits, 3);
  assert.equal(result.usedBits, 3);
  assert.deepEqual(Array.from(out.len.slice(0, 2)), [1, 2]);
  assert.deepEqual(Array.from(out.idx.slice(1, 3)), [0, 1]);
  assert.ok(Math.abs(out.frac[0] + 0.1926450878381729) < 1e-6);
  assert.ok(Math.abs(out.frac[1]) < 1e-6);
});

test("releasePassAt5 returns the first release peak and bit usage in plain state", () => {
  const out = createGainPassOutput();
  const values = new Float32Array(33);
  const positionHints = new Float32Array(33);
  values[31] = 9;
  values[32] = 4;

  const result = releasePassAt5({
    count: 31,
    step: 1,
    usedBits: 0,
    bitLimit: 6,
    currentPeak: 4,
    initReleaseFlag: 1,
    values,
    positionHints,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(result.eventCount, 1);
  assert.equal(out.len[0], 1);
  assert.equal(out.idx[1], 32);
  assert.equal(result.usedBits, 1);
  assert.equal(result.currentPeak, 4);
});

test("releasePassAt5 seeds the first release peak from slot 0x80 when initReleaseFlag is clear", () => {
  const out = createGainPassOutput();
  const values = new Float32Array(0x81);
  const positionHints = new Float32Array(33);
  values[31] = 16;
  values[32] = 10;
  values[0x80] = 8;

  const result = releasePassAt5({
    count: 31,
    step: 1,
    usedBits: 0,
    bitLimit: 6,
    currentPeak: 4,
    initReleaseFlag: 0,
    values,
    positionHints,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(result.eventCount, 1);
  assert.equal(result.currentPeak, 8);
  assert.equal(out.len[0], 1);
  assert.equal(out.idx[1], 32);
});

test("releasePassAt5 backtracks the release point across the whole step window", () => {
  const out = createGainPassOutput();
  const values = new Float32Array(33);
  const positionHints = new Float32Array(33);
  values[31] = 9;
  values[32] = 4;
  positionHints[30] = 4;
  positionHints[31] = 4;

  releasePassAt5({
    count: 29,
    step: 3,
    usedBits: 0,
    bitLimit: 6,
    currentPeak: 4,
    initReleaseFlag: 1,
    values,
    positionHints,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(out.idx[1], 30);
});

test("releasePassAt5 stops backtracking when a position hint exceeds the release peak", () => {
  const out = createGainPassOutput();
  const values = new Float32Array(33);
  const positionHints = new Float32Array(33);
  values[31] = 9;
  values[32] = 4;
  positionHints[30] = 5;
  positionHints[31] = 4;

  releasePassAt5({
    count: 29,
    step: 3,
    usedBits: 0,
    bitLimit: 6,
    currentPeak: 4,
    initReleaseFlag: 1,
    values,
    positionHints,
    scale: 1,
    output: out,
    withFrac: 0,
  });

  assert.equal(out.idx[1], 31);
});
