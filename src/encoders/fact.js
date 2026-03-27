import { CodecError } from "../common/errors.js";
import { ATRAC3_DELAY_SAMPLES } from "../atrac3/constants.js";
import { ATRAC3PLUS_DELAY_SAMPLES } from "../atrac3plus/profiles.js";

export { ATRAC3_DELAY_SAMPLES };
export { ATRAC3PLUS_DELAY_SAMPLES };

/** Shared package-level ATRAC encoder delay and FACT metadata helpers. */

export function atracEncoderDelaySamples(codecOrProfile) {
  const profileDelay = codecOrProfile?.encoderDelaySamples;
  if (Number.isInteger(profileDelay) && profileDelay >= 0) {
    return profileDelay;
  }

  const codec = typeof codecOrProfile === "string" ? codecOrProfile : codecOrProfile?.codec;
  switch (codec) {
    case "atrac3":
      return ATRAC3_DELAY_SAMPLES;
    case "atrac3plus":
      return ATRAC3PLUS_DELAY_SAMPLES;
    default:
      throw new CodecError(`unsupported ATRAC codec: ${codec}`);
  }
}

export { computeAtracEncodeFactParam, resolveAtracEncodeFactPlan } from "../common/atrac-fact.js";
