import assert from "node:assert/strict";
import test from "node:test";

import { createAtrac3EncoderState } from "../../../../src/atrac3/encode-runtime.js";
import { at3encProcessLayerTransform } from "../../../../src/atrac3/transform.js";

function runTransformCase(spectrumValues = []) {
  const handle = createAtrac3EncoderState(1, 105);
  const layer = handle.state.layers[0];

  for (const [index, value] of spectrumValues) {
    layer.spectrum[index] = value;
  }

  const debugStages = {};
  at3encProcessLayerTransform(handle.state, layer, new Float32Array(1024), debugStages);
  return { layer, debugStages };
}

function fillSpectrumRange(layer, start, end, value) {
  for (let index = start; index < end; index += 1) {
    layer.spectrum[index] = value;
  }
}

function summarizeToneBlocks(layer) {
  return layer.tones.blocks.map((block) => ({
    entryCount: block.entryCount,
    startIndex: Array.from(block.startIndex.slice(0, 8)),
    gainIndex: Array.from(block.gainIndex.slice(0, 8)),
    maxBits: block.maxBits,
    lastMax: block.lastMax,
    scratchBits: Array.from(block.scratchBits.slice(0, 8)),
  }));
}

test("at3encProcessLayerTransform preserves the zero-spectrum neutral tone-block state", () => {
  const { layer, debugStages } = runTransformCase();

  assert.deepEqual(
    summarizeToneBlocks(layer),
    Array.from({ length: 4 }, () => ({
      entryCount: 0,
      startIndex: [0, 0, 0, 0, 0, 0, 0, 32],
      gainIndex: [4, 0, 0, 0, 0, 0, 0, 0],
      maxBits: 1351317279,
      lastMax: 0,
      scratchBits: [0, 0, 0, 0, 0, 0, 0, 0],
    }))
  );
  assert.equal(layer.tones.previousBlock0EntryCount, 0);
  assert.deepEqual(Array.from(layer.spectrum.slice(0, 16)), new Array(16).fill(0));
  assert.deepEqual(Array.from(layer.workspace.transform.slice(0, 16)), new Array(16).fill(0));
  assert.deepEqual(Array.from(debugStages.buf1000Before.slice(0, 16)), new Array(16).fill(0));
});

test("at3encProcessLayerTransform uses state scratch when fftStorage is omitted", () => {
  const handle = createAtrac3EncoderState(1, 105);
  const layer = handle.state.layers[0];

  const fftStorage = new Float32Array(1024);
  fftStorage.fill(Number.NaN);
  handle.state.scratch.fft = fftStorage;

  at3encProcessLayerTransform(handle.state, layer);

  assert.equal(handle.state.scratch.fft, fftStorage);
  assert.equal(Number.isNaN(fftStorage[0]), false);
});

