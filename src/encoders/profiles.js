import { CodecError } from "../common/errors.js";
export { roundDivU32 } from "../common/math.js";
import { findAtracEncodeProfile } from "./profiles-catalog.js";
export { findAtracEncodeProfile, listAtracEncodeProfiles } from "./profiles-catalog.js";
export {
  atrac3plusChannelCountForMode as atxChannelCountForMode,
  atrac3plusChannelMaskForChannelCount as atxChannelMaskForChannelCount,
  atrac3plusModeForChannelCount as atxModeForChannelCount,
} from "../atrac3plus/profiles.js";

/**
 * Selects one authored ATRAC encode profile and optionally validates a
 * package-level requested codec string against the resolved profile.
 */
export function selectAtracEncodeProfile(bitrateKbps, channels, sampleRate, requestedCodec = null) {
  const profile = findAtracEncodeProfile(bitrateKbps, channels, sampleRate);
  if (!profile) {
    throw new CodecError(
      `unsupported ATRAC encode profile: bitrate=${bitrateKbps}kbps channels=${channels} sampleRate=${sampleRate}`
    );
  }

  const requestedProfileCodec = requestedCodec == null ? null : String(requestedCodec);
  if (requestedProfileCodec !== null && requestedProfileCodec !== profile.codec) {
    throw new CodecError(
      `requested codec=${requestedProfileCodec} does not match selected profile codec=${profile.codec}`
    );
  }

  return profile;
}
