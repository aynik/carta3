import assert from "node:assert/strict";
import test from "node:test";

import {
  AT3_CHCONV_MODE_BALANCED,
  selectChannelConversion,
} from "../../../../src/atrac3/channel-conversion-analysis.js";
import { at3encApplyChannelConversion } from "../../../../src/atrac3/channel-conversion-apply.js";
import { dbaMainSub } from "../../../../src/atrac3/channel-rebalance.js";
import { createAtrac3EncoderState } from "../../../../src/atrac3/encode-runtime.js";
import { encodeAtrac3Algorithm0Frame } from "../../../../src/atrac3/frame.js";
import { packAtrac3Algorithm0FrameOutput } from "../../../../src/atrac3/frame-output.js";
import {
  at3encPackBitsU16,
  at3encPackTableU16,
  at3encQuantIdxF32,
} from "../../../../src/atrac3/frame-channel-pack.js";
import { writeAtrac3ToneRegionSideband } from "../../../../src/atrac3/frame-channel-tone.js";
import { AT3ENC_PROC_TABLE_1, AT3_SFB_OFFSETS } from "../../../../src/atrac3/encode-tables.js";
import {
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_UNIT_COUNT_WORD,
  at3encAppendToneRegionRowTone,
  at3encProcToneRegionFlagWord,
  at3encProcToneRegionModeWord,
  at3encProcToneRegionSymMaxWord,
} from "../../../../src/atrac3/proc-layout.js";

function createSilentPcmLayers() {
  return [new Float32Array(1024), new Float32Array(1024)];
}

function prepareSwappedTailState(state) {
  selectChannelConversion(
    state.channelConversion,
    state.primaryLayer.spectrum,
    state.secondaryLayer.spectrum
  );
  at3encApplyChannelConversion(state);
}

function createDbaState({
  primaryLevel = 0,
  secondaryLevel = 0,
  primarySfbLimit = 4,
  secondarySfbLimit = 4,
  mode = AT3_CHCONV_MODE_BALANCED,
  bytesPerLayer = 96,
  basePrimaryShift = 32,
} = {}) {
  const primarySpectrum = new Float32Array(1024);
  const secondarySpectrum = new Float32Array(1024);
  primarySpectrum.fill(primaryLevel, 0, AT3_SFB_OFFSETS[primarySfbLimit]);
  secondarySpectrum.fill(secondaryLevel, 0, AT3_SFB_OFFSETS[secondarySfbLimit]);
  const primaryLayer = { spectrum: primarySpectrum, sfbLimit: primarySfbLimit, shift: 0 };
  const secondaryLayer = { spectrum: secondarySpectrum, sfbLimit: secondarySfbLimit };

  return {
    bytesPerLayer,
    basePrimaryShift,
    primaryShiftTarget: bytesPerLayer * 16 - 59,
    channelConversion: {
      slots: [{ modeHint: mode }, { modeHint: 0 }, { modeHint: 0 }, { modeHint: 0 }],
    },
    primaryLayer,
    secondaryLayer,
    layers: [primaryLayer, secondaryLayer],
  };
}

function fillBand(spectrum, band, value) {
  spectrum.fill(value, AT3_SFB_OFFSETS[band], AT3_SFB_OFFSETS[band + 1]);
}

function setToneWord(procWords, toneWord, coeffs, start, idsf) {
  procWords.set([...coeffs, start, idsf], toneWord);
}

function setRegionRow(procWords, region, row, toneWords) {
  for (const toneWord of toneWords) {
    at3encAppendToneRegionRowTone(procWords, region, row, toneWord);
  }
}

test("encodeAtrac3Algorithm0Frame preserves reversed secondary transport for 66 kbps stereo", () => {
  const handle = createAtrac3EncoderState(2, 66);
  const out = new Uint8Array(handle.frameBytes);
  const frame = encodeAtrac3Algorithm0Frame(createSilentPcmLayers(), handle.state, out);

  assert.equal(frame, out);
  assert.deepEqual(Array.from(frame.slice(0, 4)), [160, 2, 78, 159]);
  assert.deepEqual(Array.from(frame.slice(-5)), [159, 78, 2, 252, 255]);
  assert.equal(handle.state.primaryLayer.shift, 1477);
  assert.equal(handle.state.secondaryLayer.shift, 1461);
});

