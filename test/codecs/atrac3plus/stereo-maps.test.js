import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStereoMapTransforms,
  resolveStereoMapSourceChannelIndex,
} from "../../../src/atrac3plus/stereo-maps.js";

test("resolveStereoMapSourceChannelIndex follows per-map stereo swaps", () => {
  const shared = {
    stereoSwapPresence: {
      flags: Uint32Array.from([0, 1, 0, 0]),
    },
  };

  assert.equal(resolveStereoMapSourceChannelIndex(1, shared, 0, 1), 0);
  assert.equal(resolveStereoMapSourceChannelIndex(2, shared, 0, 0), 0);
  assert.equal(resolveStereoMapSourceChannelIndex(2, shared, 0, 1), 1);
  assert.equal(resolveStereoMapSourceChannelIndex(2, shared, 1, 1), 0);
});

test("applyStereoMapTransforms preserves swap-before-flip ordering within a map", () => {
  const leftSpectra = new Float32Array(2048);
  const rightSpectra = new Float32Array(2048);

  leftSpectra.fill(10, 0, 128);
  rightSpectra.fill(20, 0, 128);
  leftSpectra.fill(30, 128, 256);
  rightSpectra.fill(40, 128, 256);

  applyStereoMapTransforms(
    leftSpectra,
    rightSpectra,
    {
      stereoSwapPresence: { flags: Uint32Array.from([1, 0]) },
      stereoFlipPresence: { flags: Uint32Array.from([1, 1]) },
    },
    2
  );

  assert.deepEqual(Array.from(leftSpectra.slice(0, 128)), Array(128).fill(20));
  assert.deepEqual(Array.from(rightSpectra.slice(0, 128)), Array(128).fill(-10));
  assert.deepEqual(Array.from(leftSpectra.slice(128, 256)), Array(128).fill(30));
  assert.deepEqual(Array.from(rightSpectra.slice(128, 256)), Array(128).fill(-40));
  assert.deepEqual(Array.from(leftSpectra.slice(256)), Array(1792).fill(0));
  assert.deepEqual(Array.from(rightSpectra.slice(256)), Array(1792).fill(0));
});
