import assert from "node:assert/strict";
import test from "node:test";

import { at3encPrepareChannelProcWords } from "../../../../src/atrac3/frame-output.js";
import { at3encPackChannel } from "../../../../src/atrac3/frame-channel.js";
import { writeAtrac3SpectralPayload } from "../../../../src/atrac3/frame-channel-spectrum.js";
import {
  AT3ENC_PROC_ACTIVE_BANDS_WORD,
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_UNIT_COUNT_WORD,
  at3encAppendToneRegionRowTone,
  at3encProcBandSelectorWord,
  at3encProcToneRegionFlagWord,
  at3encProcToneRegionModeWord,
  at3encProcToneRegionSymMaxWord,
} from "../../../../src/atrac3/proc-layout.js";

function createPairBlock() {
  return {
    startIndex: new Uint32Array(8),
    gainIndex: new Uint32Array(8),
    scratchBits: new Uint32Array(32),
    maxBits: 0,
    lastMax: 0,
    entryCount: 0,
  };
}

function createPackState() {
  return {
    procWords: new Uint32Array(0x200),
    stateWords: 0x200,
    channelConversion: {
      slots: [{ modeHint: 1 }, { modeHint: 2 }, { modeHint: 3 }, { modeHint: 0 }],
      mixCode: { previous: 5 },
    },
    layers: [
      {
        shift: 100,
        referencesPrimaryShift: false,
        spectrum: new Float32Array(1024),
        tones: {
          blocks: Array.from({ length: 4 }, () => createPairBlock()),
          previousBlock0EntryCount: 0,
        },
      },
      {
        shift: 100,
        referencesPrimaryShift: true,
        spectrum: new Float32Array(1024),
        tones: {
          blocks: Array.from({ length: 4 }, () => createPairBlock()),
          previousBlock0EntryCount: 0,
        },
      },
    ],
  };
}

function createSpectralCase({ bandCount, modes, selectors, spectrumValues }) {
  const procWords = new Uint32Array(0x200);
  const spectrum = new Float32Array(1024);

  procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = bandCount;
  for (const [band, mode] of modes) {
    procWords[band] = mode;
  }
  for (const [band, selector] of selectors) {
    procWords[at3encProcBandSelectorWord(band)] = selector;
  }
  spectrum.set(spectrumValues);

  const out = new Uint8Array(16);
  const bitpos = writeAtrac3SpectralPayload(procWords, spectrum, out, 0);
  return { bitpos, out };
}

function setToneWord(procWords, toneWord, coeffs, start, idsf) {
  procWords.set([...coeffs, start, idsf], toneWord);
}

function setRegionRow(procWords, region, row, toneWords) {
  for (const toneWord of toneWords) {
    at3encAppendToneRegionRowTone(procWords, region, row, toneWord);
  }
}

test("at3encPackChannel preserves the current primary and converted channel prefixes", () => {
  const primaryState = createPackState();
  const primaryOut = new Uint8Array(64);
  at3encPrepareChannelProcWords(primaryState, primaryState.layers[0], {
    forceMinimalPayload: true,
  });
  const primaryBitpos = at3encPackChannel(primaryState, primaryState.layers[0], 0, primaryOut);

  assert.equal(primaryBitpos, 25);
  assert.deepEqual(Array.from(primaryOut.slice(0, 8)), [160, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(primaryState.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD], 1);
  assert.equal(primaryState.procWords[AT3ENC_PROC_UNIT_COUNT_WORD], 1);
  assert.equal(primaryState.procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD], 0);
  assert.equal(primaryState.layers[0].tones.blocks[0].entryCount, 0);

  const secondaryState = createPackState();
  const secondaryOut = new Uint8Array(64);
  at3encPrepareChannelProcWords(secondaryState, secondaryState.layers[1], {
    forceMinimalPayload: true,
  });
  const secondaryBitpos = at3encPackChannel(
    secondaryState,
    secondaryState.layers[1],
    4,
    secondaryOut
  );

  assert.equal(secondaryBitpos, 65);
  assert.deepEqual(Array.from(secondaryOut.slice(0, 12)), [0, 0, 0, 0, 86, 204, 0, 0, 0, 0, 0, 0]);
  assert.equal(secondaryOut[4], 0x56);
  assert.equal(secondaryOut[5], 0xcc);
});

test("at3encPackChannel keeps converted secondary prefix bytes split by authored fields", () => {
  const state = createPackState();
  state.procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 3;

  const out = new Uint8Array(16);
  const bitpos = at3encPackChannel(state, state.layers[1], 0, out);

  assert.equal(bitpos, 36);
  assert.equal(out[0], 0x56);
  assert.equal(out[1], 0xce);
});

