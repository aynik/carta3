import assert from "node:assert/strict";
import test from "node:test";

import {
  gaincontrolAt3,
  gaincWindow,
  idofLngainAt3,
  lngainofIdAt3,
} from "../../../../src/atrac3/scx/gainc.js";
import {
  createAt3GainControlBlock,
  createAt3GainControlBlocks,
  getAt3GainControlMaxFirst,
  getAt3GainControlWords,
  setAt3GainControlCount,
  setAt3GainControlEntry,
} from "../../../../src/atrac3/scx/gainc-layout.js";

function createGaincSpecs() {
  return Array.from({ length: 4 }, () => new Int32Array(512));
}

function createGaincParams() {
  return createAt3GainControlBlocks(4);
}

test("gainc lookup helpers preserve current table mapping", () => {
  assert.equal(lngainofIdAt3(0), -4);
  assert.equal(lngainofIdAt3(1), -3);
  assert.equal(lngainofIdAt3(15), 11);
  assert.equal(lngainofIdAt3(16), -5);

  assert.equal(idofLngainAt3(-5), -1);
  assert.equal(idofLngainAt3(0), 4);
  assert.equal(idofLngainAt3(1), 5);
  assert.equal(idofLngainAt3(6), 10);
});

test("gaincWindow preserves current neutral and A-only interpolation behavior", () => {
  const neutralOut = new Float32Array(512);
  assert.equal(
    gaincWindow(512, createAt3GainControlBlock(), createAt3GainControlBlock(), neutralOut),
    0
  );
  assert.deepEqual(Array.from(neutralOut.slice(0, 8)), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(neutralOut.slice(504)), [1, 1, 1, 1, 1, 1, 1, 1]);

  const aOnly = createAt3GainControlBlock();
  setAt3GainControlCount(aOnly, 1);
  setAt3GainControlEntry(aOnly, 0, 0, 1);

  const out = new Float32Array(512);
  assert.equal(gaincWindow(512, aOnly, createAt3GainControlBlock(), out), 0);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [
      8, 6.1688432693481445, 4.756828308105469, 3.668016195297241, 2.8284270763397217,
      2.1810154914855957, 1.6817928552627563, 1.2968395948410034, 1, 1, 1, 1, 1, 1, 1, 1,
    ]
  );
});

test("gaincWindow preserves current B-only plateau behavior and invalid-id rejection", () => {
  const bOnly = createAt3GainControlBlock();
  setAt3GainControlCount(bOnly, 1);
  setAt3GainControlEntry(bOnly, 0, 0, 1);

  const out = new Float32Array(512);
  assert.equal(gaincWindow(512, createAt3GainControlBlock(), bOnly, out), 0);
  assert.deepEqual(Array.from(out.slice(0, 16)), [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
  assert.deepEqual(Array.from(out.slice(496)), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

  const invalid = createAt3GainControlBlock();
  setAt3GainControlCount(invalid, 1);
  setAt3GainControlEntry(invalid, 0, 0, 99);
  assert.equal(gaincWindow(512, invalid, createAt3GainControlBlock(), new Float32Array(512)), -1);
});

test("gaincontrolAt3 preserves current empty and invalid-destination behavior", () => {
  const zeroSpecs = createGaincSpecs();
  const zeroDst = createGaincParams();
  const zeroSrc = createGaincParams();

  assert.equal(gaincontrolAt3(zeroSpecs, zeroDst, zeroSrc), 0);
  assert.deepEqual(Array.from(getAt3GainControlWords(zeroDst[0])), Array(16).fill(0));
  assert.deepEqual(Array.from(getAt3GainControlWords(zeroSrc[0])), Array(16).fill(0));

  const invalidDst = createGaincParams();
  setAt3GainControlCount(invalidDst[0], 1);
  setAt3GainControlEntry(invalidDst[0], 0, 0, 99);
  assert.equal(gaincontrolAt3(createGaincSpecs(), invalidDst, createGaincParams()), -1);
});

test("gaincontrolAt3 preserves current step-up gain insertion behavior", () => {
  const specs = createGaincSpecs();
  for (let index = 256; index < 264; index += 1) {
    specs[0][index] = 20;
  }
  for (let index = 264; index < 272; index += 1) {
    specs[0][index] = 100;
  }

  const dst = createGaincParams();
  const src = createGaincParams();

  assert.equal(gaincontrolAt3(specs, dst, src), 0);
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[0])),
    [2, 0, 3, 0, 0, 0, 0, 0, 4, 2, 0, 0, 0, 0, 0, 0]
  );
  assert.equal(getAt3GainControlMaxFirst(src[0]), 100);
});

