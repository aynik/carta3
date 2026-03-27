import { CodecError } from "../common/errors.js";
import { createAtrac3Algorithm0RuntimeState } from "./encode-runtime-state.js";
import { findAtrac3CodecProfile } from "./profiles.js";

const AT3_ALGORITHM0_LAYER_COUNT = 2;
const AT3_CHCONV_SLOT_COUNT = 4;
const AT3ENC_PROC_WORD_CAPACITY = 6613;
const AT3ENC_LAYER_SPECTRUM_SAMPLES = 1024;
const AT3ENC_TRANSFORM_SCRATCH_SAMPLES = 1536;
const AT3ENC_QMF_HISTORY_SAMPLES = 0x8a;
const AT3ENC_TONE_BLOCK_COUNT = 4;
const AT3ENC_TONE_BLOCK_ENTRIES = 8;
const AT3ENC_TONE_BLOCK_SCRATCH_WORDS = 0x20;
export { createAtrac3Algorithm0RuntimeState };

/**
 * One per-block ATRAC3 tone/gain sideband record carried across frames.
 *
 * @typedef {object} Atrac3Algorithm0ToneBlock
 * @property {Uint32Array} startIndex
 * @property {Uint32Array} gainIndex
 * @property {Uint32Array} scratchBits
 * @property {number} maxBits
 * @property {number} lastMax
 * @property {number} entryCount
 */

/**
 * One authored ATRAC3 algorithm-0 layer in the fixed primary/secondary pair.
 *
 * @typedef {object} Atrac3Algorithm0EncoderLayerState
 * @property {boolean} referencesPrimaryShift
 * @property {number} sfbLimit
 * @property {number} shift
 * @property {number} workSize
 * @property {number} param
 * @property {Float32Array} spectrum
 * @property {{ transform: Float32Array, qmfHistory: Float32Array }} workspace
 * @property {{ blocks: Atrac3Algorithm0ToneBlock[], previousBlock0EntryCount: number }} tones
 */

/**
 * Codec-owned ATRAC3 algorithm-0 encoder runtime.
 *
 * The encoder always works on one authored primary/secondary layer pair plus a
 * shared conversion, packing, and transform scratch area. Wrapper runtimes may
 * add higher-level fields like `frameIndex` and planar PCM scratch, but this
 * object is the raw codec context they are allowed to reuse directly.
 *
 * @typedef {object} Atrac3Algorithm0EncoderState
 * @property {number} bytesPerLayer
 * @property {number} basePrimaryShift
 * @property {number} primaryShiftTarget
 * @property {boolean} secondaryUsesSwappedTailTransport
 * @property {boolean} usesDbaStereoRebalance
 * @property {object} channelConversion
 * @property {Uint32Array} procWords
 * @property {{ fft: Float32Array, qmfCurve: Float32Array }} scratch
 * @property {Atrac3Algorithm0EncoderLayerState[]} layers
 * @property {Atrac3Algorithm0EncoderLayerState} primaryLayer
 * @property {Atrac3Algorithm0EncoderLayerState} secondaryLayer
 */

/**
 * Package-private ATRAC3 algorithm-0 encode handle.
 *
 * This lightweight wrapper keeps the resolved transport profile next to the
 * reusable raw codec runtime that actually owns the mutable encode state.
 *
 * @typedef {object} Atrac3Algorithm0EncoderHandle
 * @property {number} mode
 * @property {number} bitrateKbps
 * @property {number} frameBytes
 * @property {Atrac3Algorithm0EncoderState} state
 */

function resolveAtrac3EncoderProfile(profileOrMode, bitrateKbps) {
  const hasResolvedLayerPair =
    Array.isArray(profileOrMode?.layers) &&
    profileOrMode.layers.length === AT3_ALGORITHM0_LAYER_COUNT &&
    profileOrMode.layers.every(
      (layer) => Number.isInteger(layer?.param) && Number.isInteger(layer?.sfbLimit)
    );
  if (
    profileOrMode?.codec === "atrac3" &&
    Number.isInteger(profileOrMode.mode) &&
    Number.isInteger(profileOrMode.bitrateKbps) &&
    Number.isInteger(profileOrMode.frameBytes) &&
    hasResolvedLayerPair
  ) {
    return profileOrMode;
  }

  if (profileOrMode && typeof profileOrMode === "object") {
    throw new CodecError("invalid ATRAC3 encoder profile");
  }

  const profile = findAtrac3CodecProfile(profileOrMode, bitrateKbps);
  if (profile) {
    return profile;
  }

  throw new CodecError(`unsupported ATRAC3 encoder mode=${profileOrMode} bitrate=${bitrateKbps}`);
}

function isNumber(value) {
  return typeof value === "number";
}

function isChannelConversionSlot(slot) {
  const magnitudeSums = slot?.magnitudeSums;
  return (
    slot &&
    typeof slot === "object" &&
    isNumber(slot.modeHint) &&
    isNumber(slot.mode) &&
    isNumber(slot.mixLevel) &&
    magnitudeSums &&
    typeof magnitudeSums === "object" &&
    isNumber(magnitudeSums.primary) &&
    isNumber(magnitudeSums.secondary)
  );
}

