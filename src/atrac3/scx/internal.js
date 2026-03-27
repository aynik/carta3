/**
 * Package-private ATRAC3 SCX barrel.
 *
 * `index.js` exposes only the frame-level SCX entrypoints. This barrel keeps
 * the lower-level context, channel-state allocation, channel-unit packing,
 * mddata search, tone quantization, gain control, and table helpers under
 * the named subsystem that owns them. Keep this surface explicitly authored so
 * internal tooling can see which SCX owner file each helper comes from without
 * reading through wildcard fan-out.
 */
export {
  AT3_SCX_CONFIG_WORD,
  createScxChannelScratch,
  createScxChannelHistory,
} from "./channel-state.js";
export {
  packMddataAt3,
  putChsunitAt3,
  encodeScxChannelUnitAt3,
  encodeScxPcmChannelAt3,
} from "./channel-unit.js";
export {
  createAt3DbaState,
  initDbaAt3,
  createAtrac3ScxEncoderContext,
  isAtrac3ScxEncoderContext,
} from "./context.js";
export {
  clearScxChannelFrameState,
  beginAtrac3ScxFrame,
  at3ScxEncodeFrameFromSpectra,
  at3ScxEncodeFrameFromPcm,
} from "./frame.js";
export {
  AT3_GAIN_CONTROL_BLOCK_WORDS,
  AT3_GAIN_CONTROL_ENTRY_LIMIT,
  AT3_GAIN_CONTROL_COUNT_INDEX,
  createAt3GainControlBlock,
  createAt3GainControlBlocks,
  clearAt3GainControlBlock,
  getAt3GainControlWords,
  getAt3GainControlCount,
  setAt3GainControlCount,
  hasAt3GainControl,
  at3GainControlEndIndex,
  getAt3GainControlEnd,
  setAt3GainControlEnd,
  at3GainControlGainIdIndex,
  getAt3GainControlGainId,
  setAt3GainControlGainId,
  setAt3GainControlEntry,
  getAt3GainControlMaxFirst,
  setAt3GainControlMaxFirst,
  isAt3GainControlAttack,
} from "./gainc-layout.js";
export { lngainofIdAt3, idofLngainAt3, gaincWindow, gaincontrolAt3 } from "./gainc.js";
export {
  AT3_HUFFBITS_ERROR,
  createAt3ScxHuffTableSets,
  huffbits,
  packStoreFromMsb,
  packSpecs,
} from "./huffman.js";
export {
  AT3_MDDATA_FAIL_NONE,
  AT3_MDDATA_FAIL_SINGLE_TONE,
  AT3_MDDATA_FAIL_CALC_SEARCH,
  AT3_MDDATA_FAIL_ID_ADJUST,
  AT3_MDDATA_FAIL_IDWL_DECR,
  AT3_MDDATA_FAIL_DEFAULT,
  AT3_MDDATA_FAIL_SCFOF,
  AT3_MDDATA_FAIL_QNS_REFINE_1,
  AT3_MDDATA_FAIL_QNS_REFINE_2,
  AT3_MDDATA_FAIL_QNS_REFINE_3,
  AT3_MDDATA_FAIL_QNS_REFINE_4,
  AT3_MDDATA_FAIL_QNS_REFINE_5,
  AT3_MDDATA_FAIL_NSTEPS,
  AT3_MDDATA_FAIL_FINAL_MISMATCH,
  getAt3MddataFailSite,
  encodeMddataAt3,
} from "./mddata.js";
export { singleToneCheck, extractSingleTones, extractMultitone } from "./mddata-tones.js";
export {
  toInt,
  resolveGlobalState,
  resolveComponentGroupCount,
  isArrayLike,
  at3BitsToBytesCeil,
  resolveComponentPlan,
  resolveSpectrumSection,
  collectActiveSpectrumBands,
  nbitsForAdjust,
  nbitsForSheader,
  nbitsForPackdata,
  nbitsForComponent,
  nbitsForSpectrum,
  nbitsForPackdataAt3,
} from "./pack-bits.js";
export { quantNontoneNspecs } from "./quant.js";
export {
  AT3_NBITS_ERROR,
  spectrumOffsetForQuantBandAt3,
  spectrumSampleCountForQuantBandAt3,
  windowLengthForWordLengthIndexAt3,
  quantStepCountForWordLengthIndexAt3,
  toneWidthForTwiddleIdAt3,
  scaleFactorValueForIndexAt3,
  zeroThresholdForWordLengthIndexAt3,
  filterBandForQuantBandAt3,
  scaleFactorIndexForAbsValueAt3,
  scaleFactorIndexForValueAt3,
} from "./tables.js";
export {
  forwardTransformAt3,
  createAt3Time2freqTable,
  getAt3Time2freqMdctBlocks,
  getAt3Time2freqNoGainScratch,
  channelNeedsForwardTransformAt3,
  time2freqAt3,
} from "./time2freq.js";
export { quantAt3, quantToneSpecs, extractToneSpecs } from "./tone.js";
