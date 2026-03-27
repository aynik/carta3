import { CodecError } from "../common/errors.js";
import { buildAtrac3plusCodecConfig } from "./encode-handle.js";
import { ATRAC3PLUS_TRANSPORT_ROWS } from "./profile-table.js";
import { ATRAC3PLUS_DELAY_SAMPLES, ATRAC3PLUS_FRAME_SAMPLES } from "./constants.js";

const ATRAC3PLUS_CODEC_KIND = 5;
export { ATRAC3PLUS_DELAY_SAMPLES, ATRAC3PLUS_FRAME_SAMPLES };
const ATRAC3PLUS_VARIANT = "atrac3plus";
const ATRAC3PLUS_PROFILE_ENTRY_SIZE = 4;
const ATRAC3PLUS_CODEC_INFO_PREFIX = 1 << 24;
const SAMPLE_RATE_INDEX_BY_HZ = Object.freeze({
  32000: 0,
  44100: 1,
  48000: 2,
});

const ATRAC3PLUS_CHANNEL_LAYOUTS = Object.freeze([
  Object.freeze({ channels: 1, mode: 1, mask: 0x4 }),
  Object.freeze({ channels: 2, mode: 2, mask: 0x3 }),
  Object.freeze({ channels: 6, mode: 5, mask: 0x3f }),
  Object.freeze({ channels: 8, mode: 7, mask: 0x63f }),
]);
const ATRAC3PLUS_CHANNEL_LAYOUT_BY_COUNT = new Map(
  ATRAC3PLUS_CHANNEL_LAYOUTS.map((layout) => [layout.channels, layout])
);
const ATRAC3PLUS_CHANNEL_LAYOUT_BY_MODE = new Map(
  ATRAC3PLUS_CHANNEL_LAYOUTS.map((layout) => [layout.mode, layout])
);

/**
 * ATRAC3plus transport catalog used by shared encode profile lookup and WAV
 * packaging. Keeping the channel layouts and supported encode rows here keeps
 * container code from rebuilding codec knowledge out of raw tables.
 */

function sampleRateIndexFor(sampleRate) {
  return SAMPLE_RATE_INDEX_BY_HZ[sampleRate];
}

function atrac3PlusCodecInfoFromBytes(codecBytes) {
  return (
    (ATRAC3PLUS_CODEC_INFO_PREFIX | ((codecBytes[0] << 8) >>> 0) | (codecBytes[1] >>> 0)) >>> 0
  );
}

function createAtrac3plusEncodeProfile(row) {
  const [bitrateKbps, frameBytes, sampleRate, mode] = row;
  const channelLayout = ATRAC3PLUS_CHANNEL_LAYOUT_BY_MODE.get(mode);
  if (!channelLayout || sampleRateIndexFor(sampleRate) === undefined) {
    return null;
  }

  const codecBytes = buildAtrac3plusCodecConfig(sampleRate, mode, frameBytes);

  return {
    codec: "atrac3plus",
    codecKind: ATRAC3PLUS_CODEC_KIND,
    bitrateKbps,
    channels: channelLayout.channels,
    sampleRate,
    frameSamples: ATRAC3PLUS_FRAME_SAMPLES,
    frameBytes,
    codecInfo: atrac3PlusCodecInfoFromBytes(codecBytes),
    encodeAlgorithm: 1,
    encodeVariant: ATRAC3PLUS_VARIANT,
    mode,
    channelMask: channelLayout.mask,
    atracxCodecBytes: codecBytes,
    encoderDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factBaseDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factValueDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
  };
}

function buildAtrac3plusEncodeProfiles() {
  const profiles = [];

  for (
    let offset = 0;
    offset < ATRAC3PLUS_TRANSPORT_ROWS.length;
    offset += ATRAC3PLUS_PROFILE_ENTRY_SIZE
  ) {
    const profile = createAtrac3plusEncodeProfile(
      ATRAC3PLUS_TRANSPORT_ROWS.subarray(offset, offset + ATRAC3PLUS_PROFILE_ENTRY_SIZE)
    );
    if (profile) {
      profiles.push(profile);
    }
  }

  return Object.freeze(profiles);
}

function createProfileLookup(profiles) {
  const sampleRateLookup = new Map();

  for (const profile of profiles) {
    let channelLookup = sampleRateLookup.get(profile.sampleRate);
    if (!channelLookup) {
      channelLookup = new Map();
      sampleRateLookup.set(profile.sampleRate, channelLookup);
    }

    let bitrateLookup = channelLookup.get(profile.channels);
    if (!bitrateLookup) {
      bitrateLookup = new Map();
      channelLookup.set(profile.channels, bitrateLookup);
    }

    bitrateLookup.set(profile.bitrateKbps, profile);
  }

  return sampleRateLookup;
}

export function atrac3plusModeForChannelCount(channels) {
  return ATRAC3PLUS_CHANNEL_LAYOUT_BY_COUNT.get(channels)?.mode ?? null;
}

export function atrac3plusChannelCountForMode(mode) {
  return ATRAC3PLUS_CHANNEL_LAYOUT_BY_MODE.get(mode)?.channels ?? null;
}

export function atrac3plusChannelMaskForChannelCount(channels) {
  return ATRAC3PLUS_CHANNEL_LAYOUT_BY_COUNT.get(channels)?.mask ?? null;
}

export const ATRAC3PLUS_ENCODE_PROFILES = buildAtrac3plusEncodeProfiles();
const ATRAC3PLUS_PROFILE_LOOKUP = createProfileLookup(ATRAC3PLUS_ENCODE_PROFILES);

export function findAtrac3plusEncodeProfile(bitrateKbps, channels, sampleRate) {
  return ATRAC3PLUS_PROFILE_LOOKUP.get(sampleRate)?.get(channels)?.get(bitrateKbps) ?? null;
}

/**
 * Selects one authored ATRAC3plus transport for the direct wrapper surface.
 *
 * The direct wrapper accepts either a preselected shared ATRAC profile or an
 * exact ATRAC3plus bitrate/channel/sample-rate request; any cross-codec or
 * unsupported request fails here instead of being revalidated in the wrapper.
 */
export function selectAtrac3plusEncodeProfile(
  bitrateKbps,
  channels,
  sampleRate,
  preselectedProfile = null
) {
  const profile =
    preselectedProfile ?? findAtrac3plusEncodeProfile(bitrateKbps, channels, sampleRate);

  if (
    profile?.codec === ATRAC3PLUS_VARIANT &&
    profile.bitrateKbps === bitrateKbps &&
    profile.channels === channels &&
    profile.sampleRate === sampleRate
  ) {
    return profile;
  }

  throw new CodecError(
    `ATRAC3plus profile mismatch: bitrate=${bitrateKbps} channels=${channels} sampleRate=${sampleRate}`
  );
}

export function listAtrac3plusEncodeProfiles() {
  return ATRAC3PLUS_ENCODE_PROFILES.slice();
}
