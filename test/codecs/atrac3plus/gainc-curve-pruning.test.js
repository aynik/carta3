import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCurveRaiseCandidateAt5 } from "../../../src/atrac3plus/gainc/passes.js";
import {
  pruneAndNormalizeCurve,
  seedZeroStartCurveRaiseCandidatesAt5,
} from "../../../src/atrac3plus/gainc/set-planner.js";
import {
  createCurveRaiseCandidateBuffer,
  createPlannedCurveRaiseEntries,
} from "../../../src/atrac3plus/gainc/set-helpers.js";

test("pruneAndNormalizeCurve removes the lowest-score GC entry first and stops once the transition budget is met", () => {
  const curve = new Int32Array(33);
  const plannedCurveRaiseEntries = createPlannedCurveRaiseEntries();

  curve.set([0, 1, 0, 1, 0, 1, 0, 1, 0]);

  plannedCurveRaiseEntries.push(
    { scaledGainRatio: 10, start: 3, end: 4, span: 1, gainBits: 1, rangeValue: 0 },
    { scaledGainRatio: 1, start: 1, end: 2, span: 1, gainBits: 1, rangeValue: 0 }
  );

  assert.equal(pruneAndNormalizeCurve(curve, plannedCurveRaiseEntries), 6);
  assert.equal(curve[1], 0);
  assert.equal(curve[3], 1);
});

test("pruneAndNormalizeCurve normalizes the tail to zero and clamps the curve range", () => {
  const curve = new Int32Array(33).fill(2);
  const plannedCurveRaiseEntries = createPlannedCurveRaiseEntries();

  curve[0] = 12;
  curve[1] = -10;

  assert.equal(pruneAndNormalizeCurve(curve, plannedCurveRaiseEntries), 2);
  assert.equal(curve[0], 9);
  assert.equal(curve[1], -6);
  assert.equal(curve[2], 0);
  assert.equal(curve[32], 0);
});

test("pruneAndNormalizeCurve keeps the earlier raise when multiple candidates share the same score", () => {
  const curve = new Int32Array(33);
  const plannedCurveRaiseEntries = createPlannedCurveRaiseEntries();

  curve.set([0, 1, 0, 1, 0, 1, 0, 1, 0]);

  plannedCurveRaiseEntries.push(
    { scaledGainRatio: 3, start: 1, end: 2, span: 2, gainBits: 1, rangeValue: 0 },
    { scaledGainRatio: 2, start: 3, end: 4, span: 3, gainBits: 1, rangeValue: 0 }
  );

  pruneAndNormalizeCurve(curve, plannedCurveRaiseEntries);

  assert.equal(curve[1], 0);
  assert.equal(curve[3], 1);
});

test("seedZeroStartCurveRaiseCandidatesAt5 emits a leading suppressed run for zero-start segments", () => {
  const segment = {
    start: 0,
    endExclusive: 3,
    mode: 3,
    thresholdValue: 5,
  };
  const ampWindow = new Float32Array([2, 4, 3, 10]);
  const initialCurveRaiseCandidates = createCurveRaiseCandidateBuffer();

  seedZeroStartCurveRaiseCandidatesAt5(segment, ampWindow, 1, initialCurveRaiseCandidates);

  assert.deepEqual(initialCurveRaiseCandidates, [{ start: 0, end: 3, value: 4, mode: 3 }]);
});

test("seedZeroStartCurveRaiseCandidatesAt5 preserves the current no-flush behavior for runs that reach the segment end", () => {
  const segment = {
    start: 0,
    endExclusive: 2,
    mode: 3,
    thresholdValue: 5,
  };
  const ampWindow = new Float32Array([2, 4, 3]);
  const initialCurveRaiseCandidates = createCurveRaiseCandidateBuffer();

  seedZeroStartCurveRaiseCandidatesAt5(segment, ampWindow, 1, initialCurveRaiseCandidates);

  assert.deepEqual(initialCurveRaiseCandidates, []);
});

test("evaluateCurveRaiseCandidateAt5 returns the updated planner event count", () => {
  const initialCurveRaiseCandidates = createCurveRaiseCandidateBuffer();
  const plannedCurveRaiseEntries = createPlannedCurveRaiseEntries();
  const vals = new Float32Array(33);
  const idxs = new Int32Array(33);
  const diffs = new Int32Array(33);

  vals[0] = 8;
  vals[1] = 2;
  vals[10] = 10;

  const totalEventCount = evaluateCurveRaiseCandidateAt5(
    1,
    {
      start: 1,
      end: 10,
      value: 2,
    },
    initialCurveRaiseCandidates,
    vals,
    idxs,
    diffs,
    plannedCurveRaiseEntries,
    1,
    1,
    100,
    99
  );

  assert.equal(totalEventCount, 3);
  assert.deepEqual(plannedCurveRaiseEntries, [
    {
      scaledGainRatio: 4,
      start: 1,
      end: 10,
      span: 9,
      gainBits: 1,
      rangeValue: 2,
    },
  ]);
  assert.equal(idxs[1], 1);
  assert.equal(idxs[9], 1);
  assert.equal(diffs[0], -1);
  assert.equal(diffs[9], 1);
  assert.deepEqual(initialCurveRaiseCandidates, [{ start: 1, end: 10, value: 2, mode: 0x9 }]);
});
