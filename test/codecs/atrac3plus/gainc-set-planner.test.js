import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTailRestartEventAt5,
  augmentBand0AttackFromBand1At5,
  createReleaseSeedStateAt5,
} from "../../../src/atrac3plus/gainc/set.js";
import { createScratch } from "../../../src/atrac3plus/gainc/set-helpers.js";
import {
  applyCurveRaiseSeedLimitAt5,
  classifyCurveSegmentAt5,
  classifyCurveSegmentsAt5,
  computeAmpScaledMaxAt5,
  computeAttackSeedLimitAt5,
  computeDerivativeSeedLimitAt5,
  findLastCurveTransitionPeakAt5,
  findWidestCurveRaiseCandidateAt5,
  planGainControlCurvePhase,
  resetOverflowedGaincOutputAt5,
  scanSuppressedGainRunsAt5,
  writeGainControlPointsAt5,
} from "../../../src/atrac3plus/gainc/set-planner.js";

function createGainPassOutput() {
  return {
    len: new Int32Array(8),
    idx: new Int32Array(8),
    frac: new Float32Array(8),
  };
}

function createCurveRaiseCandidateBuffer(overrides = {}) {
  return Object.assign([], overrides);
}

function createGaincRecord(overrides = {}) {
  return {
    entries: 0,
    locations: new Uint32Array(7),
    levels: new Uint32Array(7),
    attackTotal: 5,
    releaseTotal: 4,
    attackPoints: 2,
    releaseLast: 31,
    attackFirst: 3,
    attackRoundDownCarry: 0,
    ampScaledMax: 9,
    minHi: 5,
    minAll: 7,
    attackSeedLimit: 8,
    releaseTotalB: 6,
    attackTotalB: 7,
    derivMaxHi: 4,
    derivMaxAll: 6,
    derivSeedLimit: 5,
    minTail: 0,
    histA: 0,
    histB: 0,
    ...overrides,
  };
}

test("augmentBand0AttackFromBand1At5 seeds band 0 from the neighboring band attack", () => {
  const attackOut = createGainPassOutput();

  const attackCount = augmentBand0AttackFromBand1At5(
    0,
    {
      gainBase: 1,
      tlev: 15,
      minAll: 5,
    },
    {
      attackPoints: 1,
      attackTotal: 2,
      attackFirst: 9,
      releaseLast: 20,
      minAll: 4,
    },
    attackOut,
    0,
    0,
    4,
    0
  );

  assert.equal(attackCount, 1);
  assert.equal(attackOut.len[0], 1);
  assert.equal(attackOut.idx[1], 9);
});

test("augmentBand0AttackFromBand1At5 widens a short inherited attack when bit budget allows it", () => {
  const attackOut = createGainPassOutput();
  attackOut.len[0] = 1;
  attackOut.idx[1] = 7;

  const attackCount = augmentBand0AttackFromBand1At5(
    0,
    {
      gainBase: 1,
      tlev: 15,
      minAll: 5,
    },
    {
      attackPoints: 1,
      attackTotal: 4,
      attackFirst: 11,
      releaseLast: 20,
      minAll: 4,
    },
    attackOut,
    1,
    0,
    4,
    1
  );

  assert.equal(attackCount, 1);
  assert.equal(attackOut.len[0], 2);
  assert.equal(attackOut.idx[1], 11);
});

test("createReleaseSeedStateAt5 clamps an over-strong high-half peak back to the low-half peak", () => {
  const ampWindow = new Float32Array(64);
  ampWindow[32 + 5] = 10;
  ampWindow[48 + 7] = 20;

  assert.deepEqual(createReleaseSeedStateAt5(ampWindow, 0x20, 0x30, 4, 1, 0, 4, 2), {
    currentPeak: 10,
    highPeak: 20,
    restarted: 1,
    startPeak: 4,
    budgetBits: 3,
    scale: 3.5,
  });
});

test("createReleaseSeedStateAt5 keeps the previous high-half seed when the new peak is a fresh release start", () => {
  const derivWindow = new Float32Array(0x64);
  derivWindow[0x44 + 3] = 10;
  derivWindow[0x54 + 5] = 12;

  assert.deepEqual(createReleaseSeedStateAt5(derivWindow, 0x44, 0x54, 4, 1, 0, 4), {
    currentPeak: 12,
    highPeak: 12,
    restarted: 1,
    startPeak: 4,
    budgetBits: 3,
  });
});

