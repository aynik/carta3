import assert from "node:assert/strict";
import test from "node:test";

import {
  insertDerivativeAttackEventsAt5,
  insertDerivativeReleaseEventsAt5,
} from "../../../src/atrac3plus/gainc/set-derivative-insertions.js";

function createGainPassOutput() {
  return {
    len: new Int32Array(8),
    idx: new Int32Array(8),
    frac: new Float32Array(8),
  };
}

test("insertDerivativeAttackEventsAt5 inserts a derivative attack and clamps it to the shared bit budget", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivAttackOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(100);

  ampWindow.fill(1, 0, 16);
  derivAttackOut.len[0] = 4;
  derivAttackOut.idx[1] = 15;

  const insertion = insertDerivativeAttackEventsAt5(
    1,
    0,
    0,
    attackOut,
    releaseOut,
    decisionCurve,
    derivAttackOut,
    1,
    0,
    0,
    ampWindow,
    3,
    2
  );

  assert.equal(insertion, 1);
  assert.equal(attackOut.len[0], 1);
  assert.equal(attackOut.idx[1], 15);
});

test("insertDerivativeAttackEventsAt5 preserves the band-0 history guard", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivAttackOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(100);

  ampWindow.fill(1, 0, 16);
  derivAttackOut.len[0] = 2;
  derivAttackOut.idx[1] = 15;

  const insertion = insertDerivativeAttackEventsAt5(
    1,
    0,
    0,
    attackOut,
    releaseOut,
    decisionCurve,
    derivAttackOut,
    0,
    100001,
    1,
    ampWindow,
    4,
    0
  );

  assert.equal(insertion, 0);
  assert.equal(attackOut.idx[1], 0);
});

test("insertDerivativeAttackEventsAt5 inserts between existing forward-ordered attack events", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivAttackOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(100);

  ampWindow.fill(1, 0, 17);
  attackOut.len[0] = 1;
  attackOut.len[1] = 1;
  attackOut.idx[1] = 8;
  attackOut.idx[2] = 24;
  derivAttackOut.len[0] = 2;
  derivAttackOut.idx[1] = 16;

  const insertion = insertDerivativeAttackEventsAt5(
    1,
    2,
    0,
    attackOut,
    releaseOut,
    decisionCurve,
    derivAttackOut,
    1,
    0,
    0,
    ampWindow,
    4,
    0
  );

  assert.equal(insertion, 3);
  assert.deepEqual(Array.from(attackOut.idx.slice(1, 4)), [8, 16, 24]);
});

test("insertDerivativeAttackEventsAt5 can accept multiple derivative attacks in one pass", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivAttackOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(100);

  ampWindow.fill(1, 0, 24);
  derivAttackOut.len[0] = 2;
  derivAttackOut.idx[1] = 12;
  derivAttackOut.len[1] = 2;
  derivAttackOut.idx[2] = 20;

  const insertion = insertDerivativeAttackEventsAt5(
    2,
    0,
    0,
    attackOut,
    releaseOut,
    decisionCurve,
    derivAttackOut,
    1,
    0,
    0,
    ampWindow,
    4,
    0
  );

  assert.equal(insertion, 2);
  assert.deepEqual(Array.from(attackOut.len.slice(0, 2)), [2, 2]);
  assert.deepEqual(Array.from(attackOut.idx.slice(1, 3)), [12, 20]);
});

test("insertDerivativeAttackEventsAt5 blocks an adjacent split after a derivative attack is inserted", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivAttackOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(100);

  ampWindow.fill(1, 0, 18);
  derivAttackOut.len[0] = 2;
  derivAttackOut.idx[1] = 12;
  derivAttackOut.len[1] = 2;
  derivAttackOut.idx[2] = 13;

  const insertion = insertDerivativeAttackEventsAt5(
    2,
    0,
    0,
    attackOut,
    releaseOut,
    decisionCurve,
    derivAttackOut,
    1,
    0,
    0,
    ampWindow,
    4,
    0
  );

  assert.equal(insertion, 1);
  assert.deepEqual(Array.from(attackOut.idx.slice(1, 2)), [12]);
});

test("insertDerivativeReleaseEventsAt5 inserts a derivative release when the low side dominates", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivReleaseOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(1);

  ampWindow.fill(100, 0, 16);
  derivReleaseOut.len[0] = 2;
  derivReleaseOut.idx[1] = 16;

  const insertion = insertDerivativeReleaseEventsAt5(
    1,
    0,
    0,
    attackOut,
    releaseOut,
    decisionCurve,
    derivReleaseOut,
    ampWindow,
    4,
    0
  );

  assert.equal(insertion, 1);
  assert.equal(releaseOut.len[0], 2);
  assert.equal(releaseOut.idx[1], 16);
});

test("insertDerivativeReleaseEventsAt5 keeps adjacent release splits blocked", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivReleaseOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(1);

  ampWindow.fill(100, 0, 16);
  releaseOut.len[0] = 1;
  releaseOut.idx[1] = 16;
  derivReleaseOut.len[0] = 2;
  derivReleaseOut.idx[1] = 15;

  const insertion = insertDerivativeReleaseEventsAt5(
    1,
    0,
    1,
    attackOut,
    releaseOut,
    decisionCurve,
    derivReleaseOut,
    ampWindow,
    4,
    0
  );

  assert.equal(insertion, 1);
  assert.equal(releaseOut.len[0], 1);
  assert.equal(releaseOut.idx[1], 16);
});

test("insertDerivativeReleaseEventsAt5 inserts between existing tail-ordered release events", () => {
  const attackOut = createGainPassOutput();
  const releaseOut = createGainPassOutput();
  const decisionCurve = new Int32Array(33);
  const derivReleaseOut = createGainPassOutput();
  const ampWindow = new Float32Array(33).fill(1);

  ampWindow.fill(100, 0, 21);
  releaseOut.len[0] = 1;
  releaseOut.len[1] = 1;
  releaseOut.idx[1] = 24;
  releaseOut.idx[2] = 16;
  derivReleaseOut.len[0] = 2;
  derivReleaseOut.idx[1] = 20;

  const insertion = insertDerivativeReleaseEventsAt5(
    1,
    0,
    2,
    attackOut,
    releaseOut,
    decisionCurve,
    derivReleaseOut,
    ampWindow,
    4,
    0
  );

  assert.equal(insertion, 3);
  assert.deepEqual(Array.from(releaseOut.idx.slice(1, 4)), [24, 20, 16]);
});