test("gaincontrolAt3 preserves the current strongest-seven upward candidate selection", () => {
  const specs = createGaincSpecs();
  const bandValues = [20, 31, 48, 73, 110, 166, 250, 376, 565];
  for (let band = 0; band < bandValues.length; band += 1) {
    const start = 256 + band * 8;
    for (let index = start; index < start + 8; index += 1) {
      specs[0][index] = bandValues[band];
    }
  }

  const dst = createGaincParams();
  const src = createGaincParams();

  assert.equal(gaincontrolAt3(specs, dst, src), 0);
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[0])),
    [7, 0, 1, 2, 3, 4, 5, 11, 6, 5, 4, 3, 2, 1, 0, 0]
  );
  assert.equal(getAt3GainControlMaxFirst(src[0]), 565);
});

test("gaincontrolAt3 preserves current equal-score upward tie breaking", () => {
  const specs = createGaincSpecs();
  const bandValues = [20, 40, 80, 160, 320, 640, 1280, 2560, 5120];
  for (let band = 0; band < bandValues.length; band += 1) {
    const start = 256 + band * 8;
    for (let index = start; index < start + 8; index += 1) {
      specs[0][index] = bandValues[band];
    }
  }

  const dst = createGaincParams();
  const src = createGaincParams();

  assert.equal(gaincontrolAt3(specs, dst, src), 0);
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[0])),
    [7, 0, 1, 2, 3, 4, 5, 11, 6, 5, 4, 3, 2, 1, 0, 0]
  );
  assert.equal(getAt3GainControlMaxFirst(src[0]), 5120);
});

test("gaincontrolAt3 preserves the current mixed upward and downward gain shaping", () => {
  const specs = createGaincSpecs();
  const bandValues = [20, 80, 160, 320, 320, 320, 320, 20];
  for (let band = 0; band < bandValues.length; band += 1) {
    const start = 256 + band * 8;
    for (let index = start; index < start + 8; index += 1) {
      specs[0][index] = bandValues[band];
    }
  }

  const dst = createGaincParams();
  const src = createGaincParams();

  assert.equal(gaincontrolAt3(specs, dst, src), 0);
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[0])),
    [4, 0, 1, 2, 7, 0, 0, 0, 4, 2, 1, 0, 0, 0, 0, 0]
  );
  assert.equal(getAt3GainControlMaxFirst(src[0]), 320);
});

test("gaincontrolAt3 preserves current repeat-gain insertion behavior", () => {
  const specs = createGaincSpecs();
  for (let index = 256; index < 264; index += 1) {
    specs[1][index] = 50;
  }
  for (let index = 264; index < 272; index += 1) {
    specs[1][index] = 400;
  }

  const dst = createGaincParams();
  const src = createGaincParams();

  assert.equal(gaincontrolAt3(specs, dst, src), 0);
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[0])),
    [1, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[1])),
    [2, 0, 3, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0, 0]
  );
});

test("gaincontrolAt3 preserves the repeat-gain empty-first-block gate", () => {
  const specs = createGaincSpecs();
  for (let index = 256; index < 264; index += 1) {
    specs[0][index] = 20;
    specs[1][index] = 50;
  }
  for (let index = 264; index < 272; index += 1) {
    specs[0][index] = 100;
    specs[1][index] = 400;
  }

  const dst = createGaincParams();
  const src = createGaincParams();

  assert.equal(gaincontrolAt3(specs, dst, src), 0);
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[0])),
    [2, 0, 3, 0, 0, 0, 0, 0, 4, 2, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(getAt3GainControlWords(src[1])),
    [2, 0, 3, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0, 0]
  );
});

test("gaincontrolAt3 preserves the repeat-gain peak-limit guard", () => {
  const specs = createGaincSpecs();
  for (let index = 256; index < 264; index += 1) {
    specs[0][index] = 20000;
  }
  for (let index = 264; index < 272; index += 1) {
    specs[0][index] = 30000;
  }

  const dst = createGaincParams();
  const src = createGaincParams();

  assert.equal(gaincontrolAt3(specs, dst, src), 0);
  assert.deepEqual(Array.from(getAt3GainControlWords(src[0])), Array(16).fill(0));
  assert.equal(getAt3GainControlMaxFirst(src[0]), 30000);
});
