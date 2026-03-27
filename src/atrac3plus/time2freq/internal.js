/**
 * Internal ATRAC3plus time-to-frequency barrel.
 *
 * The stable subsystem surface in `index.js` exposes the MDCT-stage entrypoints
 * that advance analysis into allocation. Buffer construction, record helpers,
 * thresholding, and low-mode repair stay here for encoder runtime setup and
 * focused tests.
 */
export { AT5_GAIN_SEGMENTS_MAX, AT5_T2F_BANDS_MAX, AT5_T2F_MAX_CHANNELS } from "./constants.js";
export { createAt5EncodeBufBlock, createAt5EncodeBufRecord } from "./buf.js";
export { at5T2fComputeCorrAverage, at5T2fCorrByBandFromAux, time2freqScratch } from "./runtime.js";
export {
  at5GainRecordClearUnusedTail,
  at5GainRecordDecrementIndex,
  at5GainRecordEqual,
  at5GainRecordMetric,
  at5GainRecordNormalize,
} from "./record.js";
export { at5Time2freqMdctStage } from "./index.js";
export { at5T2fMdctOutputs, at5T2fSelectWindow } from "./mdct.js";
export {
  at5T2fAlignTlevFlagsStereo,
  at5T2fComputeTlevForChannel,
  at5T2fThresholdTable,
} from "./tlev.js";
export { at5T2fGaincSetup } from "./gainc.js";
export {
  at5MaxAbs256,
  at5T2fAdjustBand0RecordFromBand1,
  at5T2fAdjustMaximaStereo,
  at5T2fComputeMaxima,
  at5T2fCopyRecordsStereoLowModes,
  at5T2fLowModeMaximaAndOverflow,
  at5T2fMergeAdjacentBandRecords,
  at5T2fMergeCloseRecordsBetweenChannels,
  at5T2fReduceGainOverflow,
} from "./lowmode.js";