test("createReleaseSeedStateAt5 updates the remembered high-half maximum when no fresh release starts", () => {
  const derivWindow = new Float32Array(0x64);
  derivWindow[0x44 + 3] = 5;
  derivWindow[0x54 + 5] = 12;

  assert.deepEqual(createReleaseSeedStateAt5(derivWindow, 0x44, 0x54, 10, 1, 0, 4), {
    currentPeak: 5,
    highPeak: 12,
    restarted: 0,
    startPeak: 5,
    budgetBits: 3,
  });
});

test("computeAttackSeedLimitAt5 preserves the single-segment high-band clamp", () => {
  assert.equal(
    computeAttackSeedLimitAt5(1, new Float32Array(32), 0, 0, 0, { minHi: 4, minAll: 5 }, 1.5),
    4
  );
});

test("computeAttackSeedLimitAt5 preserves the release-led low-half fallback to the high-band floor", () => {
  const curveDiffs = new Float32Array(32);
  curveDiffs[8] = -1;

  assert.equal(computeAttackSeedLimitAt5(2, curveDiffs, 8, 10, 5, { minHi: 4, minAll: 6 }, 2), 4);
});

test("computeAttackSeedLimitAt5 preserves the attack-led upper-half peak fallback", () => {
  const curveDiffs = new Float32Array(32);
  curveDiffs[20] = 1;

  assert.equal(computeAttackSeedLimitAt5(2, curveDiffs, 20, 8, 6, { minHi: 4, minAll: 6 }, 2), 6);
});

test("findLastCurveTransitionPeakAt5 preserves the trailing peak search before the last curve change", () => {
  const ampWindow = new Float32Array(33);
  const curveDiffs = new Float32Array(32);
  ampWindow[32] = 4;
  ampWindow[25] = 7;
  ampWindow[31] = 6;
  curveDiffs[20] = 1;

  assert.deepEqual(findLastCurveTransitionPeakAt5(ampWindow, curveDiffs), {
    peakIndex: 20,
    peakRunning: 7,
  });
});

test("classifyCurveSegmentsAt5 writes each segment policy in order", () => {
  const segments = [
    {
      incomingDirection: 1,
      outgoingDirection: 2,
      start: 5,
      endExclusive: 8,
      peakValue: 14,
      mode: 0,
      thresholdValue: 0,
    },
    {
      incomingDirection: 2,
      outgoingDirection: 0,
      start: 9,
      endExclusive: 12,
      peakValue: 15,
      mode: 0,
      thresholdValue: 0,
    },
    {
      incomingDirection: 0,
      outgoingDirection: 2,
      start: 13,
      endExclusive: 16,
      peakValue: 16,
      mode: 0,
      thresholdValue: 0,
    },
  ];
  const ampWindow = new Float32Array(32);

  ampWindow[5] = 10;
  ampWindow[7] = 9;
  ampWindow[8] = 8;
  ampWindow[15] = 11;

  classifyCurveSegmentsAt5(segments, 3, ampWindow, 7, 6);

  assert.deepEqual(
    segments.map(({ mode }) => mode),
    [6, 8, 2]
  );
  assert.deepEqual(
    segments.map(({ thresholdValue }) => thresholdValue),
    [9, 7, 11]
  );
});

test("classifyCurveSegmentAt5 preserves the rising-to-falling threshold fallback at the trailing edge", () => {
  const ampWindow = new Float32Array(32);
  ampWindow[5] = 10;
  ampWindow[7] = 9;
  ampWindow[8] = 8;

  assert.deepEqual(
    classifyCurveSegmentAt5(
      {
        incomingDirection: 1,
        outgoingDirection: 2,
        start: 5,
        endExclusive: 8,
        peakValue: 14,
      },
      ampWindow,
      7,
      6
    ),
    {
      mode: 6,
      thresholdBits: 9,
    }
  );
});

test("classifyCurveSegmentAt5 preserves release-led flat segments as mode 8 using the release peak", () => {
  const ampWindow = new Float32Array(32);

  assert.deepEqual(
    classifyCurveSegmentAt5(
      {
        incomingDirection: 2,
        outgoingDirection: 0,
        start: 5,
        endExclusive: 8,
        peakValue: 14,
      },
      ampWindow,
      7,
      6
    ),
    {
      mode: 8,
      thresholdBits: 7,
    }
  );
});

