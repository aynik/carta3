import { ATRAC3_DELAY_SAMPLES, ATRAC3_FRAME_SAMPLES } from "./constants.js";
import {
  ATRAC3_CHANNEL_MODE_STEREO,
  ATRAC3_SAMPLE_RATE_HZ,
  ATRAC3_TRANSPORT_SPECS,
} from "./profile-table.js";

const ATRAC3_CODEC_NAME = "atrac3";
const ATRAC3_CODEC_KIND = 3;
const ATRAC3_STEREO_CHANNELS = 2;
const ATRAC3_SAMPLE_RATE_INDEX = 1;

/**
 * One encoded ATRAC3 layer inside an authored transport profile.
 *
 * @typedef {object} Atrac3LayerProfile
 * @property {number} param
 * @property {number} sfbLimit
 * @property {string} transportMode
 * @property {number} [channelConversionSlotLimit]
 */

/**
 * One authored ATRAC3 codec profile used by container metadata and encoding.
 *
 * @typedef {object} Atrac3CodecProfile
 * @property {number} bitrateKbps
 * @property {number} frameBytes
 * @property {number} mode
 * @property {number | null} encodeAlgorithm
 * @property {string | null} encodeVariant
 * @property {Atrac3LayerProfile[]} layers
 * @property {number} codecInfo
 * @property {number} atrac3Flag
 * @property {number} encoderDelaySamples
 * @property {number} factBaseDelaySamples
 * @property {number} factValueDelaySamples
 */

const atrac3CodecProfiles = [];
const atrac3EncodeProfiles = [];

for (const transport of ATRAC3_TRANSPORT_SPECS) {
  const authoredProfile = transport.codecProfile;
  if (!authoredProfile) {
    continue;
  }

  const atrac3Flag = Number(authoredProfile.mode === ATRAC3_CHANNEL_MODE_STEREO);
  const profile = {
    codec: ATRAC3_CODEC_NAME,
    codecKind: ATRAC3_CODEC_KIND,
    channels: ATRAC3_STEREO_CHANNELS,
    sampleRate: ATRAC3_SAMPLE_RATE_HZ,
    frameSamples: ATRAC3_FRAME_SAMPLES,
    bitrateKbps: transport.bitrateKbps,
    frameBytes: transport.frameBytes,
    mode: authoredProfile.mode,
    encodeAlgorithm: authoredProfile.encodeAlgorithm ?? null,
    encodeVariant: authoredProfile.encodeVariant ?? null,
    layers: authoredProfile.layers,
    codecInfo:
      ((atrac3Flag << 17) | (ATRAC3_SAMPLE_RATE_INDEX << 13) | (transport.frameBytes >>> 3)) >>> 0,
    atrac3Flag,
    encoderDelaySamples: ATRAC3_DELAY_SAMPLES,
    factBaseDelaySamples: 0,
    factValueDelaySamples: 0,
  };

  atrac3CodecProfiles.push(profile);
  if (profile.encodeVariant !== null) {
    atrac3EncodeProfiles.push(profile);
  }
}

const ATRAC3_CODEC_PROFILES = Object.freeze(atrac3CodecProfiles);
const ATRAC3_ENCODE_PROFILES = Object.freeze(atrac3EncodeProfiles);

/**
 * Finds one authored ATRAC3 codec profile by decoder mode and bitrate.
 *
 * This includes transports that remain decode-only from the package-level
 * encoder perspective.
 *
 * @returns {Atrac3CodecProfile | null}
 */
export function findAtrac3CodecProfile(mode, bitrateKbps) {
  for (const profile of ATRAC3_CODEC_PROFILES) {
    if (profile.mode === mode && profile.bitrateKbps === bitrateKbps) {
      return profile;
    }
  }

  return null;
}

/**
 * Finds one public ATRAC3 encode profile for the supported sample rate.
 *
 * @returns {Atrac3CodecProfile | null}
 */
export function findAtrac3EncodeProfile(bitrateKbps, sampleRate) {
  if (sampleRate !== ATRAC3_SAMPLE_RATE_HZ) {
    return null;
  }

  for (const profile of ATRAC3_ENCODE_PROFILES) {
    if (profile.bitrateKbps === bitrateKbps) {
      return profile;
    }
  }

  return null;
}

export function listAtrac3EncodeProfiles() {
  return ATRAC3_ENCODE_PROFILES.slice();
}
