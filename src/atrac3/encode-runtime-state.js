import { createChannelConversionState } from "./channel-conversion-analysis.js";
import { AT3_SFB_OFFSETS } from "./encode-tables.js";
import { ATRAC3_TRANSPORT_SWAPPED_TAIL, resolveAtrac3LayerTransportMode } from "./profiles.js";
import { createAt3encQmfCurveTable } from "./qmf.js";

const AT3_ALGORITHM0_LAYER_COUNT = 2;
const AT3ENC_STATE_LAYER_STRIDE_BYTES = 0x2d70;
const AT3ENC_STATE_HEADER_LAYERS_OFFSET_BYTES = 0xc74;
const AT3ENC_PROC_WORD_CAPACITY =
  (AT3ENC_STATE_HEADER_LAYERS_OFFSET_BYTES +
    AT3_ALGORITHM0_LAYER_COUNT * AT3ENC_STATE_LAYER_STRIDE_BYTES) /
  4;
const AT3ENC_PROC_PAIR_BLOCK_COUNT = 4;
const AT3ENC_PROC_PAIR_ENTRIES = 8;
const AT3ENC_PROC_SCRATCH_WORDS = 0x20;
const AT3ENC_FFT_SCRATCH_SAMPLES = 1024;
const AT3ENC_TRANSFORM_SCRATCH_SAMPLES = 1536;
const AT3ENC_QMF_HISTORY_SAMPLES = 0x8a;
const AT3ENC_PRIMARY_SHIFT_BIAS = 0x13;
const AT3ENC_SECONDARY_SHIFT_BIAS = 0x1b;
const AT3ENC_PRIMARY_SHIFT_TARGET_BIAS = 59;

function createToneBlock() {
  return {
    startIndex: new Uint32Array(AT3ENC_PROC_PAIR_ENTRIES),
    gainIndex: new Uint32Array(AT3ENC_PROC_PAIR_ENTRIES),
    scratchBits: new Uint32Array(AT3ENC_PROC_SCRATCH_WORDS),
    maxBits: 0,
    lastMax: 0,
    entryCount: 0,
  };
}

function createEncoderLayerState(layerProfile, sampleRate) {
  const referencesPrimaryShift =
    resolveAtrac3LayerTransportMode(layerProfile) === ATRAC3_TRANSPORT_SWAPPED_TAIL;
  const sfbLimit = layerProfile.sfbLimit;
  const shiftBias = referencesPrimaryShift
    ? AT3ENC_SECONDARY_SHIFT_BIAS
    : AT3ENC_PRIMARY_SHIFT_BIAS;

  return {
    referencesPrimaryShift,
    sfbLimit,
    shift: layerProfile.param * 8 - shiftBias,
    workSize: Math.trunc((sampleRate * AT3_SFB_OFFSETS[sfbLimit]) / 2048),
    param: layerProfile.param,
    spectrum: new Float32Array(1024),
    workspace: {
      transform: new Float32Array(AT3ENC_TRANSFORM_SCRATCH_SAMPLES),
      qmfHistory: new Float32Array(AT3ENC_QMF_HISTORY_SAMPLES),
    },
    tones: {
      // The algorithm-0 tone path carries per-block gain transitions across
      // frames independently from the main spectral workspace.
      blocks: Array.from({ length: AT3ENC_PROC_PAIR_BLOCK_COUNT }, () => createToneBlock()),
      previousBlock0EntryCount: 0,
    },
  };
}

/**
 * Allocates the fixed primary/secondary ATRAC3 algorithm-0 runtime state from
 * a resolved profile.
 *
 * The neighboring `encode-runtime.js` file owns profile lookup, handle
 * creation, and the reusable runtime type guard. This file stays focused on
 * the raw codec state that the encoder mutates frame by frame.
 */
export function createAtrac3Algorithm0RuntimeState(profile) {
  const { frameBytes, sampleRate } = profile;
  const [primaryProfile, secondaryProfile] = profile.layers;
  const secondaryUsesSwappedTailTransport =
    resolveAtrac3LayerTransportMode(secondaryProfile) === ATRAC3_TRANSPORT_SWAPPED_TAIL;
  const channelConversionSlotLimit = secondaryUsesSwappedTailTransport
    ? (secondaryProfile.channelConversionSlotLimit ?? -1)
    : -1;
  const usesDbaStereoRebalance =
    secondaryUsesSwappedTailTransport && channelConversionSlotLimit === 1;
  const primaryLayer = createEncoderLayerState(primaryProfile, sampleRate);
  const secondaryLayer = createEncoderLayerState(secondaryProfile, sampleRate);
  const bytesPerLayer = frameBytes / AT3_ALGORITHM0_LAYER_COUNT;

  return {
    bytesPerLayer,
    basePrimaryShift: primaryLayer.shift,
    primaryShiftTarget: bytesPerLayer * 16 - AT3ENC_PRIMARY_SHIFT_TARGET_BIAS,
    secondaryUsesSwappedTailTransport,
    usesDbaStereoRebalance,
    channelConversion: createChannelConversionState(channelConversionSlotLimit, {
      enabled: secondaryUsesSwappedTailTransport,
    }),
    procWords: new Uint32Array(AT3ENC_PROC_WORD_CAPACITY),
    scratch: {
      fft: new Float32Array(AT3ENC_FFT_SCRATCH_SAMPLES),
      qmfCurve: createAt3encQmfCurveTable(),
    },
    primaryLayer,
    secondaryLayer,
    layers: [primaryLayer, secondaryLayer],
  };
}