test("classifyCurveSegmentAt5 preserves attack-led falling segments as mode 2 using the trailing edge", () => {
  const ampWindow = new Float32Array(32);
  ampWindow[7] = 11;

  assert.deepEqual(
    classifyCurveSegmentAt5(
      {
        incomingDirection: 0,
        outgoingDirection: 2,
        start: 5,
        endExclusive: 8,
        peakValue: 14,
      },
      ampWindow,
      7,
      6
    ),
    {
      mode: 2,
      thresholdBits: 11,
    }
  );
});

test("scanSuppressedGainRunsAt5 emits only in-range suppressed runs and reports the trailing run state", () => {
  const ampWindow = new Float32Array([20, 3, 4, 20, 2, 3, 4, 20]);
  const acceptedRuns = [];

  const trailingRun = scanSuppressedGainRunsAt5(0, 8, 1, 10, 1, ampWindow, acceptedRuns);

  assert.deepEqual(acceptedRuns, [
    { start: 1, end: 3, value: 4 },
    { start: 4, end: 7, value: 4 },
  ]);
  assert.deepEqual(trailingRun, {
    start: 8,
    end: 8,
    value: 4,
  });
});

test("scanSuppressedGainRunsAt5 preserves the current tail-overrun stop behavior", () => {
  const ampWindow = new Float32Array(40).fill(1);
  ampWindow[33] = 20;
  const acceptedRuns = [];

  const trailingRun = scanSuppressedGainRunsAt5(30, 36, 1, 10, 1, ampWindow, acceptedRuns);

  assert.deepEqual(acceptedRuns, []);
  assert.deepEqual(trailingRun, {
    start: 30,
    end: 33,
    value: 4,
  });
});

test("findWidestCurveRaiseCandidateAt5 returns the widest candidate span and keeps the first tie", () => {
  const runCandidates = createCurveRaiseCandidateBuffer();
  runCandidates.push(
    { start: 4, end: 8, value: 0, mode: 0 },
    { start: 9, end: 15, value: 0, mode: 0 },
    { start: 14, end: 20, value: 0, mode: 0 },
    { start: 18, end: 24, value: 0, mode: 0 }
  );

  assert.equal(findWidestCurveRaiseCandidateAt5(runCandidates), 1);

  runCandidates[2].end = 20;
  assert.equal(findWidestCurveRaiseCandidateAt5(runCandidates), 1);
});

test("findWidestCurveRaiseCandidateAt5 returns -1 when no candidates exist", () => {
  assert.equal(findWidestCurveRaiseCandidateAt5(createCurveRaiseCandidateBuffer()), -1);
});

test("applyCurveRaiseSeedLimitAt5 preserves the tail-side clamp selection order", () => {
  const currentRecord = createGaincRecord({
    attackSeedLimit: 9,
    attackRoundDownCarry: 0,
  });
  const plannedCurveRaiseEntries = [
    { start: 5, end: 40, rangeValue: 7 },
    { start: 3, end: 50, rangeValue: 4 },
    { start: 9, end: 45, rangeValue: 6 },
  ];

  assert.deepEqual(applyCurveRaiseSeedLimitAt5(currentRecord, plannedCurveRaiseEntries, 4), {
    attackSeedLimit: 6,
    lastCoveredEnd: 8,
    attackRoundDownCarry: 1,
  });
});

test("computeAmpScaledMaxAt5 refreshes the gain scale only when the curve exponent changes", () => {
  const curve = new Int32Array(33);
  const ampWindow = new Float32Array(32);
  curve[0] = 0;
  curve[1] = 0;
  curve[2] = 1;
  curve[3] = 1;
  ampWindow[0] = 3;
  ampWindow[1] = 4;
  ampWindow[2] = 2;
  ampWindow[3] = 3;

  assert.equal(computeAmpScaledMaxAt5(curve, ampWindow), 6);
});

test("computeDerivativeSeedLimitAt5 preserves the no-change fallback to the derivative high-band peak", () => {
  const derivCurve = new Int32Array(33);
  const derivWindow = new Float32Array(101);

  assert.deepEqual(
    computeDerivativeSeedLimitAt5(
      derivCurve,
      derivWindow,
      3,
      createGaincRecord({
        derivMaxHi: 5,
        derivMaxAll: 9,
      }),
      2
    ),
    {
      derivSeedLimit: 5,
      lastChange: -1,
      tailPeak: 0,
    }
  );
});

