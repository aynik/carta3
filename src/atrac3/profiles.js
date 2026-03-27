import { CodecError } from "../common/errors.js";
import { ATRAC3_FRAME_SAMPLES } from "./constants.js";
import {
  ATRAC3_ALGO0_ENCODE_VARIANT,
  ATRAC3_CHANNEL_MODE_MONO,
  ATRAC3_CHANNEL_MODE_STEREO,
  ATRAC3_SAMPLE_RATE_HZ,
  ATRAC3_SCX_ENCODE_VARIANT,
  ATRAC3_TRANSPORT_DIRECT,
  ATRAC3_TRANSPORT_SWAPPED_TAIL,
} from "./profile-table.js";
import { findAtrac3EncodeProfile } from "./profiles-catalog.js";
export {
  findAtrac3CodecProfile,
  findAtrac3EncodeProfile,
  listAtrac3EncodeProfiles,
} from "./profiles-catalog.js";
export {
  findAtrac3DecoderLayouts,
  resolveAtrac3DecoderChannelMode,
  resolveAtrac3DecoderLayout,
} from "./profiles-layouts.js";

const ATRAC3_STEREO_CHANNELS = 2;
const ATRAC3_SCX_FRAME_BYTES = 384;
export {
  ATRAC3_CHANNEL_MODE_MONO,
  ATRAC3_CHANNEL_MODE_STEREO,
  ATRAC3_TRANSPORT_DIRECT,
  ATRAC3_TRANSPORT_SWAPPED_TAIL,
};

/**
 * Authored ATRAC3 transport profiles.
 *
 * The authored transport rows live in `profile-table.js`, the derived
 * codec-profile catalog lives in `profiles-catalog.js`, and this owner keeps
 * the direct-wrapper policy layered on top of that catalog. Decoder layout
 * lookup now lives in the neighboring
 * `profiles-layouts.js` module and is re-exported from here as part of the
 * stable profile family surface.
 */

export function resolveAtrac3LayerTransportMode(layerLike) {
  if (layerLike?.transportMode === ATRAC3_TRANSPORT_DIRECT) {
    return ATRAC3_TRANSPORT_DIRECT;
  }
  if (layerLike?.transportMode === ATRAC3_TRANSPORT_SWAPPED_TAIL) {
    return ATRAC3_TRANSPORT_SWAPPED_TAIL;
  }
  if (layerLike && "transportMode" in layerLike) {
    throw new CodecError(`invalid ATRAC3 layer transportMode: ${layerLike.transportMode}`);
  }
  return layerLike?.referencesPrimaryShift
    ? ATRAC3_TRANSPORT_SWAPPED_TAIL
    : ATRAC3_TRANSPORT_DIRECT;
}

export function layerUsesAtrac3SwappedTailTransport(layerLike) {
  return resolveAtrac3LayerTransportMode(layerLike) === ATRAC3_TRANSPORT_SWAPPED_TAIL;
}

/**
 * Shared direct-wrapper request resolved from package-level ATRAC profile
 * lookup plus the stricter ATRAC3 stereo 44.1 kHz wrapper boundary.
 *
 * The shared ATRAC encode catalog requires an exact bitrate/channel/sample
 * rate match. The direct wrappers then layer additional restrictions on top
 * of that catalog (for example, the algorithm-0 path only supports stereo
 * 44.1 kHz), so this owner keeps both pieces visible: which ATRAC profile the
 * package-level lookup found and whether it survives the stricter direct-wrapper
 * contract.
 */
export function resolveAtrac3DirectWrapperSetup(
  bitrateKbps,
  channels,
  sampleRate,
  preselectedProfile = null
) {
  const resolvedProfile = preselectedProfile ?? findAtrac3EncodeProfile(bitrateKbps, sampleRate);
  const isDirectWrapperRequest =
    channels === ATRAC3_STEREO_CHANNELS && sampleRate === ATRAC3_SAMPLE_RATE_HZ;
  const wrapperProfile =
    isDirectWrapperRequest &&
    resolvedProfile?.codec === "atrac3" &&
    resolvedProfile.bitrateKbps === bitrateKbps
      ? resolvedProfile
      : null;

  return {
    resolvedProfile,
    wrapperProfile,
  };
}

/**
 * Selects the ATRAC3 algorithm-0 transport exposed by the direct wrapper.
 *
 * The authored ATRAC3 catalog describes more transports than the public
 * algorithm-0 entrypoint accepts, so keep the exact wrapper contract next to
 * the profile table instead of rebuilding it in `src/encoders/atrac3.js`.
 */
export function selectAtrac3Algorithm0EncodeProfile(
  bitrateKbps,
  channels,
  sampleRate,
  preselectedProfile = null
) {
  const { wrapperProfile } = resolveAtrac3DirectWrapperSetup(
    bitrateKbps,
    channels,
    sampleRate,
    preselectedProfile
  );
  if (wrapperProfile?.encodeVariant !== ATRAC3_ALGO0_ENCODE_VARIANT) {
    throw new CodecError(
      `ATRAC3 encoder (algorithm 0) currently supports only ` +
        `66, 105 kbps ${ATRAC3_STEREO_CHANNELS}ch @ ${ATRAC3_SAMPLE_RATE_HZ}Hz`
    );
  }

  return wrapperProfile;
}

/**
 * Selects the fixed 132 kbps ATRAC3 SCX transport exposed by the direct wrapper.
 */
export function selectAtrac3ScxEncodeProfile(
  bitrateKbps,
  channels,
  sampleRate,
  preselectedProfile = null
) {
  const { wrapperProfile } = resolveAtrac3DirectWrapperSetup(
    bitrateKbps,
    channels,
    sampleRate,
    preselectedProfile
  );
  if (
    wrapperProfile?.encodeVariant !== ATRAC3_SCX_ENCODE_VARIANT ||
    wrapperProfile.frameBytes !== ATRAC3_SCX_FRAME_BYTES ||
    wrapperProfile.frameSamples !== ATRAC3_FRAME_SAMPLES
  ) {
    throw new CodecError(
      `ATRAC3 SCX encoder currently supports only ` +
        `132 kbps ${ATRAC3_STEREO_CHANNELS}ch @ ${ATRAC3_SAMPLE_RATE_HZ}Hz`
    );
  }

  return wrapperProfile;
}