test("encodeAtrac3Algorithm0Frame preserves direct secondary packing for 105 kbps stereo", () => {
  const handle = createAtrac3EncoderState(1, 105);
  const out = new Uint8Array(handle.frameBytes);
  const frame = encodeAtrac3Algorithm0Frame(createSilentPcmLayers(), handle.state, out);

  assert.equal(frame, out);
  assert.deepEqual(Array.from(frame.slice(0, 4)), [160, 2, 78, 159]);
  assert.deepEqual(Array.from(frame.slice(-8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(handle.state.primaryLayer.shift, 1197);
  assert.equal(handle.state.secondaryLayer.shift, 1197);
});

test("encodeAtrac3Algorithm0Frame rejects runtime states that lose the fixed two-layer layout", () => {
  const handle = createAtrac3EncoderState(2, 66);
  handle.state.secondaryLayer = null;

  assert.throws(
    () => encodeAtrac3Algorithm0Frame(createSilentPcmLayers(), handle.state),
    /state must provide the ATRAC3 primaryLayer and secondaryLayer/
  );
});

test("encodeAtrac3Algorithm0Frame preserves per-layer PCM validation", () => {
  const handle = createAtrac3EncoderState(2, 66);
  const pcmLayers = createSilentPcmLayers();
  pcmLayers[1] = new Float32Array(128);

  assert.throws(
    () => encodeAtrac3Algorithm0Frame(pcmLayers, handle.state),
    /pcmLayers\[1\] must be a Float32Array with at least 1024 samples/
  );
});

test("packAtrac3Algorithm0FrameOutput preserves reversed secondary transport for 66 kbps stereo", () => {
  const handle = createAtrac3EncoderState(2, 66);
  prepareSwappedTailState(handle.state);

  const out = new Uint8Array(handle.frameBytes);
  const frame = packAtrac3Algorithm0FrameOutput(handle.state, out);

  assert.equal(frame, out);
  assert.deepEqual(Array.from(frame.slice(0, 4)), [160, 2, 78, 159]);
  assert.deepEqual(Array.from(frame.slice(-5)), [159, 78, 2, 252, 255]);
  assert.equal(handle.state.primaryLayer.shift, 1133);
  assert.equal(handle.state.secondaryLayer.shift, 1461);
});

test("packAtrac3Algorithm0FrameOutput preserves direct secondary packing for 105 kbps stereo", () => {
  const handle = createAtrac3EncoderState(1, 105);
  const out = new Uint8Array(handle.frameBytes);
  const frame = packAtrac3Algorithm0FrameOutput(handle.state, out);

  assert.equal(frame, out);
  assert.deepEqual(Array.from(frame.slice(0, 4)), [160, 2, 78, 159]);
  assert.deepEqual(Array.from(frame.slice(-8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(handle.state.primaryLayer.shift, 1197);
  assert.equal(handle.state.secondaryLayer.shift, 1197);
});

test("packAtrac3Algorithm0FrameOutput validates frame output capacity", () => {
  const handle = createAtrac3EncoderState(2, 66);

  assert.throws(
    () => packAtrac3Algorithm0FrameOutput(handle.state, new Uint8Array(handle.frameBytes - 1)),
    /out must be a Uint8Array with at least 192 bytes/
  );
});

test("dbaMainSub preserves the low-secondary-energy target shift fallback", () => {
  const state = createDbaState();

  dbaMainSub(state);

  assert.equal(state.primaryLayer.shift, 1477);
});

test("dbaMainSub preserves the non-mode3 alternate quiet-secondary fallback", () => {
  const state = createDbaState({
    secondaryLevel: 0.1,
    mode: 2,
    secondarySfbLimit: 1,
  });

  dbaMainSub(state);

  assert.equal(state.primaryLayer.shift, 1477);
});

test("dbaMainSub preserves current interpolation-only and non-mode bypass behavior", () => {
  const adjusted = createDbaState({
    primaryLevel: 100,
    secondaryLevel: 1,
    mode: AT3_CHCONV_MODE_BALANCED,
  });
  dbaMainSub(adjusted, { interpolationOnly: true });
  assert.equal(adjusted.primaryLayer.shift, 168);

  const bypassed = createDbaState({
    primaryLevel: 100,
    secondaryLevel: 1,
    mode: 2,
  });
  dbaMainSub(bypassed, { interpolationOnly: true });
  assert.equal(bypassed.primaryLayer.shift, 32);
});

test("dbaMainSub preserves current full-edge and fractional shift adjustments", () => {
  const edgeAdjusted = createDbaState({
    primaryLevel: 5,
    secondaryLevel: 0.1,
    mode: AT3_CHCONV_MODE_BALANCED,
  });
  dbaMainSub(edgeAdjusted);
  assert.equal(edgeAdjusted.primaryLayer.shift, 1472);

  const fractionalAdjusted = createDbaState({
    primaryLevel: 40,
    secondaryLevel: 5,
    mode: AT3_CHCONV_MODE_BALANCED,
  });
  dbaMainSub(fractionalAdjusted);
  assert.equal(fractionalAdjusted.primaryLayer.shift, 568);
});

test("dbaMainSub preserves the current mode-3 partial adjustment fallback", () => {
  const state = createDbaState({
    primaryLevel: 60,
    secondaryLevel: 20,
    mode: AT3_CHCONV_MODE_BALANCED,
  });

  dbaMainSub(state);

  assert.equal(state.primaryLayer.shift, 80);
});

test("dbaMainSub preserves the invalid-primary balanced full-edge fallback", () => {
  const state = createDbaState({
    secondaryLevel: 0.1,
    mode: AT3_CHCONV_MODE_BALANCED,
  });
  state.primaryLayer.spectrum[0] = Number.NaN;

  dbaMainSub(state);

  assert.equal(state.primaryLayer.shift, 1472);
});

test("dbaMainSub preserves current non-mode3 edge adjustment behavior", () => {
  const state = createDbaState({
    primaryLevel: 20,
    secondaryLevel: 0.5,
    mode: 2,
  });

  dbaMainSub(state);

  assert.equal(state.primaryLayer.shift, 840);
});

test("dbaMainSub caps primary headroom analysis at scale-factor band 18", () => {
  const band18State = createDbaState({
    primaryLevel: 0,
    secondaryLevel: 5,
    primarySfbLimit: 32,
    secondarySfbLimit: 1,
  });
  fillBand(band18State.primaryLayer.spectrum, 18, 100);
  dbaMainSub(band18State);
  assert.equal(band18State.primaryLayer.shift, 1472);

  const band19State = createDbaState({
    primaryLevel: 0,
    secondaryLevel: 5,
    primarySfbLimit: 32,
    secondarySfbLimit: 1,
  });
  fillBand(band19State.primaryLayer.spectrum, 19, 100);
  dbaMainSub(band19State);
  assert.equal(band19State.primaryLayer.shift, 32);
});

test("ATRAC3 pack-bit helpers preserve current bitfield writes across byte boundaries", () => {
  const alignedOut = new Uint8Array(4);
  const alignedBitpos = at3encPackBitsU16(alignedOut, 0, 0b101101, 6);
  assert.equal(alignedBitpos, 6);
  assert.deepEqual(Array.from(alignedOut), [180, 0, 0, 0]);

  const unalignedOut = new Uint8Array(4);
  let bitpos = at3encPackBitsU16(unalignedOut, 3, 0b111001, 6);
  bitpos = at3encPackBitsU16(unalignedOut, bitpos, 0b101, 3);
  assert.equal(bitpos, 12);
  assert.deepEqual(Array.from(unalignedOut), [28, 208, 0, 0]);
});

test("ATRAC3 pack-bit helpers preserve table-coded writes and quant index masking", () => {
  const alignedOut = new Uint8Array(4);
  const alignedBitpos = at3encPackTableU16(alignedOut, 0, AT3ENC_PROC_TABLE_1, 7);
  assert.equal(alignedBitpos, 3);
  assert.deepEqual(Array.from(alignedOut), [160, 0, 0, 0]);

  const unalignedOut = new Uint8Array(4);
  const unalignedBitpos = at3encPackTableU16(unalignedOut, 5, AT3ENC_PROC_TABLE_1, 6);
  assert.equal(unalignedBitpos, 9);
  assert.deepEqual(Array.from(unalignedOut), [6, 128, 0, 0]);

  assert.equal(at3encQuantIdxF32(3.5, 2, 0x0f), 7);
  assert.equal(at3encQuantIdxF32(-2.5, 2, 0x07), 3);
});

test("ATRAC3 pack-bit helpers preserve current input validation", () => {
  assert.throws(() => at3encPackBitsU16(null, 0, 0, 1), /out must be a Uint8Array/);
  assert.throws(() => at3encPackBitsU16(new Uint8Array(4), 0, 0, 17), /invalid width: 17/);
  assert.throws(
    () => at3encPackTableU16(new Uint8Array(4), 0, null, 0),
    /tableBytes must be a Uint8Array/
  );
  assert.throws(
    () => at3encPackTableU16(new Uint8Array(4), 0, AT3ENC_PROC_TABLE_1, -1),
    /invalid table index: -1/
  );
  assert.throws(
    () => at3encPackTableU16(new Uint8Array(4), 0, AT3ENC_PROC_TABLE_1, AT3ENC_PROC_TABLE_1.length),
    /exceeds table bounds/
  );
});

test("writeAtrac3ToneRegionSideband preserves the current empty-region fast path", () => {
  const procWords = new Uint32Array(0x80);
  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 0;

  const out = new Uint8Array(4);
  const bitpos = writeAtrac3ToneRegionSideband(procWords, 1, out, 0);

  assert.equal(bitpos, 5);
  assert.deepEqual(Array.from(out), [0, 0, 0, 0]);
});

test("writeAtrac3ToneRegionSideband preserves the current single-region tone payload", () => {
  const procWords = new Uint32Array(0x200);
  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = 1;
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 1;
  procWords[at3encProcToneRegionFlagWord(0, 0)] = 1;
  procWords[at3encProcToneRegionModeWord(0)] = 3;
  procWords[at3encProcToneRegionSymMaxWord(0)] = 1;
  setToneWord(procWords, 0x150, [1, 2, 0, 0], 64, 9);
  setRegionRow(procWords, 0, 0, [0x150]);

  const out = new Uint8Array(16);
  const bitpos = writeAtrac3ToneRegionSideband(procWords, 1, out, 0);

  assert.equal(bitpos, 44);
  assert.deepEqual(Array.from(out.slice(0, 8)), [11, 44, 146, 1, 64, 0, 0, 0]);
});

test("writeAtrac3ToneRegionSideband preserves current multi-unit ordering and null-table skipping", () => {
  const procWords = new Uint32Array(0x200);
  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 2;
  procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = 0;
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 2;
  procWords[at3encProcToneRegionFlagWord(0, 0)] = 1;
  procWords[at3encProcToneRegionFlagWord(0, 1)] = 1;
  procWords[at3encProcToneRegionModeWord(0)] = 3;
  procWords[at3encProcToneRegionSymMaxWord(0)] = 0;
  procWords[at3encProcToneRegionFlagWord(1, 0)] = 1;
  procWords[at3encProcToneRegionFlagWord(1, 1)] = 0;
  setToneWord(procWords, 0x150, [3, 0, 0, 0], 68, 11);
  setRegionRow(procWords, 0, 0, [procWords.length]);
  setRegionRow(procWords, 0, 4, [0x150]);
  setRegionRow(procWords, 1, 0, [0x150]);

  const out = new Uint8Array(16);
  const bitpos = writeAtrac3ToneRegionSideband(procWords, 2, out, 0);

  assert.equal(bitpos, 63);
  assert.deepEqual(Array.from(out.slice(0, 8)), [17, 134, 64, 4, 177, 56, 1, 0]);
});
