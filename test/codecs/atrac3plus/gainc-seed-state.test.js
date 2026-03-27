import assert from "node:assert/strict";
import test from "node:test";

import { buildGainSeedState } from "../../../src/atrac3plus/gainc/set.js";

function createPreviousRecord(overrides = {}) {
  return {
    entries: 0,
    levels: new Uint32Array(7),
    attackSeedLimit: 0,
    ampScaledMax: 512,
    attackRoundDownCarry: 0,
    derivSeedLimit: 0,
    ...overrides,
  };
}

function createCurrentRecord(overrides = {}) {
  return {
    gainBase: 2,
    tlev: 0,
    minHi: 0,
    minAll: 0,
    derivMaxHi: 0,
    derivMaxAll: 0,
    ...overrides,
  };
}

test("buildGainSeedState clamps a fresh attack seed to the current low-half peak", () => {
  const prev = createPreviousRecord({
    attackSeedLimit: 20,
    attackRoundDownCarry: 3,
  });
  const cur = createCurrentRecord();
  const ampPairs = new Float32Array(0x24);
  const derivWindow = new Float32Array(0x64);

  ampPairs[5] = 10;
  ampPairs[20] = 16;

  const seed = buildGainSeedState(prev, cur, ampPairs, derivWindow, false, 1, 0x20);
  const { attack, gainScale } = seed;

  assert.equal(attack.sumBits, 0);
  assert.equal(attack.seedLimit, 10);
  assert.equal(attack.seedStart, 10);
  assert.equal(attack.roundDownCarry, 3);
  assert.equal(attack.budgetLimitBits, 7);
  assert.equal(attack.lowHalfPeak, 10);
  assert.equal(attack.highHalfPeak, 16);
  assert.equal(gainScale, 3);
  assert.equal(cur.minHi, 16);
  assert.equal(cur.minAll, 16);
});

test("buildGainSeedState preserves the previous attack start once a band already has entries", () => {
  const prev = createPreviousRecord({
    entries: 1,
    levels: Uint32Array.of(9),
    attackSeedLimit: 20,
  });
  const cur = createCurrentRecord();
  const ampPairs = new Float32Array(0x24);
  const derivWindow = new Float32Array(0x64);

  ampPairs[5] = 10;
  ampPairs[20] = 16;

  const seed = buildGainSeedState(prev, cur, ampPairs, derivWindow, false, 1, 0x20);
  const { attack } = seed;

  assert.equal(attack.sumBits, 3);
  assert.equal(attack.seedLimit, 10);
  assert.equal(attack.seedStart, 20);
});

test("buildGainSeedState preserves an existing lower attack seed limit below the current low-half peak", () => {
  const prev = createPreviousRecord({
    attackSeedLimit: 6,
  });
  const cur = createCurrentRecord();
  const ampPairs = new Float32Array(0x24);
  const derivWindow = new Float32Array(0x64);

  ampPairs[4] = 10;
  ampPairs[21] = 12;

  const seed = buildGainSeedState(prev, cur, ampPairs, derivWindow, false, 1, 0x20);
  const { attack } = seed;

  assert.equal(attack.seedLimit, 6);
  assert.equal(attack.seedStart, 6);
  assert.equal(cur.minHi, 12);
  assert.equal(cur.minAll, 12);
});

test("buildGainSeedState mirrors attack budget state into derivative seed planning", () => {
  const prev = createPreviousRecord({
    entries: 1,
    levels: Uint32Array.of(8),
    derivSeedLimit: 20,
  });
  const cur = createCurrentRecord();
  const ampPairs = new Float32Array(0x24);
  const derivWindow = new Float32Array(0x64);

  ampPairs[3] = 9;
  ampPairs[18] = 12;
  derivWindow[6] = 10;
  derivWindow[21] = 16;

  const seed = buildGainSeedState(prev, cur, ampPairs, derivWindow, true, 1, 0x20);
  const { attack, derivative } = seed;

  assert.ok(derivative);
  assert.equal(attack.sumBits, 2);
  assert.equal(derivative?.sumBits, 2);
  assert.equal(derivative?.budgetLimitBits, attack.budgetLimitBits);
  assert.equal(derivative?.seedLimit, 10);
  assert.equal(derivative?.seedStart, 20);
  assert.equal(derivative?.highHalfPeak, 16);
  assert.equal(cur.derivMaxHi, 16);
  assert.equal(cur.derivMaxAll, 16);
});

test("buildGainSeedState boosts band-0 gain scale only for low core modes with high enough tlev", () => {
  const prev = createPreviousRecord();
  const cur = createCurrentRecord({
    gainBase: 2,
    tlev: 10,
  });
  const ampPairs = new Float32Array(0x24);
  const derivWindow = new Float32Array(0x64);

  const boosted = buildGainSeedState(prev, cur, ampPairs, derivWindow, false, 0, 0x1a);
  const unboosted = buildGainSeedState(prev, cur, ampPairs, derivWindow, false, 0, 0x1b);

  assert.equal(boosted.gainScale, 4.5);
  assert.equal(unboosted.gainScale, 3);
});
