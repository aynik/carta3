import assert from "node:assert/strict";
import test from "node:test";

import { at5Time2freqMdctStage } from "../../../src/atrac3plus/time2freq/index.js";
import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/internal.js";

function setGainPoints(record, points) {
  record.entries = points.length;
  for (let i = 0; i < points.length; i += 1) {
    const [location, level] = points[i];
    record.locations[i] = location;
    record.levels[i] = level;
  }
}

test("at5Time2freqMdctStage exposes optional lowmode maxima output", () => {
  const prevBufs = [createAt5EncodeBufBlock()];
  const curBufs = [createAt5EncodeBufBlock()];
  const analysisRows = [new Float32Array(256).fill(1.5)];
  const quantizedSpectraByChannel = [new Float32Array(128)];
  const bitallocSpectraByChannel = [new Float32Array(128)];

  setGainPoints(curBufs[0].records[0], [[0, 6]]);

  const withMaxima = at5Time2freqMdctStage(
    prevBufs,
    curBufs,
    analysisRows,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
    1,
    1,
    0,
    true
  );
  const withoutMaxima = at5Time2freqMdctStage(
    prevBufs,
    curBufs,
    analysisRows,
    [new Float32Array(128)],
    [new Float32Array(128)],
    1,
    1,
    0,
    false
  );

  assert.ok(withMaxima.maxima);
  assert.equal(withMaxima.maxima.maxPre[0], 1.5);
  assert.equal(withMaxima.maxima.maxPost[0], 1.5);
  assert.equal(withoutMaxima.maxima, null);
});
