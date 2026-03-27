import assert from "node:assert/strict";
import test from "node:test";

import {
  getSolveScratchState,
  getSpcLevelScratchState,
} from "../../../src/atrac3plus/channel-block/internal.js";

test("channel-block scratch accessors reuse valid buffers and repair invalid shapes", () => {
  const bandScores = new Int32Array(64);
  const bandAllowed = [new Int32Array(32), new Int32Array(32)];
  const seedByMapIndex = new Uint16Array(32);
  const hdr = {
    scratch: {
      channelBlock: {
        latePriority: {
          bandScores,
          orderedBandSlots: new Int32Array(1),
          stereoScores: new Int32Array(32),
          stereoBandsByPriority: new Int32Array(32),
          stereoBandCount: 0,
        },
        spcLevelEnabledByChannel: new Int32Array(2),
        raiseAllowedByChannel: bandAllowed,
        spcLevels: {
          seedByMapIndex,
          slotPwcRatioSum: new Float32Array(8),
          slotBandLevelSum: new Float32Array(8),
          slotWeightSum: new Uint32Array(8),
          primaryBandScratch: new Float32Array(64),
          secondaryBandScratch: new Float32Array(1),
          randomScratch: new Float32Array(128),
        },
        coefficientPruning: {
          sortedMagnitudes: new Float32Array(1),
          sortedIndices: new Int32Array(1),
          acceptedBandSnapshot: new Float32Array(1),
        },
      },
    },
  };

  const solveScratch = getSolveScratchState(hdr);
  const spcScratch = getSpcLevelScratchState(hdr);

  assert.equal(solveScratch.latePriority.bandScores, bandScores);
  assert.notEqual(solveScratch.latePriority.orderedBandSlots.length, 1);
  assert.equal(solveScratch.latePriority.stereoScores.length, 32);
  assert.equal(solveScratch.latePriority.stereoBandsByPriority.length, 32);
  assert.equal(solveScratch.spcLevelEnabledByChannel.length, 2);
  assert.equal(solveScratch.raiseAllowedByChannel, bandAllowed);
  assert.equal(spcScratch.seedByMapIndex, seedByMapIndex);
  assert.equal(spcScratch.slotPwcRatioSum.length, 8);
  assert.equal(spcScratch.slotBandLevelSum.length, 8);
  assert.equal(spcScratch.slotWeightSum.length, 8);
  assert.equal(spcScratch.primaryBandScratch.length, 128);
  assert.equal(spcScratch.secondaryBandScratch.length, 128);
  assert.equal(spcScratch.randomScratch.length, 128);
  assert.deepEqual(spcScratch.cachedSeedBand, { value: -1 });
  assert.equal(solveScratch.coefficientPruning.sortedMagnitudes.length, 0x100);
  assert.equal(solveScratch.coefficientPruning.sortedIndices.length, 0x100);
  assert.equal(solveScratch.coefficientPruning.acceptedBandSnapshot.length, 0x100);
});
