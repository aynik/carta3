import assert from "node:assert/strict";
import test from "node:test";

import {
  at5HcPackedSymbolCount,
  at5HcValueMask,
} from "../../../src/atrac3plus/bitstream/bitstream.js";
import * as unpack from "../../../src/atrac3plus/tables/unpack.js";

function collectDescriptors() {
  const descriptors = [];
  const seen = new Set();

  function visit(name, value) {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        visit(`${name}[${i}]`, value[i]);
      }
      return;
    }

    if (value.codes instanceof Uint8Array && value.lookup instanceof Uint8Array) {
      if (!seen.has(value)) {
        seen.add(value);
        descriptors.push({ name, desc: value });
      }
      return;
    }

    if (typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        visit(`${name}.${key}`, entry);
      }
    }
  }

  for (const [name, value] of Object.entries(unpack)) {
    if (name.startsWith("AT5_HC_")) {
      visit(name, value);
    }
  }

  return descriptors;
}

test("ATRAC3plus Huffman descriptors expose named metadata", () => {
  for (const { name, desc } of collectDescriptors()) {
    assert.equal("word3" in desc, false, `${name} should not expose dead packed metadata`);
    assert.equal("word4" in desc, false, `${name} should not expose packed control words`);
    assert.equal("word5" in desc, false, `${name} should not expose packed control words`);
    assert.equal(typeof desc.maxCodewordBits, "number", `${name} should expose maxCodewordBits`);
    assert.equal(typeof desc.coeffsPerSymbol, "number", `${name} should expose coeffsPerSymbol`);
    assert.equal(typeof desc.nonzeroChunkSize, "number", `${name} should expose nonzeroChunkSize`);
    assert.equal(
      typeof desc.usesSeparateSignBits,
      "number",
      `${name} should expose usesSeparateSignBits`
    );
    assert.equal(typeof desc.valueMask, "number", `${name} should expose valueMask`);
    assert.equal(
      desc.lookup.length,
      1 << desc.maxCodewordBits,
      `${name} lookup width should match maxCodewordBits`
    );
  }
});

test("ATRAC3plus packed spectra descriptors derive symbol counts from coeff groups", () => {
  const sampleCoeffCount = 64;

  for (const [index, desc] of unpack.AT5_HC_HCSPEC.entries()) {
    const groupSize = desc.coeffsPerSymbol >>> 0;
    assert.ok(
      [1, 2, 4].includes(groupSize),
      `AT5_HC_HCSPEC[${index}] should pack 1, 2, or 4 coeffs per symbol`
    );

    const expectedPackedCount = sampleCoeffCount / groupSize;
    assert.equal(
      at5HcPackedSymbolCount(desc, sampleCoeffCount),
      expectedPackedCount,
      `AT5_HC_HCSPEC[${index}] should derive packed symbol count from coeffsPerSymbol`
    );
  }
});

test("ATRAC3plus IDCT codebooks keep explicit wrap masks", () => {
  assert.deepEqual(
    unpack.AT5_HC_CT.map((desc) => at5HcValueMask(desc)),
    [3, 7, 7, 7]
  );
});
