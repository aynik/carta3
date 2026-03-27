import { CodecError } from "../common/errors.js";
import { at3encApplyChannelConversion } from "./channel-conversion-apply.js";
import { selectChannelConversion } from "./channel-conversion-analysis.js";
import { dbaMainSub } from "./channel-rebalance.js";
import { packAtrac3Algorithm0FrameOutput } from "./frame-output.js";
import { at3encQmfAnalyze } from "./qmf.js";
import { at3encProcessLayerTransform } from "./transform.js";

const AT3_FRAME_LAYER_SAMPLES = 1024;
const AT3_ALGORITHM0_PAIR_CHANNELS = 2;
const AT3_QMF_CURVE_TAPS = 23;
const AT3_TRANSFORM_FFT_SCRATCH_SAMPLES = 1024;

/** Runs the full algorithm-0 ATRAC3 frame pipeline for one packed frame. */
export function encodeAtrac3Algorithm0Frame(pcmLayers, state, out) {
  if (!Array.isArray(pcmLayers)) {
    throw new CodecError("pcmLayers must be an array of Float32Array layer buffers");
  }
  if (pcmLayers.length < AT3_ALGORITHM0_PAIR_CHANNELS) {
    throw new CodecError(
      `expected ${AT3_ALGORITHM0_PAIR_CHANNELS} PCM layer buffers, got ${pcmLayers.length}`
    );
  }

  const {
    primaryLayer,
    secondaryLayer,
    secondaryUsesSwappedTailTransport,
    usesDbaStereoRebalance,
  } = state;
  if (!primaryLayer || !secondaryLayer) {
    throw new CodecError("state must provide the ATRAC3 primaryLayer and secondaryLayer");
  }
  const qmfCurve = state.scratch?.qmfCurve;
  if (!(qmfCurve instanceof Float32Array) || qmfCurve.length < AT3_QMF_CURVE_TAPS) {
    throw new CodecError(
      `state.scratch.qmfCurve must be a Float32Array with at least ${AT3_QMF_CURVE_TAPS} values`
    );
  }
  const fftStorage = state.scratch?.fft;
  if (
    !(fftStorage instanceof Float32Array) ||
    fftStorage.length < AT3_TRANSFORM_FFT_SCRATCH_SAMPLES
  ) {
    throw new CodecError("state.scratch.fft must be a Float32Array with at least 1024 values");
  }

  const [primaryPcm, secondaryPcm] = pcmLayers;
  for (const [layerIndex, pcm] of [primaryPcm, secondaryPcm].entries()) {
    if (!(pcm instanceof Float32Array) || pcm.length < AT3_FRAME_LAYER_SAMPLES) {
      throw new CodecError(
        `pcmLayers[${layerIndex}] must be a Float32Array with at least ${AT3_FRAME_LAYER_SAMPLES} samples`
      );
    }
  }

  // Phase 1: algorithm-0 always analyzes a fixed primary/secondary pair.
  at3encQmfAnalyze(qmfCurve, primaryPcm, primaryLayer.spectrum, primaryLayer.workspace.qmfHistory);
  at3encQmfAnalyze(
    qmfCurve,
    secondaryPcm,
    secondaryLayer.spectrum,
    secondaryLayer.workspace.qmfHistory
  );

  // Phase 2: low-bitrate stereo converts the secondary layer before transform.
  if (secondaryUsesSwappedTailTransport) {
    selectChannelConversion(
      state.channelConversion,
      primaryLayer.spectrum,
      secondaryLayer.spectrum
    );
    at3encApplyChannelConversion(state);
  }

  // Phase 3: transform the fixed primary/secondary pair into packed candidates.
  at3encProcessLayerTransform(state, primaryLayer, fftStorage);
  at3encProcessLayerTransform(state, secondaryLayer, fftStorage);

  // Phase 4: when the conversion path stays active, DBA rebalances the pair.
  if (usesDbaStereoRebalance) {
    dbaMainSub(state);
  }

  // Phase 5: assemble the final frame transport after the signal path settles.
  return packAtrac3Algorithm0FrameOutput(state, out);
}
