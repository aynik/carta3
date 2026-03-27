import { CodecError } from "../common/errors.js";
import {
  AT3_DEC_MAX_UNITS,
  AT3_DEC_NEUTRAL_GAIN,
  AT3_DEC_PAIR_ENTRIES_PER_UNIT,
  AT3_DEC_PAIR_SENTINEL_START,
  AT3_DEC_SPECTRUM_FLOATS_PER_UNIT,
  AT3_DEC_WORK_FLOATS,
  ATRAC3_FRAME_SAMPLES,
} from "./constants.js";
import { resolveAtrac3DecoderChannelMode, resolveAtrac3DecoderLayout } from "./profiles-layouts.js";

const AT3_DECODER_UNIT_MODE_DEFAULT = 4;
const AT3_DECODER_DEFAULT_GAIN_SCALE_SEL = 3;

/**
 * One gain-control pair entry used while rebuilding an ATRAC3 block.
 *
 * @typedef {object} Atrac3GainPairEntry
 * @property {number} start
 * @property {number} gain
 */

/**
 * One gain-table phase for all four ATRAC3 blocks in one channel.
 *
 * @typedef {Atrac3GainPairEntry[][]} Atrac3GainTablePhase
 */

/**
 * Mutable ATRAC3 channel runtime rebuilt frame-by-frame by the decoder pair.
 *
 * @typedef {object} Atrac3DecoderChannelState
 * @property {string} transportMode
 * @property {number} prevBlockCount Number of 256-coefficient transform
 *   blocks rebuilt on the previous frame and therefore still carried by the
 *   next overlap/add span when the current payload shrinks.
 * @property {Float32Array} workF32
 * @property {Float32Array[]} spectrumHistory
 * @property {{ active: Atrac3GainTablePhase, staged: Atrac3GainTablePhase }} gainTables
 */

/**
 * One swapped-tail stereo mix phase carried across frame boundaries.
 *
 * @typedef {object} Atrac3StereoMixPhase
 * @property {number} unitMode
 * @property {number} pairScaleIndex
 * @property {number[]} gainSelectors
 */

/**
 * ATRAC3 frame bitstream view reused across decodes.
 *
 * @typedef {object} Atrac3FrameBitstreamState
 * @property {number} stepBytes
 * @property {Uint8Array} stream
 * @property {number} bitpos
 * @property {number} flags
 */

/**
 * Mutable ATRAC3 decoder runtime.
 *
 * The decoder always works on one authored primary/secondary channel pair,
 * while `channelStates` keeps the same pair in indexed form for low-level
 * tooling that still studies the decoder through the older array view.
 *
 * @typedef {object} Atrac3DecoderState
 * @property {number} callCount
 * @property {number} modeIndex
 * @property {number} bitrateKbps
 * @property {number} streamChannels
 * @property {number} frameBytes
 * @property {number} frameSamples
 * @property {Float32Array} spectrumScratch
 * @property {{ source: Atrac3StereoMixPhase, target: Atrac3StereoMixPhase }} stereoMix
 * @property {Atrac3FrameBitstreamState} bitstream
 * @property {Atrac3DecoderChannelState} primaryChannel
 * @property {Atrac3DecoderChannelState} secondaryChannel
 * @property {Atrac3DecoderChannelState[]} channelStates
 */

function createGainTablePhase() {
  return Array.from({ length: AT3_DEC_MAX_UNITS }, () =>
    Array.from({ length: AT3_DEC_PAIR_ENTRIES_PER_UNIT }, (_, pairIndex) => ({
      start: pairIndex === 0 ? AT3_DEC_PAIR_SENTINEL_START : 0,
      gain: pairIndex === 0 ? AT3_DEC_NEUTRAL_GAIN : 0,
    }))
  );
}

function createSpectrumHistory() {
  return Array.from(
    { length: AT3_DEC_MAX_UNITS },
    () => new Float32Array(AT3_DEC_SPECTRUM_FLOATS_PER_UNIT)
  );
}

