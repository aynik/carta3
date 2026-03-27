export const ATRAC3_SAMPLE_RATE_HZ = 44100;
export const ATRAC3_ALGO0_ENCODE_VARIANT = "atrac3-algorithm0";
export const ATRAC3_SCX_ENCODE_VARIANT = "atrac3-scx";
export const ATRAC3_CHANNEL_MODE_MONO = 1;
export const ATRAC3_CHANNEL_MODE_STEREO = 2;
export const ATRAC3_TRANSPORT_DIRECT = "direct";
export const ATRAC3_TRANSPORT_SWAPPED_TAIL = "swapped-tail";

/**
 * Authored ATRAC3 transport catalog rows.
 *
 * This file keeps the bitrate/frame transport table separate from the derived
 * profile lookup and direct-wrapper policy in `profiles.js`. The rows stay as
 * readable authored objects because ATRAC3 has only a handful of transports,
 * and the layer descriptors are part of the codec story. When a row also owns
 * enough metadata to become a container/encode-facing ATRAC3 codec profile,
 * that metadata stays under `codecProfile`. The
 * `layers[].transportMode` values describe how each encoded layer is packed;
 * decoder channel reopening is a separate concern owned by
 * `profiles-layouts.js`.
 */
export const ATRAC3_TRANSPORT_SPECS = Object.freeze([
  {
    bitrateKbps: 33,
    frameBytes: 96,
    monoModeIndex: 8,
    stereoModeIndex: 0,
  },
  {
    bitrateKbps: 47,
    frameBytes: 136,
    monoModeIndex: 9,
    stereoModeIndex: 1,
  },
  {
    bitrateKbps: 66,
    frameBytes: 192,
    monoModeIndex: 10,
    stereoModeIndex: 2,
    codecProfile: {
      mode: 2,
      encodeAlgorithm: 0,
      encodeVariant: ATRAC3_ALGO0_ENCODE_VARIANT,
      layers: [
        { param: 144, sfbLimit: 27, transportMode: ATRAC3_TRANSPORT_DIRECT },
        {
          param: 48,
          sfbLimit: 12,
          transportMode: ATRAC3_TRANSPORT_SWAPPED_TAIL,
          channelConversionSlotLimit: 1,
        },
      ],
    },
  },
  {
    bitrateKbps: 94,
    frameBytes: 272,
    monoModeIndex: 11,
    stereoModeIndex: 3,
    codecProfile: {
      mode: 2,
      layers: [
        { param: 186, sfbLimit: 28, transportMode: ATRAC3_TRANSPORT_DIRECT },
        {
          param: 86,
          sfbLimit: 21,
          transportMode: ATRAC3_TRANSPORT_SWAPPED_TAIL,
          channelConversionSlotLimit: 2,
        },
      ],
    },
  },
  {
    bitrateKbps: 105,
    frameBytes: 304,
    monoModeIndex: 4,
    stereoModeIndex: 12,
    codecProfile: {
      mode: 1,
      encodeAlgorithm: 0,
      encodeVariant: ATRAC3_ALGO0_ENCODE_VARIANT,
      layers: [
        { param: 152, sfbLimit: 28, transportMode: ATRAC3_TRANSPORT_DIRECT },
        { param: 152, sfbLimit: 28, transportMode: ATRAC3_TRANSPORT_DIRECT },
      ],
    },
  },
  {
    bitrateKbps: 132,
    frameBytes: 384,
    monoModeIndex: 5,
    stereoModeIndex: 13,
    codecProfile: {
      mode: 1,
      encodeAlgorithm: 1,
      encodeVariant: ATRAC3_SCX_ENCODE_VARIANT,
      layers: [
        { param: 192, sfbLimit: 30, transportMode: ATRAC3_TRANSPORT_DIRECT },
        { param: 192, sfbLimit: 30, transportMode: ATRAC3_TRANSPORT_DIRECT },
      ],
    },
  },
  {
    bitrateKbps: 146,
    frameBytes: 424,
    monoModeIndex: 6,
    stereoModeIndex: 14,
    codecProfile: {
      mode: 1,
      layers: [
        { param: 212, sfbLimit: 30, transportMode: ATRAC3_TRANSPORT_DIRECT },
        { param: 212, sfbLimit: 30, transportMode: ATRAC3_TRANSPORT_DIRECT },
      ],
    },
  },
  {
    bitrateKbps: 176,
    frameBytes: 512,
    monoModeIndex: 7,
    stereoModeIndex: 15,
    codecProfile: {
      mode: 1,
      layers: [
        { param: 256, sfbLimit: 31, transportMode: ATRAC3_TRANSPORT_DIRECT },
        { param: 256, sfbLimit: 31, transportMode: ATRAC3_TRANSPORT_DIRECT },
      ],
    },
  },
]);
