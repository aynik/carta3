import assert from "node:assert/strict";
import test from "node:test";

import * as Bitstream from "../../../src/atrac3plus/bitstream/index.js";
import * as BitstreamInternal from "../../../src/atrac3plus/bitstream/internal.js";
import * as Gain from "../../../src/atrac3plus/bitstream/gain.js";
import * as GainInternal from "../../../src/atrac3plus/bitstream/gain-internal.js";
import * as Gh from "../../../src/atrac3plus/bitstream/gh.js";
import * as GhInternal from "../../../src/atrac3plus/bitstream/gh-internal.js";
import * as Idct from "../../../src/atrac3plus/bitstream/idct.js";
import * as IdctInternal from "../../../src/atrac3plus/bitstream/idct-internal.js";
import * as Idsf from "../../../src/atrac3plus/bitstream/idsf.js";
import * as IdsfInternal from "../../../src/atrac3plus/bitstream/idsf-internal.js";
import * as Idwl from "../../../src/atrac3plus/bitstream/idwl.js";
import * as IdwlInternal from "../../../src/atrac3plus/bitstream/idwl-internal.js";

test("public ATRAC3plus bitstream barrel exposes stable transport entrypoints", () => {
  assert.equal(typeof Bitstream.unpackAtxFrame, "function");
  assert.equal(typeof Bitstream.createAt5RegularBlockState, "function");
  assert.equal(typeof Bitstream.unpackChannelBlockAt5Reg, "function");
  assert.equal(typeof Bitstream.unpackIdwl, "function");
  assert.equal(typeof Bitstream.at5DecodeHcspecSymbols, "function");

  assert.equal("at5ReadBits24" in Bitstream, false);
  assert.equal("calcNbitsForIdwlChAt5" in Bitstream, false);
  assert.equal("packChannelBlockAt5Reg" in Bitstream, false);
  assert.equal("at5PackGainIdlev0" in Bitstream, false);
  assert.equal("calcNbitsForGhaAt5" in Bitstream, false);
});

test("internal ATRAC3plus bitstream barrel retains packers and bit-cost helpers", () => {
  assert.equal(typeof BitstreamInternal.at5HcPackedSymbolCount, "function");
  assert.equal(typeof BitstreamInternal.at5PackHcspecForBand, "function");
  assert.equal(typeof BitstreamInternal.at5PackStoreFromMsb, "function");
  assert.equal(typeof BitstreamInternal.at5ReadBits24, "function");
  assert.equal(typeof BitstreamInternal.atxRegularBlockTypeForChannels, "function");
  assert.equal(typeof BitstreamInternal.atxFrameBlockTypeName, "function");
  assert.equal(typeof BitstreamInternal.ATX_FRAME_SYNC_FLAG, "number");
  assert.equal(typeof BitstreamInternal.calcNbitsForIdctAt5, "function");
  assert.equal(typeof BitstreamInternal.packIdctChannel, "function");
  assert.equal(typeof BitstreamInternal.calcNbitsForIdsfChAt5, "function");
  assert.equal(typeof BitstreamInternal.packIdsfChannel, "function");
  assert.equal(typeof BitstreamInternal.calcNbitsForIdwlChAt5, "function");
  assert.equal(typeof BitstreamInternal.calcNbitsForIdwl1At5, "function");
  assert.equal(typeof BitstreamInternal.calcNbitsForIdwl4At5, "function");
  assert.equal(typeof BitstreamInternal.resolveInitialIdwlCostPlan, "function");
  assert.equal(typeof BitstreamInternal.idwlScratchConfigForSlot, "function");
  assert.equal(typeof BitstreamInternal.AT5_IDWL_CONFIG_ROW, "number");
  assert.equal(typeof BitstreamInternal.buildIdwlGroupPlans, "function");
  assert.equal(typeof BitstreamInternal.idwlWorkMode1Lead, "function");
  assert.equal(typeof BitstreamInternal.idwlWorkMode2SymbolsView, "function");
  assert.equal(typeof BitstreamInternal.packChannelBlockAt5Reg, "function");
  assert.equal(typeof BitstreamInternal.packGainRecords, "function");
  assert.equal(typeof BitstreamInternal.at5PackGainIdlev0, "function");
  assert.equal(typeof BitstreamInternal.calcNbitsForGhaAt5, "function");
});

test("ATRAC3plus bitstream submodules keep unpack/state roots separate from encode planners", () => {
  assert.equal(typeof Gain.unpackGainRecords, "function");
  assert.equal("packGainRecords" in Gain, false);
  assert.equal(typeof GainInternal.unpackGainRecords, "function");
  assert.equal(typeof GainInternal.packGainRecords, "function");

  assert.equal(typeof Gh.unpackGh, "function");
  assert.equal("calcNbitsForGhaAt5" in Gh, false);
  assert.equal(typeof GhInternal.calcNbitsForGhaAt5, "function");
  assert.equal(typeof GhInternal.packGhAt5, "function");

  assert.equal(typeof Idct.unpackIdct, "function");
  assert.equal("calcNbitsForIdctAt5" in Idct, false);
  assert.equal("setIdctTypes" in Idct, false);
  assert.equal("packIdctChannel" in Idct, false);
  assert.equal(typeof IdctInternal.calcNbitsForIdctAt5, "function");
  assert.equal(typeof IdctInternal.setIdctTypes, "function");
  assert.equal(typeof IdctInternal.packIdctChannel, "function");

  assert.equal(typeof Idsf.unpackIdsf, "function");
  assert.equal("calcNbitsForIdsfChAt5" in Idsf, false);
  assert.equal("packIdsfChannel" in Idsf, false);
  assert.equal(typeof IdsfInternal.calcNbitsForIdsfChAt5, "function");
  assert.equal(typeof IdsfInternal.packIdsfChannel, "function");

  assert.equal(typeof Idwl.unpackIdwl, "function");
  assert.equal("calcNbitsForIdwlChAt5" in Idwl, false);
  assert.equal("copyWlcinfoAt5" in Idwl, false);
  assert.equal("packIdwlChannel" in Idwl, false);
  assert.equal(typeof IdwlInternal.calcNbitsForIdwlChAt5, "function");
  assert.equal(typeof IdwlInternal.copyWlcinfoAt5, "function");
  assert.equal(typeof IdwlInternal.packIdwlChannel, "function");
});