/**
 * Builds one mutable ATRAC3 decoder channel lane.
 *
 * This owns the per-channel work area, spectrum history, and the active/staged
 * gain ramps that the frame decoder swaps after reconstruction.
 *
 * @param {string} transportMode
 * @returns {Atrac3DecoderChannelState}
 */
export function createAtrac3DecoderChannelState(transportMode) {
  return {
    transportMode,
    prevBlockCount: 0,
    workF32: new Float32Array(AT3_DEC_WORK_FLOATS),
    spectrumHistory: createSpectrumHistory(),
    gainTables: {
      active: createGainTablePhase(),
      staged: createGainTablePhase(),
    },
  };
}

function createAtrac3StereoMixPhase() {
  return {
    unitMode: AT3_DECODER_UNIT_MODE_DEFAULT,
    pairScaleIndex: 0,
    gainSelectors: Array(AT3_DEC_MAX_UNITS).fill(AT3_DECODER_DEFAULT_GAIN_SCALE_SEL),
  };
}

/**
 * Builds the swapped-tail stereo mix state carried across frame boundaries.
 *
 * @returns {{ source: Atrac3StereoMixPhase, target: Atrac3StereoMixPhase }}
 */
export function createAtrac3StereoMixState() {
  return {
    source: createAtrac3StereoMixPhase(),
    target: createAtrac3StereoMixPhase(),
  };
}

/**
 * Builds the reusable frame bitstream view for one authored ATRAC3 layout.
 *
 * @param {number} frameBytes
 * @param {number} stepBytes
 * @returns {Atrac3FrameBitstreamState}
 */
export function createAtrac3FrameBitstreamState(frameBytes, stepBytes) {
  const baseStream = new Uint8Array(frameBytes + 4);
  const swappedStream = new Uint8Array(frameBytes + 4);

  return {
    stepBytes,
    stream: baseStream,
    baseStream,
    swappedStream,
    bitpos: 0,
    flags: 0,
  };
}

/**
 * Builds the mutable runtime state used by the ATRAC3 frame decoder.
 *
 * The neighboring `decoder.js` file owns the reusable public wrapper and
 * re-exports this state family as part of the stable decoder surface. This
 * file stays focused on raw channel, stereo-mix, and bitstream state
 * allocation.
 *
 * @param {object} config Container-derived ATRAC3 stream metadata.
 * @returns {Atrac3DecoderState}
 */
export function createAtrac3DecoderState(config) {
  if (!config || typeof config !== "object") {
    throw new CodecError("config must be an object");
  }

  const { bitrateKbps, frameBytes } = config;
  const layout = resolveAtrac3DecoderLayout(config);
  if (!layout) {
    throw new CodecError(
      `unsupported ATRAC3 mode: ` +
        `mode=${resolveAtrac3DecoderChannelMode(config)} ` +
        `br=${bitrateKbps} frameBytes=${frameBytes}`
    );
  }

  const streamChannels = layout.streamChannels;
  const primaryChannel = createAtrac3DecoderChannelState(layout.primaryTransportMode);
  const secondaryChannel = createAtrac3DecoderChannelState(layout.secondaryTransportMode);
  const channelStates = [primaryChannel, secondaryChannel];

  return {
    callCount: 0,
    modeIndex: layout.modeIndex,
    bitrateKbps: layout.bitrateKbps,
    // `streamChannels` tracks the resolved authored ATRAC3 layout. Low-level
    // frame decode still rebuilds two PCM lanes and leaves mono/stereo
    // projection to the higher-level decoder wrapper.
    streamChannels,
    frameBytes: layout.frameBytes,
    frameSamples: ATRAC3_FRAME_SAMPLES,
    spectrumScratch: new Float32Array(ATRAC3_FRAME_SAMPLES),
    bitstream: createAtrac3FrameBitstreamState(layout.frameBytes, layout.stepBytes),
    stereoMix: createAtrac3StereoMixState(),
    primaryChannel,
    secondaryChannel,
    channelStates,
  };
}
