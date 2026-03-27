import {
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_FRAME_SAMPLES,
  AT5_SIGPROC_SUBSAMPLES,
  AT5_SIGPROC_TAIL_SAMPLES,
  AT5_SIGPROC_WINDOW_SAMPLES,
} from "./constants.js";
import { at5SigprocModulate16band, at5SigprocPolyphaseSums } from "./filterbank.js";

/**
 * Runs the ATRAC3plus analysis filterbank over one input channel, reusing the
 * caller-provided state buffers and optionally exposing one traced subsample.
 */
export function at5SigprocAnalyzeChannel(state, pcm, slot8BandPtrs, trace = null) {
  if (!state || !pcm) {
    return;
  }

  const window =
    state.window instanceof Float32Array
      ? state.window
      : new Float32Array(AT5_SIGPROC_WINDOW_SAMPLES);
  window.set(state.tail, 0);
  const frameView = pcm.subarray(0, Math.min(pcm.length, AT5_SIGPROC_FRAME_SAMPLES));
  window.set(frameView, AT5_SIGPROC_TAIL_SAMPLES);
  if (frameView.length < AT5_SIGPROC_FRAME_SAMPLES) {
    window.fill(0, AT5_SIGPROC_TAIL_SAMPLES + frameView.length, AT5_SIGPROC_WINDOW_SAMPLES);
  }

  const poly =
    state.poly instanceof Float32Array ? state.poly : new Float32Array(AT5_SIGPROC_BANDS_MAX);
  const polyX87 =
    state.polyX87 instanceof Float64Array ? state.polyX87 : new Float64Array(AT5_SIGPROC_BANDS_MAX);
  const polyAcc = state.polyAcc instanceof Float64Array ? state.polyAcc : null;
  const bands =
    state.bands instanceof Float32Array ? state.bands : new Float32Array(AT5_SIGPROC_BANDS_MAX);

  for (let n = 0; n < AT5_SIGPROC_SUBSAMPLES; n += 1) {
    const x =
      state.windowPtrsByN?.[n] ??
      window.subarray(16 + n * 16, 16 + n * 16 + AT5_SIGPROC_TAIL_SAMPLES);

    at5SigprocPolyphaseSums(x, poly, polyX87, polyAcc);
    at5SigprocModulate16band(poly, polyX87, bands);

    const wantN = trace?.wantN;
    if (
      wantN !== null &&
      wantN !== undefined &&
      (wantN | 0) === n &&
      typeof trace?.onDump === "function"
    ) {
      trace.onDump({
        callIndex: trace.callIndex | 0,
        ch: trace.ch | 0,
        n,
        x: new Float32Array(x),
        poly: new Float32Array(poly),
        polyX87: new Float64Array(polyX87),
        bands: new Float32Array(bands),
      });
    }

    for (let band = 0; band < AT5_SIGPROC_BANDS_MAX; band += 1) {
      if (slot8BandPtrs?.[band]) {
        slot8BandPtrs[band][n] = bands[band];
      }
    }
  }

  state.tail.set(
    state.windowTail instanceof Float32Array
      ? state.windowTail
      : window.subarray(AT5_SIGPROC_FRAME_SAMPLES)
  );
}
