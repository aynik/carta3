import assert from "node:assert/strict";
import test from "node:test";

import {
  addSpcNoiseBand,
  computeSpcBandNoiseScale,
  computeSpcNoiseBaseScale,
} from "../../../src/atrac3plus/spc.js";
import {
  AT5_IFQF,
  AT5_LNGAIN,
  AT5_RNDTBL,
  AT5_SFTBL,
} from "../../../src/atrac3plus/tables/decode.js";

function createGainBlock(segmentGainSel) {
  return {
    segmentCount: segmentGainSel.length,
    segmentGainSel: Int32Array.from(segmentGainSel),
  };
}

test("computeSpcNoiseBaseScale preserves current and previous gain compensation", () => {
  const current = createGainBlock([3, 5]);
  const previous = createGainBlock([2, 4]);
  const spclev = 6.5;

  const baseGain = -(AT5_LNGAIN[3] | 0);
  const expectedBest = Math.max(
    -(AT5_LNGAIN[2] | 0) + baseGain,
    -(AT5_LNGAIN[4] | 0) + baseGain,
    -(AT5_LNGAIN[3] | 0),
    -(AT5_LNGAIN[5] | 0),
    0
  );

  assert.equal(
    computeSpcNoiseBaseScale(current, previous, spclev),
    spclev / (1 << (expectedBest & 31))
  );
});

test("computeSpcBandNoiseScale preserves the per-band quantized scale", () => {
  const baseScale = 7.25;
  const idsfValue = 19;
  const quantShift = 4;

  assert.equal(
    computeSpcBandNoiseScale(baseScale, idsfValue, quantShift),
    (baseScale * AT5_SFTBL[idsfValue] * AT5_IFQF[quantShift]) / (1 << (quantShift & 31))
  );
});

test("addSpcNoiseBand preserves the seeded random sequence within a band", () => {
  const spectra = new Float32Array(8);

  addSpcNoiseBand(spectra, 2, 5, 3, 0x3ff);

  const expected = new Float32Array(8);
  for (let sampleIndex = 2; sampleIndex < 5; sampleIndex += 1) {
    const offset = sampleIndex - 2;
    const tableIndex = (0x3ff + offset) & 0x3ff;
    expected[sampleIndex] = 3 * (AT5_RNDTBL[tableIndex] | 0) * (1 / 32768);
  }

  assert.deepEqual(Array.from(spectra), Array.from(expected));
});