test("at3encPackChannel preserves current paired and scalar coefficient packing", () => {
  const pairedState = createPackState();
  pairedState.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = 1;
  pairedState.procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  pairedState.procWords[0] = 1;
  pairedState.procWords[at3encProcBandSelectorWord(0)] = 0;
  pairedState.layers[0].tones.blocks[0].entryCount = 1;
  pairedState.layers[0].tones.blocks[0].startIndex[0] = 7;
  pairedState.layers[0].tones.blocks[0].gainIndex[0] = 3;
  pairedState.layers[0].spectrum.set([0, 1, 2, 3, 0, 1, 2, 3]);

  const pairedOut = new Uint8Array(64);
  const pairedBitpos = at3encPackChannel(pairedState, pairedState.layers[0], 0, pairedOut);

  assert.equal(pairedBitpos, 44);
  assert.deepEqual(
    Array.from(pairedOut.slice(0, 16)),
    [160, 38, 112, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );

  const scalarState = createPackState();
  scalarState.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = 1;
  scalarState.procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  scalarState.procWords[0] = 2;
  scalarState.procWords[at3encProcBandSelectorWord(0)] = 0;
  scalarState.layers[0].spectrum.set([0, 1, 2, 3, 4, 5, 6, 7]);

  const scalarOut = new Uint8Array(64);
  const scalarBitpos = at3encPackChannel(scalarState, scalarState.layers[0], 0, scalarOut);

  assert.equal(scalarBitpos, 39);
  assert.deepEqual(
    Array.from(scalarOut.slice(0, 16)),
    [160, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );

  const highModeState = createPackState();
  highModeState.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = 1;
  highModeState.procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  highModeState.procWords[0] = 6;
  highModeState.procWords[at3encProcBandSelectorWord(0)] = 0;
  highModeState.layers[0].spectrum.set([0, 1, 2, 3, 4, 5, 6, 7]);

  const highModeOut = new Uint8Array(64);
  const highModeBitpos = at3encPackChannel(highModeState, highModeState.layers[0], 0, highModeOut);

  assert.equal(highModeBitpos, 55);
  assert.deepEqual(
    Array.from(highModeOut.slice(0, 16)),
    [160, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("writeAtrac3SpectralPayload preserves paired and scalar coefficient routing", () => {
  const paired = createSpectralCase({
    bandCount: 1,
    modes: [[0, 1]],
    selectors: [[0, 0]],
    spectrumValues: [0, 1, 2, 3, 0, 1, 2, 3],
  });
  assert.equal(paired.bitpos, 19);
  assert.deepEqual(Array.from(paired.out.slice(0, 4)), [0, 128, 0, 0]);

  const scalar = createSpectralCase({
    bandCount: 1,
    modes: [[0, 2]],
    selectors: [[0, 0]],
    spectrumValues: [0, 1, 2, 3, 4, 5, 6, 7],
  });
  assert.equal(scalar.bitpos, 23);
  assert.deepEqual(Array.from(scalar.out.slice(0, 4)), [1, 0, 0, 0]);

  const high = createSpectralCase({
    bandCount: 1,
    modes: [[0, 6]],
    selectors: [[0, 0]],
    spectrumValues: [0, 1, 2, 3, 4, 5, 6, 7],
  });
  assert.equal(high.bitpos, 39);
  assert.deepEqual(Array.from(high.out.slice(0, 4)), [3, 0, 0, 0]);
});

test("writeAtrac3SpectralPayload preserves selector omission for inactive bands", () => {
  const { bitpos, out } = createSpectralCase({
    bandCount: 2,
    modes: [
      [0, 0],
      [1, 1],
    ],
    selectors: [
      [0, 15],
      [1, 0],
    ],
    spectrumValues: [0, 0, 0, 0, 0, 1, 2, 3, 0, 1, 2, 3],
  });

  assert.equal(bitpos, 22);
  assert.deepEqual(Array.from(out.slice(0, 4)), [8, 16, 0, 0]);
});

test("at3encPackChannel preserves current tone-region payload packing", () => {
  const state = createPackState();

  state.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = 1;
  state.procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  state.procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = 1;
  state.procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 1;
  state.procWords[at3encProcToneRegionFlagWord(0, 0)] = 1;
  state.procWords[at3encProcToneRegionModeWord(0)] = 3;
  state.procWords[at3encProcToneRegionSymMaxWord(0)] = 1;
  setToneWord(state.procWords, 0x150, [1, 2, 0, 0], 64, 9);
  setRegionRow(state.procWords, 0, 0, [0x150]);

  const out = new Uint8Array(64);
  const bitpos = at3encPackChannel(state, state.layers[0], 0, out);

  assert.equal(bitpos, 64);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [160, 1, 101, 146, 64, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("at3encPackChannel preserves current pass-1 tone-region table routing", () => {
  const state = createPackState();

  state.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = 1;
  state.procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  state.procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = 1;
  state.procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 1;
  state.procWords[at3encProcToneRegionFlagWord(0, 0)] = 1;
  state.procWords[at3encProcToneRegionModeWord(0)] = 5;
  state.procWords[at3encProcToneRegionSymMaxWord(0)] = 0;
  setToneWord(state.procWords, 0x150, [3, 0, 0, 0], 68, 11);
  setRegionRow(state.procWords, 0, 0, [0x150]);

  const out = new Uint8Array(64);
  const bitpos = at3encPackChannel(state, state.layers[0], 0, out);

  assert.equal(bitpos, 62);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [160, 1, 98, 146, 196, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("at3encPackChannel preserves current multi-unit region ordering and null-table skipping", () => {
  const state = createPackState();

  state.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = 1;
  state.procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 2;
  state.procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = 0;
  state.procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 2;
  state.procWords[at3encProcToneRegionFlagWord(0, 0)] = 1;
  state.procWords[at3encProcToneRegionFlagWord(0, 1)] = 1;
  state.procWords[at3encProcToneRegionModeWord(0)] = 3;
  state.procWords[at3encProcToneRegionSymMaxWord(0)] = 0;
  state.procWords[at3encProcToneRegionFlagWord(1, 0)] = 1;
  state.procWords[at3encProcToneRegionFlagWord(1, 1)] = 0;

  setToneWord(state.procWords, 0x150, [3, 0, 0, 0], 68, 11);
  setRegionRow(state.procWords, 0, 0, [state.procWords.length]);
  setRegionRow(state.procWords, 0, 4, [0x150]);
  setRegionRow(state.procWords, 1, 0, [0x150]);

  const out = new Uint8Array(64);
  const bitpos = at3encPackChannel(state, state.layers[0], 0, out);

  assert.equal(bitpos, 86);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [161, 0, 70, 25, 0, 18, 196, 224, 4, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("at3encPackChannel preserves current invalid input contracts", () => {
  const state = createPackState();
  assert.throws(() => at3encPrepareChannelProcWords(state, 0), /layer must be a layer object/);
  assert.throws(
    () => at3encPackChannel(state, state.layers[0], 0, null),
    /out must be a Uint8Array/
  );
  assert.throws(
    () => at3encPackChannel({ ...state, procWords: null }, state.layers[0], 0, new Uint8Array(8)),
    /state\.procWords must be a Uint32Array/
  );
  assert.throws(
    () =>
      at3encPackChannel(
        state,
        { ...state.layers[0], tones: { ...state.layers[0].tones, blocks: [] } },
        0,
        new Uint8Array(8)
      ),
    /layer\.tones\.blocks must contain 4 tone blocks/
  );
  assert.throws(
    () =>
      at3encPackChannel(
        state,
        { ...state.layers[0], spectrum: new Uint8Array(8) },
        0,
        new Uint8Array(8)
      ),
    /layer\.spectrum must be a Float32Array/
  );
});

test("at3encPrepareChannelProcWords preserves the current low-shift minimal payload path", () => {
  const state = createPackState();
  state.layers[0].shift = 0x27;

  at3encPrepareChannelProcWords(state, state.layers[0]);

  assert.equal(state.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD], 1);
  assert.equal(state.procWords[AT3ENC_PROC_UNIT_COUNT_WORD], 1);
  assert.equal(state.procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD], 0);
  assert.equal(state.layers[0].tones.blocks[0].entryCount, 0);
});

test("at3encPrepareChannelProcWords preserves the explicit minimal payload override", () => {
  const state = createPackState();

  at3encPrepareChannelProcWords(state, state.layers[0], { forceMinimalPayload: true });

  assert.equal(state.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD], 1);
  assert.equal(state.procWords[AT3ENC_PROC_UNIT_COUNT_WORD], 1);
  assert.equal(state.procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD], 0);
  assert.equal(state.layers[0].tones.blocks[0].entryCount, 0);
});

test("at3encPrepareChannelProcWords preserves the legacy fallback alias for minimal payloads", () => {
  const state = createPackState();

  at3encPrepareChannelProcWords(state, state.layers[0], { forceFallback: true });

  assert.equal(state.procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD], 1);
  assert.equal(state.procWords[AT3ENC_PROC_UNIT_COUNT_WORD], 1);
  assert.equal(state.procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD], 0);
  assert.equal(state.layers[0].tones.blocks[0].entryCount, 0);
});