function isChannelConversionState(state) {
  const slots = state?.slots;
  const mixCode = state?.mixCode;
  return (
    state &&
    typeof state === "object" &&
    Number.isInteger(state.slotLimit) &&
    Array.isArray(slots) &&
    slots.length === AT3_CHCONV_SLOT_COUNT &&
    slots.every(isChannelConversionSlot) &&
    mixCode &&
    typeof mixCode === "object" &&
    isNumber(mixCode.previous) &&
    isNumber(mixCode.current)
  );
}

function isToneBlock(block) {
  return (
    block &&
    typeof block === "object" &&
    block.startIndex instanceof Uint32Array &&
    block.startIndex.length >= AT3ENC_TONE_BLOCK_ENTRIES &&
    block.gainIndex instanceof Uint32Array &&
    block.gainIndex.length >= AT3ENC_TONE_BLOCK_ENTRIES &&
    block.scratchBits instanceof Uint32Array &&
    block.scratchBits.length >= AT3ENC_TONE_BLOCK_SCRATCH_WORDS &&
    isNumber(block.maxBits) &&
    isNumber(block.lastMax) &&
    isNumber(block.entryCount)
  );
}

function isEncoderLayerTones(tones) {
  return (
    tones &&
    typeof tones === "object" &&
    Array.isArray(tones.blocks) &&
    tones.blocks.length === AT3ENC_TONE_BLOCK_COUNT &&
    tones.blocks.every(isToneBlock) &&
    isNumber(tones.previousBlock0EntryCount)
  );
}

function isEncoderLayerWorkspace(workspace) {
  return (
    workspace &&
    typeof workspace === "object" &&
    workspace.transform instanceof Float32Array &&
    workspace.transform.length >= AT3ENC_TRANSFORM_SCRATCH_SAMPLES &&
    workspace.qmfHistory instanceof Float32Array &&
    workspace.qmfHistory.length >= AT3ENC_QMF_HISTORY_SAMPLES
  );
}

function isEncoderLayerState(layer) {
  return (
    layer &&
    typeof layer === "object" &&
    typeof layer.referencesPrimaryShift === "boolean" &&
    Number.isInteger(layer.sfbLimit) &&
    Number.isInteger(layer.shift) &&
    Number.isInteger(layer.workSize) &&
    Number.isInteger(layer.param) &&
    layer.spectrum instanceof Float32Array &&
    layer.spectrum.length >= AT3ENC_LAYER_SPECTRUM_SAMPLES &&
    isEncoderLayerWorkspace(layer.workspace) &&
    isEncoderLayerTones(layer.tones)
  );
}

/**
 * Identifies a reusable raw ATRAC3 algorithm-0 encoder state.
 *
 * Wrapper runtimes keep this object under `runtime.encoderState`, while low-
 * level callers may pass it directly when resuming an existing stream.
 *
 * @param {unknown} state
 * @returns {state is Atrac3Algorithm0EncoderState}
 */
export function isAtrac3Algorithm0EncoderState(state) {
  if (!state || typeof state !== "object") {
    return false;
  }
  if (!Number.isInteger(state.bytesPerLayer) || state.bytesPerLayer <= 0) {
    return false;
  }
  if (!Number.isInteger(state.basePrimaryShift) || state.basePrimaryShift < 0) {
    return false;
  }
  if (!Number.isInteger(state.primaryShiftTarget) || state.primaryShiftTarget < 0) {
    return false;
  }
  if (typeof state.secondaryUsesSwappedTailTransport !== "boolean") {
    return false;
  }
  if (typeof state.usesDbaStereoRebalance !== "boolean") {
    return false;
  }
  if (!isChannelConversionState(state.channelConversion)) {
    return false;
  }

  const { primaryLayer, secondaryLayer, layers, procWords, scratch } = state;
  if (!primaryLayer || !secondaryLayer) {
    return false;
  }
  if (!isEncoderLayerState(primaryLayer) || !isEncoderLayerState(secondaryLayer)) {
    return false;
  }
  if (!Array.isArray(layers) || layers.length !== AT3_ALGORITHM0_LAYER_COUNT) {
    return false;
  }
  if (layers[0] !== primaryLayer || layers[1] !== secondaryLayer) {
    return false;
  }
  if (!(procWords instanceof Uint32Array) || procWords.length < AT3ENC_PROC_WORD_CAPACITY) {
    return false;
  }
  if (
    !(scratch?.fft instanceof Float32Array) ||
    scratch.fft.length < AT3ENC_LAYER_SPECTRUM_SAMPLES
  ) {
    return false;
  }
  if (!(scratch?.qmfCurve instanceof Float32Array) || scratch.qmfCurve.length === 0) {
    return false;
  }

  return true;
}

/**
 * Creates the authored ATRAC3 algorithm-0 encoder runtime and its wrapper
 * handle in one pass from one of the two accepted raw codec request shapes:
 *
 * - a resolved ATRAC3 codec profile
 * - an explicit `mode` / `bitrateKbps` lookup
 *
 * @param {import("./profiles.js").Atrac3CodecProfile | number} profileOrMode
 * @param {number} [bitrateKbps]
 * @returns {Atrac3Algorithm0EncoderHandle}
 */
export function createAtrac3EncoderState(profileOrMode, bitrateKbps) {
  const profile = resolveAtrac3EncoderProfile(profileOrMode, bitrateKbps);

  return {
    mode: profile.mode,
    bitrateKbps: profile.bitrateKbps,
    frameBytes: profile.frameBytes,
    state: createAtrac3Algorithm0RuntimeState(profile),
  };
}
