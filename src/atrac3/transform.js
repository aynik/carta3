import { CodecError } from "../common/errors.js";
import { runAtrac3TransformFft } from "./transform-fft.js";
import { rebuildAtrac3ToneGainEnvelopes } from "./transform-tones.js";

const AT3ENC_SPECTRUM_FLOATS = 1024;
const AT3ENC_TRANSFORM_WORK_FLOATS = 1536;
const AT3ENC_TONE_BLOCK_COUNT = 4;

export function at3encProcessLayerTransform(state, layer, fftStorage = null, debugStages = null) {
  if (!state || !layer) {
    throw new CodecError("state and layer are required");
  }
  if (!(layer.spectrum instanceof Float32Array) || layer.spectrum.length < AT3ENC_SPECTRUM_FLOATS) {
    throw new CodecError(
      `layer.spectrum must be a Float32Array with at least ${AT3ENC_SPECTRUM_FLOATS} values`
    );
  }
  const transformWork = layer.workspace?.transform;
  if (
    !(transformWork instanceof Float32Array) ||
    transformWork.length < AT3ENC_TRANSFORM_WORK_FLOATS
  ) {
    throw new CodecError(
      `layer.workspace.transform must be a Float32Array with at least ${AT3ENC_TRANSFORM_WORK_FLOATS} values`
    );
  }
  if (!Array.isArray(layer.tones?.blocks) || layer.tones.blocks.length < AT3ENC_TONE_BLOCK_COUNT) {
    throw new CodecError(`layer.tones.blocks must contain ${AT3ENC_TONE_BLOCK_COUNT} tone blocks`);
  }

  let resolvedFftStorage = fftStorage;
  if (resolvedFftStorage == null) {
    const scratchFft = state.scratch?.fft;
    if (scratchFft instanceof Float32Array && scratchFft.length >= AT3ENC_SPECTRUM_FLOATS) {
      resolvedFftStorage = scratchFft;
    } else {
      resolvedFftStorage = new Float32Array(AT3ENC_SPECTRUM_FLOATS);
      if (state && typeof state === "object") {
        let { scratch } = state;
        if (!scratch || typeof scratch !== "object") {
          scratch = {};
          state.scratch = scratch;
        }
        scratch.fft = resolvedFftStorage;
      }
    }
  } else if (
    !(resolvedFftStorage instanceof Float32Array) ||
    resolvedFftStorage.length < AT3ENC_SPECTRUM_FLOATS
  ) {
    throw new CodecError(
      `fftStorage must be a Float32Array with at least ${AT3ENC_SPECTRUM_FLOATS} values`
    );
  }

  // Phase 1: measure the four-lane spectral peaks and rebuild the per-block
  // tone-gain envelopes that shape the transform work buffer.
  rebuildAtrac3ToneGainEnvelopes(state, layer);

  // Phase 2: twiddle the shaped work buffer, run the FFT passes, and scatter
  // the folded result back into ATRAC3 spectrum order.
  runAtrac3TransformFft(layer, resolvedFftStorage, debugStages);
}
