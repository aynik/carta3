/**
 * Internal ATRAC3plus bitstream helper barrel.
 *
 * The stable `index.js` surface is reserved for state builders and unpacking
 * entrypoints that callers can study directly. Lower-level bit readers,
 * packers, and bit-cost planners stay here for codec internals and focused
 * tests.
 */
export {
  at5DecodeHcspecSymbols,
  at5DecodeSym,
  at5ExpandHcspecToCoeffs,
  at5HcPackedSymbolCount,
  at5HcValueMask,
  at5HcspecDescForBand,
  at5PackHcspecForBand,
  at5PackStoreFromMsb,
  at5PackSym,
  at5ReadBits,
  at5ReadBits24,
  at5SignExtend3Bit,
  at5SignExtend5Bit,
  createAt5PresenceTable,
  createAt5SpectraChannelState,
  decodeAt5Presence,
  unpackChannelSpectra,
  updateAt5PresenceTableBits,
} from "./bitstream.js";

export { at5ActiveBandCount, createAt5RegularBlockState } from "./block-state.js";
export { AT5_CHANNEL_BLOCK_ERROR_CODES, unpackChannelBlockAt5Reg } from "./block-regular.js";
export { ATX_FRAME_UNPACK_ERROR_CODES, unpackAtxFrame } from "./frame-unpack.js";
export {
  ATX_FRAME_BLOCK_TYPE_BITS,
  ATX_FRAME_BLOCK_TYPE_END,
  ATX_FRAME_SYNC_BITS,
  ATX_FRAME_SYNC_FLAG,
  atxFrameBlockTypeName,
  atxRegularBlockTypeForChannels,
} from "./frame-protocol.js";

export {
  AT5_GAIN_ERROR_CODES,
  AT5_GAIN_RECORDS,
  at5PackGainIdlev0,
  at5PackGainIdlev1,
  at5PackGainIdlev2,
  at5PackGainIdlev3,
  at5PackGainIdlev4,
  at5PackGainIdlev5,
  at5PackGainIdloc0,
  at5PackGainIdloc1,
  at5PackGainIdloc2,
  at5PackGainIdloc3,
  at5PackGainIdloc4,
  at5PackGainIdloc5,
  at5PackGainIdloc6,
  at5PackGainNgc0,
  at5PackGainNgc1,
  at5PackGainNgc2Ch0,
  at5PackGainNgc3Ch0,
  at5PackGainNgc4Ch1,
  clearAt5GainRecords,
  createAt5GainChannelState,
  packGainRecords,
  unpackGainIdlev,
  unpackGainIdloc,
  unpackGainNgc,
  unpackGainRecords,
} from "./gain-internal.js";

export {
  AT5_GH_ERROR_CODES,
  clearAt5GhSlot,
  createAt5GhChannelState,
  createAt5GhSharedState,
  unpackGh,
} from "./gh.js";
export {
  calcNbitsForGhaAt5,
  calcNbitsForGhFreq0At5,
  packGhAt5,
  syncGhStateFromSigprocSlotsAt5,
} from "./gh-internal.js";

export { packChannelBlockAt5Reg } from "./block-regular.js";

export {
  AT5_IDCT_ERROR_CODES,
  createAt5IdctChannelState,
  createAt5IdctSharedState,
  unpackIdct,
} from "./idct.js";
export {
  AT5_IDCT_MODE_COPY,
  AT5_IDCT_MODE_DIFF,
  AT5_IDCT_MODE_DIRECT,
  AT5_IDCT_MODE_FIXED,
  calcNbitsForIdctAt5,
  idctTables,
  packIdctChannel,
  setIdctTypes,
} from "./idct-internal.js";

export {
  AT5_IDSF_ERROR_CODES,
  createAt5IdsfChannelState,
  createAt5IdsfSharedState,
  unpackIdsf,
} from "./idsf.js";
export { calcNbitsForIdsfChAt5, packIdsfChannel } from "./idsf-internal.js";

export {
  AT5_IDWL_ERROR_CODES,
  createAt5IdwlChannelState,
  createAt5IdwlSharedState,
  unpackIdwl,
} from "./idwl.js";
export {
  calcNbitsForIdwl1At5,
  calcNbitsForIdwl2SubAt5,
  calcNbitsForIdwl3At5,
  calcNbitsForIdwl4At5,
  calcNbitsForIdwl5At5,
  calcNbitsForIdwlChAt5,
  calcNbitsForIdwlChInitAt5,
  copyWlcinfoAt5,
  packIdwlChannel,
  resolveIncrementalIdwlCostPlan,
  resolveInitialIdwlCostPlan,
  selectLowestIdwlCostSlot,
} from "./idwl-internal.js";
export {
  AT5_IDWL_CONFIG_BAND_COUNT,
  AT5_IDWL_CONFIG_EXTRA_WORD,
  AT5_IDWL_CONFIG_GROUP,
  AT5_IDWL_CONFIG_ROW,
  AT5_IDWL_CONFIG_WL,
  buildIdwlGroupPlans,
  buildIdwlRowGroupPlans,
  findCheapestIdwlGroupPlan,
  findCheapestPositiveIdwlGroupPlan,
  findCheapestPositiveIdwlRowPlan,
  idwlScratchConfigForSlot,
} from "./idwl-shared.js";
export {
  idwlWorkMode1Base,
  idwlWorkMode1Lead,
  idwlWorkMode1Width,
  idwlWorkMode2PairFlag,
  idwlWorkMode2ShapeBase,
  idwlWorkMode2ShapeShift,
  idwlWorkMode2SymbolsView,
} from "./idwl-work.js";
