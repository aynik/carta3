import { listAtrac3EncodeProfiles } from "../atrac3/profiles.js";
import { listAtrac3plusEncodeProfiles } from "../atrac3plus/profiles.js";

const ATRAC_ENCODE_PROFILES = Object.freeze([
  ...listAtrac3EncodeProfiles(),
  ...listAtrac3plusEncodeProfiles(),
]);

function cloneAtracEncodeProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }

  const clone = { ...profile };

  if (Array.isArray(profile.layers)) {
    clone.layers = profile.layers.map((layer) =>
      layer && typeof layer === "object" ? { ...layer } : layer
    );
  }

  const codecBytes = profile.atracxCodecBytes;
  if (codecBytes instanceof Uint8Array) {
    clone.atracxCodecBytes = Uint8Array.from(codecBytes);
  }

  return clone;
}

/**
 * Finds one ATRAC encode profile in the shared package-level catalog.
 *
 * The authored package catalog is small enough that one direct pass can keep
 * the public selection rule explicit: return the first exact
 * sample-rate/channel/bitrate match.
 */
export function findAtracEncodeProfile(bitrateKbps, channels, sampleRate) {
  for (const profile of ATRAC_ENCODE_PROFILES) {
    const matchesBitrateAndSampleRate =
      profile.bitrateKbps === bitrateKbps && profile.sampleRate === sampleRate;
    if (!matchesBitrateAndSampleRate) {
      continue;
    }

    if (profile.channels === channels) {
      return cloneAtracEncodeProfile(profile);
    }
  }

  return null;
}

/**
 * Lists unique ATRAC encode profiles known by the authored ATRAC3 preset
 * catalog and the embedded ATRAC3plus table.
 */
export function listAtracEncodeProfiles() {
  return ATRAC_ENCODE_PROFILES.map(cloneAtracEncodeProfile);
}
