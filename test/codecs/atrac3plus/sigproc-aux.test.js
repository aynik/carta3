import assert from "node:assert/strict";
import test from "node:test";

import {
  at5SigprocBandRow,
  at5SigprocCorrHistoryViews,
  at5SigprocMode3Views,
  at5SigprocShiftAux,
  createAt5SigprocAux,
} from "../../../src/atrac3plus/sigproc/aux.js";
import { at5T2fCorrByBandFromAux } from "../../../src/atrac3plus/time2freq/runtime.js";

function wordView(view) {
  return new Uint32Array(
    view.buffer,
    view.byteOffset,
    view.byteLength / Uint32Array.BYTES_PER_ELEMENT
  );
}

function fillWords(view, base) {
  for (let i = 0; i < view.length; i += 1) {
    view[i] = (base + i) >>> 0;
  }
}

test("createAt5SigprocAux preserves the intentional mode3 overlap and raw-byte accessors", () => {
  const aux = createAt5SigprocAux();
  const mode3FromBytes = at5SigprocMode3Views(aux.bytes);
  const corrHistoryFromBytes = at5SigprocCorrHistoryViews(aux.bytes);

  aux.mode3ToneValues[3] = 12.5;
  aux.mode3FlipValues[5] = -3.5;

  assert.equal(aux.corrMetric0Hist[3], 12.5);
  assert.equal(mode3FromBytes.toneValues[3], 12.5);
  assert.equal(corrHistoryFromBytes.metric0[3], 12.5);
  assert.equal(at5T2fCorrByBandFromAux(aux.bytes)?.[3], 12.5);

  const reservedAsFloat = new Float32Array(
    aux.reservedHist.buffer,
    aux.reservedHist.byteOffset,
    aux.reservedHist.length
  );
  assert.equal(reservedAsFloat[16 + 5], -3.5);
  assert.equal(mode3FromBytes.flipValues[5], -3.5);

  const secondMixRow = at5SigprocBandRow(aux.mixHist, 1);
  assert.equal(secondMixRow.length, 16);
  assert.equal(
    secondMixRow.byteOffset,
    aux.mixHist.byteOffset + 16 * Float32Array.BYTES_PER_ELEMENT
  );
});

test("at5SigprocShiftAux preserves the current correlation and reserved-history rotation", () => {
  const aux = createAt5SigprocAux();
  const corrLeadWords = wordView(aux.corrHist0);
  const metric0Words = wordView(aux.corrMetric0Hist);
  const metric1Words = wordView(aux.corrMetric1Hist);
  const metric2Words = wordView(aux.corrMetric2Hist);
  const flagWords = aux.corrFlagsHist;
  const reservedWords = aux.reservedHist;
  const dbDiffWords = wordView(aux.dbDiff);

  fillWords(metric0Words, 0x100);
  fillWords(metric1Words, 0x200);
  fillWords(metric2Words, 0x300);
  fillWords(flagWords, 0x400);
  fillWords(reservedWords, 0x500);
  fillWords(dbDiffWords, 0x600);

  const metric0Before = Array.from(metric0Words);
  const metric1Before = Array.from(metric1Words);
  const metric2Before = Array.from(metric2Words);
  const flagsBefore = Array.from(flagWords);
  const reservedBefore = Array.from(reservedWords);
  const dbDiffBefore = Array.from(dbDiffWords);

  at5SigprocShiftAux(aux);

  assert.deepEqual(Array.from(corrLeadWords), metric0Before.slice(0, 16));
  assert.deepEqual(Array.from(metric0Words), metric0Before.slice(16).concat(Array(16).fill(0)));
  assert.deepEqual(Array.from(metric1Words), metric1Before.slice(16).concat(Array(16).fill(0)));
  assert.deepEqual(Array.from(metric2Words), metric2Before.slice(16).concat(Array(16).fill(0)));
  assert.deepEqual(Array.from(flagWords), flagsBefore.slice(16).concat(Array(16).fill(0)));
  assert.deepEqual(Array.from(reservedWords), reservedBefore.slice(16).concat(dbDiffBefore));
  assert.deepEqual(Array.from(dbDiffWords), Array(16).fill(0));
});
