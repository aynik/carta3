import assert from "node:assert/strict";
import test from "node:test";

import { at5ApplyMode3BandMaskAndFlipHintsAt5 } from "../../../src/atrac3plus/channel-block/internal.js";
import { createAt5SigprocAux } from "../../../src/atrac3plus/sigproc/aux.js";

function createMode3Fixture({
  toneCount = 0,
  mapSegmentCount = 0,
  idsf0 = [],
  idsf1 = [],
  hdrIdsf = [],
  level0 = 0,
  level1 = 0,
  scale0 = 0,
  scale1 = 0,
  toneActiveFlags = [],
  toneValues = [],
  flipValues = [],
} = {}) {
  const sharedAux = createAt5SigprocAux();
  sharedAux.mode3ToneCount[0] = toneCount;
  sharedAux.mode3ToneActiveFlags.set(toneActiveFlags);
  sharedAux.mode3ToneValues.set(toneValues);
  sharedAux.mode3FlipValues.set(flipValues);

  const channel0Idsf = Uint32Array.from({ length: 32 }, (_, index) => idsf0[index] ?? 0);
  const channel1Idsf = Uint32Array.from({ length: 32 }, (_, index) => idsf1[index] ?? 0);

  return {
    hdr: {
      idsfValues: Int32Array.from({ length: 32 }, (_, index) => hdrIdsf[index] ?? 0),
      mode3BandMask: new Uint16Array(32),
      mode3DeltaFlags: new Uint16Array(32),
    },
    blocks: [
      { bandLevels: Int32Array.from({ length: 32 }, () => level0) },
      { bandLevels: Int32Array.from({ length: 32 }, () => level1) },
    ],
    channels: [
      {
        sharedAux,
        idsf: { values: channel0Idsf },
        curBuf: { bandScales: Float32Array.from({ length: 32 }, () => scale0) },
      },
      {
        idsf: { values: channel1Idsf },
        curBuf: { bandScales: Float32Array.from({ length: 32 }, () => scale1) },
      },
    ],
    shared: {
      mapSegmentCount,
      stereoFlipPresence: { flags: new Uint32Array(Math.max(mapSegmentCount, 1)) },
    },
    quantizedSpectraByChannel: [
      new Float32Array(2048),
      Float32Array.from({ length: 2048 }, (_, i) => i + 1),
    ],
  };
}

test("at5ApplyMode3BandMaskAndFlipHintsAt5 preserves the tone-threshold mask path", () => {
  const fixture = createMode3Fixture({
    toneCount: 2,
    idsf0: Array(32).fill(5),
    idsf1: Array(32).fill(5),
    hdrIdsf: Array(32).fill(4),
    toneValues: [0, 1e6],
  });

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(8, 12)), [1, 1, 1, 1]);
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 preserves the active-tone mm-threshold mask path", () => {
  const fixture = createMode3Fixture({
    toneCount: 1,
    idsf0: Array(32).fill(10),
    idsf1: Array(32).fill(8),
    hdrIdsf: Array(32).fill(2),
    toneActiveFlags: [1],
  });

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(0, 8)), Array(8).fill(1));
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 preserves strong-band clearing on low-value tones", () => {
  const fixture = createMode3Fixture({
    toneCount: 1,
    idsf0: Array(32).fill(10),
    idsf1: Array(32).fill(10),
    hdrIdsf: Array(32).fill(2),
    level0: 7,
    toneActiveFlags: [1],
    toneValues: [40],
  });

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(0, 8)), Array(8).fill(0));
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 preserves current flip-hint sign handling", () => {
  const fixture = createMode3Fixture({
    mapSegmentCount: 1,
    idsf0: Array(32).fill(5),
    idsf1: Array(32).fill(5),
    toneValues: [-12],
    flipValues: [-12],
  });
  const before = Array.from(fixture.quantizedSpectraByChannel[1].slice(0, 64));

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.equal(fixture.shared.stereoFlipPresence.flags[0], 1);
  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(0, 8)), Array(8).fill(1));
  assert.deepEqual(Array.from(fixture.quantizedSpectraByChannel[1].slice(0, 64)), before);
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 equalizes one-step idsf gaps on masked ranges", () => {
  const fixture = createMode3Fixture({
    mapSegmentCount: 1,
    idsf0: Array(32).fill(5),
    idsf1: Array(32).fill(4),
    toneValues: [-12],
    flipValues: [0],
  });

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.equal(fixture.shared.stereoFlipPresence.flags[0], 1);
  assert.deepEqual(Array.from(fixture.channels[0].idsf.values.slice(0, 8)), Array(8).fill(4));
  assert.deepEqual(Array.from(fixture.channels[1].idsf.values.slice(0, 8)), Array(8).fill(4));
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 skips flip-driven idsf equalization when no flip flags are available", () => {
  const fixture = createMode3Fixture({
    mapSegmentCount: 1,
    idsf0: Array(32).fill(5),
    idsf1: Array(32).fill(4),
    toneValues: [-12],
    flipValues: [0],
  });
  delete fixture.shared.stereoFlipPresence;

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(0, 8)), Array(8).fill(1));
  assert.deepEqual(Array.from(fixture.channels[0].idsf.values.slice(0, 8)), Array(8).fill(5));
  assert.deepEqual(Array.from(fixture.channels[1].idsf.values.slice(0, 8)), Array(8).fill(4));
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 keeps high-tone idsf equalization without flip flag storage", () => {
  const fixture = createMode3Fixture({
    toneCount: 1,
    mapSegmentCount: 1,
    idsf0: Array(32).fill(5),
    idsf1: Array(32).fill(4),
    hdrIdsf: Array(32).fill(2),
    toneActiveFlags: [1],
    toneValues: [60],
  });
  delete fixture.shared.stereoFlipPresence;

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(0, 8)), Array(8).fill(1));
  assert.deepEqual(Array.from(fixture.channels[0].idsf.values.slice(0, 8)), Array(8).fill(4));
  assert.deepEqual(Array.from(fixture.channels[1].idsf.values.slice(0, 8)), Array(8).fill(4));
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 fills later non-tone records when flip gating stays open", () => {
  const fixture = createMode3Fixture({
    toneCount: 1,
    mapSegmentCount: 2,
    flipValues: [0, -10],
  });

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(8, 12)), [1, 1, 1, 1]);
});

test("at5ApplyMode3BandMaskAndFlipHintsAt5 fills later non-tone records without flip presence storage", () => {
  const fixture = createMode3Fixture({
    toneCount: 1,
    mapSegmentCount: 2,
    flipValues: [0, -10],
  });
  delete fixture.shared.stereoFlipPresence;

  at5ApplyMode3BandMaskAndFlipHintsAt5(
    fixture.hdr,
    fixture.blocks,
    fixture.channels,
    0,
    fixture.shared,
    fixture.quantizedSpectraByChannel
  );

  assert.deepEqual(Array.from(fixture.hdr.mode3BandMask.slice(8, 12)), [1, 1, 1, 1]);
});
