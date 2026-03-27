import {
  ATRAC3_CHANNEL_MODE_MONO,
  ATRAC3_CHANNEL_MODE_STEREO,
  ATRAC3_TRANSPORT_DIRECT,
  ATRAC3_TRANSPORT_SPECS,
  ATRAC3_TRANSPORT_SWAPPED_TAIL,
} from "./profile-table.js";

const ATRAC3_STEREO_FALLBACK_BITRATE_KBPS = 66;
const ATRAC3_STEREO_FALLBACK_FRAME_BYTES = 192;

/**
 * Decoder-facing ATRAC3 layout for one mono or stereo transport.
 *
 * @typedef {object} Atrac3DecoderLayout
 * @property {number} modeIndex
 * @property {number} bitrateKbps
 * @property {number} frameBytes
 * @property {number} streamChannels
 * @property {string} primaryTransportMode
 * @property {string} secondaryTransportMode
 * @property {number} stepBytes
 */

/**
 * Mono/stereo decoder layouts for one authored ATRAC3 transport row.
 *
 * @typedef {object} Atrac3DecoderLayouts
 * @property {number} bitrateKbps
 * @property {number} frameBytes
 * @property {Atrac3DecoderLayout} mono
 * @property {Atrac3DecoderLayout} stereo
 */

/**
 * Container-derived ATRAC3 metadata used to resolve one decoder layout.
 *
 * @typedef {object} Atrac3DecoderConfig
 * @property {number} [atrac3Flag]
 * @property {number} [channels]
 * @property {number} [bitrateKbps]
 * @property {number} [frameBytes]
 */

/**
 * Builds one decoder-facing ATRAC3 layout.
 *
 * Decoder transport describes how the frame reader reopens the primary and
 * secondary lanes from one container frame. That is intentionally separate
 * from the encoded layer transport metadata in `profile-table.js`: stereo
 * decode always reopens the secondary lane as swapped-tail, even for mode-1
 * profiles whose two encoded layers are both marked direct.
 *
 * @param {number} modeIndex
 * @param {number} bitrateKbps
 * @param {number} frameBytes
 * @param {number} streamChannels
 * @returns {Atrac3DecoderLayout}
 */
function createAtrac3DecoderLayout(modeIndex, bitrateKbps, frameBytes, streamChannels) {
  const isStereo = streamChannels === ATRAC3_CHANNEL_MODE_STEREO;

  return {
    modeIndex,
    bitrateKbps,
    frameBytes,
    streamChannels,
    primaryTransportMode: ATRAC3_TRANSPORT_DIRECT,
    secondaryTransportMode: isStereo ? ATRAC3_TRANSPORT_SWAPPED_TAIL : ATRAC3_TRANSPORT_DIRECT,
    stepBytes: isStereo ? frameBytes : frameBytes / 2,
  };
}

const ATRAC3_DECODER_LAYOUTS = Object.freeze(
  ATRAC3_TRANSPORT_SPECS.map(({ bitrateKbps, frameBytes, monoModeIndex, stereoModeIndex }) => ({
    bitrateKbps,
    frameBytes,
    mono: createAtrac3DecoderLayout(
      monoModeIndex,
      bitrateKbps,
      frameBytes,
      ATRAC3_CHANNEL_MODE_MONO
    ),
    stereo: createAtrac3DecoderLayout(
      stereoModeIndex,
      bitrateKbps,
      frameBytes,
      ATRAC3_CHANNEL_MODE_STEREO
    ),
  }))
);

/**
 * Finds one authored ATRAC3 decoder layout pair by bitrate first and frame
 * size second.
 *
 * @param {number} bitrateKbps
 * @param {number} frameBytes
 * @returns {Atrac3DecoderLayouts | null}
 */
export function findAtrac3DecoderLayouts(bitrateKbps, frameBytes) {
  let frameBytesFallback = null;

  for (const layouts of ATRAC3_DECODER_LAYOUTS) {
    if (layouts.bitrateKbps === bitrateKbps) {
      return layouts;
    }
    if (frameBytesFallback === null && layouts.frameBytes === frameBytes) {
      frameBytesFallback = layouts;
    }
  }

  return frameBytesFallback;
}

/**
 * Resolves the authored ATRAC3 channel mode from container-facing metadata.
 *
 * The authored channel mode comes from `atrac3Flag` when present, then from
 * explicit `channels`, and finally from the historical 66 kbps / 192-byte
 * stereo fallback used by legacy containers.
 *
 * @param {Atrac3DecoderConfig} config
 */
export function resolveAtrac3DecoderChannelMode(config) {
  const { atrac3Flag, bitrateKbps, channels, frameBytes } = config;

  if (Number.isInteger(atrac3Flag)) {
    return atrac3Flag !== 0 ? ATRAC3_CHANNEL_MODE_STEREO : ATRAC3_CHANNEL_MODE_MONO;
  }

  if (channels === ATRAC3_CHANNEL_MODE_MONO || channels === ATRAC3_CHANNEL_MODE_STEREO) {
    return channels;
  }

  if (
    bitrateKbps === ATRAC3_STEREO_FALLBACK_BITRATE_KBPS ||
    frameBytes === ATRAC3_STEREO_FALLBACK_FRAME_BYTES
  ) {
    return ATRAC3_CHANNEL_MODE_STEREO;
  }

  return ATRAC3_CHANNEL_MODE_MONO;
}

/**
 * Resolves one authored ATRAC3 decoder layout from container-facing fields.
 *
 * @param {Atrac3DecoderConfig} config
 * @returns {Atrac3DecoderLayout | null}
 */
export function resolveAtrac3DecoderLayout(config) {
  const { bitrateKbps, frameBytes } = config;
  const streamChannels = resolveAtrac3DecoderChannelMode(config);
  const layouts = findAtrac3DecoderLayouts(bitrateKbps, frameBytes);
  if (layouts === null) {
    return null;
  }

  return streamChannels === ATRAC3_CHANNEL_MODE_STEREO ? layouts.stereo : layouts.mono;
}