test("computeDerivativeSeedLimitAt5 preserves the release-led clamp back to the high-band derivative peak", () => {
  const derivCurve = new Int32Array(33);
  const derivWindow = new Float32Array(101);
  derivCurve.fill(1, 9);
  derivCurve[8] = 0;
  derivWindow[0x24 + 31] = 3;

  assert.deepEqual(
    computeDerivativeSeedLimitAt5(
      derivCurve,
      derivWindow,
      12,
      createGaincRecord({
        derivMaxHi: 5,
        derivMaxAll: 8,
      }),
      2
    ),
    {
      derivSeedLimit: 5,
      lastChange: 8,
      tailPeak: 3,
    }
  );
});

test("resetOverflowedGaincOutputAt5 clears the gain point payload and restores fallback limits", () => {
  const currentRecord = createGaincRecord({
    entries: 3,
    attackRoundDownCarry: 1,
    locations: Uint32Array.from([1, 2, 3, 0, 0, 0, 0]),
    levels: Uint32Array.from([4, 5, 6, 0, 0, 0, 0]),
  });
  const ampPairs = new Float32Array(32);
  ampPairs[31] = 11;

  resetOverflowedGaincOutputAt5(currentRecord, 2, true, ampPairs, 13, 14);

  assert.equal(currentRecord.entries, 0);
  assert.deepEqual(Array.from(currentRecord.locations), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(currentRecord.levels), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(currentRecord.attackTotal, 0);
  assert.equal(currentRecord.releaseTotal, 0);
  assert.equal(currentRecord.attackPoints, 0);
  assert.equal(currentRecord.releaseLast, 0);
  assert.equal(currentRecord.attackFirst, 0);
  assert.equal(currentRecord.attackRoundDownCarry, 0);
  assert.equal(currentRecord.ampScaledMax, 7);
  assert.equal(currentRecord.attackSeedLimit, 5);
  assert.equal(currentRecord.releaseTotalB, 0);
  assert.equal(currentRecord.attackTotalB, 0);
  assert.equal(currentRecord.derivSeedLimit, 4);
  assert.equal(currentRecord.minTail, 11);
  assert.equal(currentRecord.histA, 13);
  assert.equal(currentRecord.histB, 14);
});

test("writeGainControlPointsAt5 preserves current overflow reset behavior after the seventh transition", () => {
  const currentRecord = createGaincRecord();
  const curve = new Int32Array(33);
  const ampPairs = new Float32Array(32);

  for (let i = 0; i < 8; i += 1) {
    curve[i] = i;
    curve[i + 1] = i + 1;
  }
  ampPairs[31] = 9;

  assert.equal(writeGainControlPointsAt5(currentRecord, curve, 2, true, ampPairs, 10, 11), -1);

  assert.equal(currentRecord.entries, 0);
  assert.equal(currentRecord.attackSeedLimit, 5);
  assert.equal(currentRecord.derivSeedLimit, 4);
  assert.equal(currentRecord.minTail, 9);
  assert.equal(currentRecord.histA, 10);
  assert.equal(currentRecord.histB, 11);
});

test("planGainControlCurvePhase promotes a long suppressed valley into a planned curve raise", () => {
  const scratch = createScratch();
  scratch.ampWindow.fill(32, 0, 32);
  for (let i = 10; i < 20; i += 1) {
    scratch.ampWindow[i] = 4;
  }

  const currentRecord = createGaincRecord({
    gainBase: 1,
    minAll: 32,
    minHi: 16,
    attackSeedLimit: 32,
  });

  const gaincScaleCoef = planGainControlCurvePhase(
    { scratch, cur: currentRecord, bandIndex: 0, cfgMode: 2, withFrac: 0 },
    {
      releaseCur: 4,
      currentReleasePeak: 8,
      noisyHist: 0,
      derivAttackCount: 0,
      derivReleaseCount: 0,
      derivReleaseCur: 0,
    },
    { attack: { seedStart: 16 } },
    0
  );

  assert.equal(gaincScaleCoef, 2);
  assert.deepEqual(
    Array.from(scratch.curve.slice(8, 22)),
    [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0]
  );
  assert.deepEqual(scratch.plannedCurveRaiseEntries, [
    {
      scaledGainRatio: 8,
      start: 10,
      end: 20,
      span: 10,
      gainBits: 2,
      rangeValue: 4,
    },
  ]);
  assert.deepEqual(scratch.initialCurveRaiseCandidates, [
    {
      start: 10,
      end: 20,
      value: 4,
      mode: 9,
    },
  ]);
  assert.equal(currentRecord.attackSeedLimit, 32);
  assert.equal(currentRecord.attackRoundDownCarry, 0);
  assert.equal(currentRecord.ampScaledMax, 32);
});

test("planGainControlCurvePhase preserves zero-start refinement seeding for derivative-only segments", () => {
  const scratch = createScratch();
  scratch.curve.fill(0);
  scratch.curve.fill(1, 0, 11);
  scratch.ampWindow.fill(32, 0, 32);
  for (let i = 0; i < 11; i += 1) {
    scratch.ampWindow[i] = 4;
  }

  const currentRecord = createGaincRecord({
    gainBase: 1,
    minAll: 32,
    minHi: 16,
    attackSeedLimit: 32,
  });

  const gaincScaleCoef = planGainControlCurvePhase(
    { scratch, cur: currentRecord, bandIndex: 0, cfgMode: 2, withFrac: 1 },
    {
      releaseCur: 4,
      currentReleasePeak: 8,
      noisyHist: 0,
      derivAttackCount: 0,
      derivReleaseCount: 0,
      derivReleaseCur: 0,
    },
    { attack: { seedStart: 8 } },
    0
  );

  assert.equal(gaincScaleCoef, 2);
  assert.deepEqual(
    Array.from(scratch.curve.slice(0, 16)),
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(scratch.plannedCurveRaiseEntries, []);
  assert.deepEqual(scratch.initialCurveRaiseCandidates, [
    {
      start: 0,
      end: 11,
      value: 4,
      mode: 1,
    },
  ]);
  assert.equal(currentRecord.attackSeedLimit, 16);
  assert.equal(currentRecord.attackRoundDownCarry, 0);
  assert.equal(currentRecord.ampScaledMax, 32);
});

test("appendTailRestartEventAt5 appends a new attack event at the tail when the release restarts strongly", () => {
  const ampWindow = new Float32Array(64);
  const attackOut = createGainPassOutput();
  ampWindow[33] = 8;

  const attackCount = appendTailRestartEventAt5(1, 1, ampWindow[33], 2, attackOut, 0);

  assert.equal(attackCount, 1);
  assert.equal(attackOut.len[0], 2);
  assert.equal(attackOut.idx[1], 31);
});

test("appendTailRestartEventAt5 preserves the legacy fractional write slot when it overwrites an existing tail event", () => {
  const ampWindow = new Float32Array(64);
  const attackOut = createGainPassOutput();
  attackOut.len[0] = 7;
  attackOut.idx[1] = 31;
  attackOut.frac[0] = 0.25;
  ampWindow[33] = 2 * 2 ** 1.5;

  const attackCount = appendTailRestartEventAt5(1, 1, ampWindow[33], 2, attackOut, 1, true);

  assert.equal(attackCount, 1);
  assert.equal(attackOut.len[0], 1);
  assert.equal(attackOut.frac[0], 0.25);
  assert.ok(Math.abs(attackOut.frac[1] - 0.5) < 1e-6);
});

test("appendTailRestartEventAt5 appends a derivative tail event when capacity remains", () => {
  const derivWindow = new Float32Array(0x64);
  const derivAttackOut = createGainPassOutput();
  derivWindow[0x44] = 8;

  const derivAttackCount = appendTailRestartEventAt5(
    1,
    1,
    derivWindow[0x44],
    2,
    derivAttackOut,
    0,
    false,
    true
  );

  assert.equal(derivAttackCount, 1);
  assert.equal(derivAttackOut.len[0], 2);
  assert.equal(derivAttackOut.idx[1], 31);
});

test("appendTailRestartEventAt5 keeps the existing attack count when the tail budget is exhausted", () => {
  const derivWindow = new Float32Array(0x64);
  const derivAttackOut = createGainPassOutput();
  derivWindow[0x44] = 8;

  const derivAttackCount = appendTailRestartEventAt5(
    1,
    1,
    derivWindow[0x44],
    2,
    derivAttackOut,
    6,
    false,
    true
  );

  assert.equal(derivAttackCount, 6);
  assert.equal(derivAttackOut.idx[7], 0);
});
