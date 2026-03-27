import { CodecError } from "../common/errors.js";
import {
  AT3ENC_PROC_ACTIVE_BANDS_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_UNIT_COUNT_WORD,
} from "./proc-layout.js";
import { fillAt3ProcWordsLowBudget } from "./proc-words.js";
import { at3encPackChannel } from "./frame-channel.js";

const AT3_ALGORITHM0_LAYER_COUNT = 2;
const AT3_SWAPPED_TAIL_SECONDARY_SHIFT_BIAS = 0x1b;
const AT3ENC_PROC_MINIMAL_PAYLOAD_SHIFT_MAX = 0x27;

function shouldUseMinimalProcPayload(shift, options = {}) {
  return (
    options.forceMinimalPayload === true ||
    options.forceFallback === true ||
    (shift | 0) <= AT3ENC_PROC_MINIMAL_PAYLOAD_SHIFT_MAX
  );
}

function writeMinimalChannelProcWords(procWords, toneBlocks) {
  procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = 1;
  procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD] = 1;
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = 0;
  procWords[0] = 0;
  toneBlocks[0].entryCount = 0;
  return procWords;
}

/**
 * Prepares the proc-word buffer used by ATRAC3 algorithm-0 layer packing.
 *
 * Layers whose shift has reached the normal packing range keep their authored
 * low-budget payload. Smaller shifts fall back to the minimal one-band
 * placeholder that keeps the transport valid, and focused tests may force
 * that placeholder explicitly.
 */
export function at3encPrepareChannelProcWords(state, layer, options = {}) {
  if (!(state.procWords instanceof Uint32Array)) {
    throw new CodecError("state.procWords must be a Uint32Array");
  }
  if (!layer || typeof layer !== "object") {
    throw new CodecError("layer must be a layer object");
  }
  if (!Array.isArray(layer.tones?.blocks) || layer.tones.blocks.length < 4) {
    throw new CodecError("layer.tones.blocks must contain 4 tone blocks");
  }

  if (shouldUseMinimalProcPayload(layer.shift, options)) {
    return writeMinimalChannelProcWords(state.procWords, layer.tones.blocks);
  }

  fillAt3ProcWordsLowBudget(layer, state, state.procWords);
  return state.procWords;
}

/**
 * Packs the current ATRAC3 algorithm-0 primary/secondary pair into its final
 * frame transport layout.
 *
 * Callers are expected to provide a populated runtime state whose spectra,
 * shifts, and optional conversion bookkeeping already reflect the current
 * frame analysis path.
 */
export function packAtrac3Algorithm0FrameOutput(state, out) {
  const bytesPerLayer = Math.trunc(state?.bytesPerLayer);
  if (bytesPerLayer <= 0) {
    throw new CodecError(`invalid bytesPerLayer: ${bytesPerLayer}`);
  }

  const frameBytes = AT3_ALGORITHM0_LAYER_COUNT * bytesPerLayer;
  const frame = out ?? new Uint8Array(frameBytes);
  if (!(frame instanceof Uint8Array) || frame.length < frameBytes) {
    throw new CodecError(`out must be a Uint8Array with at least ${frameBytes} bytes`);
  }

  const { primaryLayer, secondaryLayer, secondaryUsesSwappedTailTransport } = state;

  frame.fill(0);
  at3encPrepareChannelProcWords(state, primaryLayer);
  const primaryBitpos = at3encPackChannel(state, primaryLayer, 0, frame);

  if (secondaryUsesSwappedTailTransport) {
    const outOffsetBytes = Math.ceil(primaryBitpos / 8);
    secondaryLayer.shift =
      (frame.length - outOffsetBytes) * 8 - AT3_SWAPPED_TAIL_SECONDARY_SHIFT_BIAS;
    at3encPrepareChannelProcWords(state, secondaryLayer);
    at3encPackChannel(state, secondaryLayer, outOffsetBytes, frame);

    // Low-bitrate stereo reopens the converted secondary payload from the
    // frame tail, so the packed body is stored in reverse order.
    frame.subarray(outOffsetBytes).reverse();
    return frame;
  }

  at3encPrepareChannelProcWords(state, secondaryLayer);
  at3encPackChannel(state, secondaryLayer, bytesPerLayer, frame);

  return frame;
}
