/**
 * Time-domain preprocessing and analysis for ATRAC3plus encode.
 *
 * This stable surface exposes the filterbank and frame-analysis stages that
 * other encode paths can study directly. Aux/state layout helpers stay in
 * `internal.js`.
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