test("at3encProcessLayerTransform preserves current maxmag lane mapping for sparse spikes", () => {
  const { layer, debugStages } = runTransformCase([
    [0, 1],
    [1, -0.5],
    [64, 0.75],
    [65, -0.25],
  ]);

  assert.deepEqual(Array.from(layer.workspace.transform.slice(0, 8)), [1, -0.5, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(debugStages.buf1000Before.slice(0, 8)), new Array(8).fill(0));
  assert.deepEqual(summarizeToneBlocks(layer), [
    {
      entryCount: 0,
      startIndex: [0, 0, 0, 0, 0, 0, 0, 32],
      gainIndex: [4, 0, 0, 0, 0, 0, 0, 0],
      maxBits: 1351317279,
      lastMax: 0,
      scratchBits: [1065353216, 0, 1061158912, 0, 0, 0, 0, 0],
    },
    {
      entryCount: 0,
      startIndex: [0, 0, 0, 0, 0, 0, 0, 32],
      gainIndex: [4, 0, 0, 0, 0, 0, 0, 0],
      maxBits: 1351317279,
      lastMax: 0,
      scratchBits: [1056964608, 0, 1048576000, 0, 0, 0, 0, 0],
    },
    {
      entryCount: 0,
      startIndex: [0, 0, 0, 0, 0, 0, 0, 32],
      gainIndex: [4, 0, 0, 0, 0, 0, 0, 0],
      maxBits: 1351317279,
      lastMax: 0,
      scratchBits: [0, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      entryCount: 0,
      startIndex: [0, 0, 0, 0, 0, 0, 0, 32],
      gainIndex: [4, 0, 0, 0, 0, 0, 0, 0],
      maxBits: 1351317279,
      lastMax: 0,
      scratchBits: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  ]);
  assert.deepEqual(Array.from(layer.spectrum.slice(0, 16)), new Array(16).fill(0));
  assert.deepEqual(Array.from(layer.spectrum.slice(64, 80)), new Array(16).fill(0));
});

test("at3encProcessLayerTransform carries the previous tail peak into the next frame history", () => {
  const handle = createAtrac3EncoderState(1, 105);
  const layer = handle.state.layers[0];

  layer.spectrum[1020] = 1000;
  at3encProcessLayerTransform(handle.state, layer, new Float32Array(1024));

  assert.equal(layer.tones.blocks[0].lastMax, 0);

  layer.spectrum.fill(0);
  at3encProcessLayerTransform(handle.state, layer, new Float32Array(1024));

  assert.deepEqual(
    layer.tones.blocks.map((block) => ({
      lastMax: block.lastMax,
      scratchTail: Array.from(block.scratchBits.slice(28, 32)),
    })),
    [
      { lastMax: 1000, scratchTail: [0, 0, 0, 0] },
      { lastMax: 0, scratchTail: [0, 0, 0, 0] },
      { lastMax: 0, scratchTail: [0, 0, 0, 0] },
      { lastMax: 0, scratchTail: [0, 0, 0, 0] },
    ]
  );
});

test("at3encProcessLayerTransform preserves cross-boundary attack planning after a carried tail peak", () => {
  const handle = createAtrac3EncoderState(1, 105);
  const layer = handle.state.layers[0];

  layer.spectrum[125] = 3e38;
  at3encProcessLayerTransform(handle.state, layer, new Float32Array(1024));

  layer.spectrum.fill(0);
  layer.spectrum[1] = 1e4;
  layer.spectrum[5] = 1e4;
  at3encProcessLayerTransform(handle.state, layer, new Float32Array(1024));

  assert.deepEqual(
    layer.tones.blocks.map((block) => ({
      entryCount: block.entryCount,
      startIndex: Array.from(block.startIndex.slice(0, 4)),
      gainIndex: Array.from(block.gainIndex.slice(0, 4)),
    })),
    [
      { entryCount: 1, startIndex: [2, 0, 0, 0], gainIndex: [5, 4, 0, 0] },
      { entryCount: 2, startIndex: [2, 4, 0, 0], gainIndex: [15, 0, 4, 0] },
      { entryCount: 0, startIndex: [0, 0, 0, 0], gainIndex: [4, 0, 0, 0] },
      { entryCount: 0, startIndex: [0, 0, 0, 0], gainIndex: [4, 0, 0, 0] },
    ]
  );
});

test("at3encProcessLayerTransform preserves gain-transition rows before the FFT stage", () => {
  const handle = createAtrac3EncoderState(2, 66);
  const layer = handle.state.layers[0];

  fillSpectrumRange(layer, 0, 128, 3e38);
  fillSpectrumRange(layer, 128, 160, 1);
  at3encProcessLayerTransform(handle.state, layer, new Float32Array(1024));

  layer.spectrum.fill(0);
  fillSpectrumRange(layer, 0, 128, 1e20);
  const debugStages = {};
  at3encProcessLayerTransform(handle.state, layer, new Float32Array(1024), debugStages);

  assert.deepEqual(
    layer.tones.blocks.map((block) => ({
      entryCount: block.entryCount,
      start0: block.startIndex[0],
      gain0: block.gainIndex[0],
      gain1: block.gainIndex[1],
      maxBits: block.maxBits,
    })),
    Array.from({ length: 4 }, () => ({
      entryCount: 1,
      start0: 4,
      gain0: 0,
      gain1: 4,
      maxBits: 2137108966,
    }))
  );
  assert.equal(debugStages.buf1000Before[0], 1.8750000034360973e37);
  assert.equal(debugStages.buf1000Before[124], 1.8750000034360973e37);
  assert.deepEqual(
    Array.from(debugStages.buf1000Before.slice(128, 160)),
    [
      0.0625, 0.0625, 0.0625, 0.0625, 0.0883883461356163, 0.0883883461356163, 0.0883883461356163,
      0.0883883461356163, 0.125, 0.125, 0.125, 0.125, 0.1767766922712326, 0.1767766922712326,
      0.1767766922712326, 0.1767766922712326, 0.25, 0.25, 0.25, 0.25, 0.3535533845424652,
      0.3535533845424652, 0.3535533845424652, 0.3535533845424652, 0.5, 0.5, 0.5, 0.5,
      0.7071067690849304, 0.7071067690849304, 0.7071067690849304, 0.7071067690849304,
    ]
  );
});

test("at3encProcessLayerTransform preserves block-0 follower fallback from block 1", () => {
  const spectrumValues = Array.from({ length: 32 }, (_, index) => [index * 4 + 1, 1e20]);
  const { layer } = runTransformCase(spectrumValues);

  assert.deepEqual(
    layer.tones.blocks.map((block) => ({
      entryCount: block.entryCount,
      start0: block.startIndex[0],
      gain0: block.gainIndex[0],
      gain1: block.gainIndex[1],
      maxBits: block.maxBits,
    })),
    [
      { entryCount: 1, start0: 31, gain0: 5, gain1: 4, maxBits: 1351317279 },
      { entryCount: 1, start0: 31, gain0: 15, gain1: 4, maxBits: 1351317279 },
      { entryCount: 0, start0: 0, gain0: 4, gain1: 0, maxBits: 1351317279 },
      { entryCount: 0, start0: 0, gain0: 4, gain1: 0, maxBits: 1351317279 },
    ]
  );
});
