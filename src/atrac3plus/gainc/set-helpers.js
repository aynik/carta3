import { fGt } from "./fp.js";

const SLOTS = 0x20;
const MAX_POINTS = 7;
const MAX_SEGMENTS = 8;
const CURVE_WORDS = 0x21;
const PAIR_WORDS = 0x24;
const TABLE0_WORDS = 0x21;
const TABLE1_WORDS = 0x20;

const ANALYSIS_MAXABS_OFFSET = 0x100;
const ANALYSIS_METRIC_OFFSET = 0x180;
const ANALYSIS_DERIV_OFFSET = 0x100;
const ANALYSIS_DERIV_END = 0x180;

import { createGainPassOutput } from "./passes.js";

function createCurveRaiseCandidateBuffer() {
  return [];
}

function createPlannedCurveRaiseEntries() {
  return [];
}

function resetGainPassOutput(o) {
  o.idx.fill(0);
  o.len.fill(0);
  o.frac.fill(0);
}

function createScratch() {
  return {
    ampWindow: new Float32Array(66),
    derivWindow: new Float32Array(101),
    derivVals: new Float32Array(ANALYSIS_DERIV_END),
    ampPairs: new Float32Array(PAIR_WORDS),
    releaseVals4: new Float32Array(PAIR_WORDS),
    curve: new Int32Array(CURVE_WORDS),
    curveDiffs: new Int32Array(33),
    decisionCurve: new Int32Array(CURVE_WORDS),
    attackOut: createGainPassOutput(),
    releaseOut: createGainPassOutput(),
    derivAttackOut: createGainPassOutput(),
    derivReleaseOut: createGainPassOutput(),
    suppressedCurveRuns: createCurveRaiseCandidateBuffer(),
    initialCurveRaiseCandidates: createCurveRaiseCandidateBuffer(),
    refinementCurveRaiseCandidates: createCurveRaiseCandidateBuffer(),
    plannedCurveRaiseEntries: createPlannedCurveRaiseEntries(),
    segments: Array.from({ length: MAX_SEGMENTS }, () => ({
      start: 0,
      endExclusive: 0,
      incomingDirection: 0,
      outgoingDirection: 0,
      mode: 0,
      peakValue: 4,
      thresholdValue: 0,
    })),
  };
}

function getScratch(block) {
  if (!block) return null;
  return (block.gaincScratch ??= createScratch());
}

function maxAbsFloor4(src, base, count) {
  let maxv = 4.0;
  for (let i = 0; i < count; i++) {
    const absf = Math.abs(src[base + i]);
    if (fGt(absf, maxv)) maxv = absf;
  }
  return maxv;
}

export {
  ANALYSIS_DERIV_END,
  ANALYSIS_DERIV_OFFSET,
  ANALYSIS_MAXABS_OFFSET,
  ANALYSIS_METRIC_OFFSET,
  CURVE_WORDS,
  MAX_POINTS,
  MAX_SEGMENTS,
  PAIR_WORDS,
  SLOTS,
  TABLE0_WORDS,
  TABLE1_WORDS,
  createCurveRaiseCandidateBuffer,
  createScratch,
  createPlannedCurveRaiseEntries,
  getScratch,
  maxAbsFloor4,
  resetGainPassOutput,
};
