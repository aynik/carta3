/**
 * Internal ATRAC3plus signal-processing barrel.
 *
 * The stable subsystem surface in `index.js` focuses on the filterbank and
 * frame-analysis stages. Aux/state buffers, band-pointer layout, and stereo
 * maintenance helpers stay here for local runtime setup and focused tests.
 */
export {
  AT5_SIGPROC_AUX_BYTES,
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_CORR_SAMPLES,
  AT5_SIGPROC_FRAME_SAMPLES,
  AT5_SIGPROC_INTENSITY_DEFAULT,
  AT5_SIGPROC_MAX_CHANNELS,
  AT5_SIGPROC_SLOTS,
  AT5_SIGPROC_SUBSAMPLES,
  AT5_SIGPROC_TAIL_SAMPLES,
  AT5_SIGPROC_WINDOW_SAMPLES,
} from "./constants.js";

export { at5SigprocModulate16band, at5SigprocPolyphaseSums } from "./filterbank.js";
export { at5SigprocAnalyzeChannel } from "./filterbank-analysis.js";
export { at5SigprocAnalyzeFrame } from "./frame.js";

export {
  at5SigprocCorrHistoryViews,
  at5SigprocIntensityBandView,
  at5SigprocMode3Views,
  at5SigprocShiftAux,
  at5SigprocTime2freqBandFlagsView,
  createAt5SigprocAux,
} from "./aux.js";
export { createAt5Time2freqState, at5SigprocShiftTimeState } from "./time-state.js";
export { at5SigprocRotateChannelBlocks } from "./blocks.js";
export { at5BandPtr, buildAt5SigprocBandPtrTable } from "./bandptr.js";
export { at5SigprocUpdateDbDiff, at5SigprocApplyIntensityStereo } from "./stereo.js";
