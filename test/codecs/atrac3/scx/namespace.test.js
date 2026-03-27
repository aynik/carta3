import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3Internal from "../../../../src/atrac3/internal.js";
import * as ScxInternal from "../../../../src/atrac3/scx/internal.js";
import * as Scx from "../../../../src/atrac3/scx/index.js";
import {
  createAtrac3ScxEncoderContext,
  isAtrac3ScxEncoderContext,
} from "../../../../src/atrac3/scx/context.js";
import { initDbaAt3 } from "../../../../src/atrac3/scx/context.js";
import {
  beginAtrac3ScxFrame,
  clearScxChannelFrameState,
} from "../../../../src/atrac3/scx/frame.js";
import { createAt3GainControlBlocks } from "../../../../src/atrac3/scx/gainc-layout.js";
import { gaincontrolAt3, idofLngainAt3, lngainofIdAt3 } from "../../../../src/atrac3/scx/gainc.js";
import { createAt3ScxHuffTableSets } from "../../../../src/atrac3/scx/huffman.js";
import { encodeMddataAt3 } from "../../../../src/atrac3/scx/mddata.js";
import { nbitsForPackdataAt3 } from "../../../../src/atrac3/scx/pack-bits.js";
import {
  AT3_NBITS_ERROR,
  spectrumOffsetForQuantBandAt3,
} from "../../../../src/atrac3/scx/tables.js";
import { time2freqAt3 } from "../../../../src/atrac3/scx/time2freq.js";
import { quantAt3, quantToneSpecs } from "../../../../src/atrac3/scx/tone.js";

test("ATRAC3 SCX public barrel exposes only frame-level entrypoints", () => {
  assert.equal(typeof Scx.createAtrac3ScxEncoderContext, "function");
  assert.equal(typeof Scx.at3ScxEncodeFrameFromPcm, "function");
  assert.equal(typeof Scx.at3ScxEncodeFrameFromSpectra, "function");

  assert.equal("initDbaAt3" in Scx, false);
  assert.equal("beginAtrac3ScxFrame" in Scx, false);
  assert.equal("clearScxChannelFrameState" in Scx, false);
  assert.equal("time2freqAt3" in Scx, false);
  assert.equal("packMddataAt3" in Scx, false);
});

test("ATRAC3 internal namespace groups lower-level SCX helper surfaces", () => {
  assert.equal(Atrac3Internal.Scx, ScxInternal);
  assert.equal(Atrac3Internal.Scx.createAtrac3ScxEncoderContext, createAtrac3ScxEncoderContext);
  assert.equal(Atrac3Internal.Scx.isAtrac3ScxEncoderContext, isAtrac3ScxEncoderContext);
  assert.equal(Atrac3Internal.Scx.initDbaAt3, initDbaAt3);
  assert.equal(Atrac3Internal.Scx.beginAtrac3ScxFrame, beginAtrac3ScxFrame);
  assert.equal(Atrac3Internal.Scx.clearScxChannelFrameState, clearScxChannelFrameState);
  assert.equal(Atrac3Internal.Scx.createAt3GainControlBlocks, createAt3GainControlBlocks);
  assert.equal(Atrac3Internal.Scx.lngainofIdAt3, lngainofIdAt3);
  assert.equal(Atrac3Internal.Scx.idofLngainAt3, idofLngainAt3);
  assert.equal(Atrac3Internal.Scx.gaincontrolAt3, gaincontrolAt3);
  assert.equal(Atrac3Internal.Scx.createAt3ScxHuffTableSets, createAt3ScxHuffTableSets);
  assert.equal(Atrac3Internal.Scx.encodeMddataAt3, encodeMddataAt3);
  assert.equal(Atrac3Internal.Scx.nbitsForPackdataAt3, nbitsForPackdataAt3);
  assert.equal(Atrac3Internal.Scx.quantAt3, quantAt3);
  assert.equal(Atrac3Internal.Scx.time2freqAt3, time2freqAt3);
  assert.equal(Atrac3Internal.Scx.quantToneSpecs, quantToneSpecs);
  assert.equal(Atrac3Internal.Scx.spectrumOffsetForQuantBandAt3, spectrumOffsetForQuantBandAt3);
  assert.equal(Atrac3Internal.Scx.AT3_NBITS_ERROR, AT3_NBITS_ERROR);
});
