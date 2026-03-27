import { CodecError } from "./errors.js";

/**
 * Computes the shared ATRAC FACT alignment parameter written into authored
 * container metadata.
 *
 * `factBaseDelaySamples` contributes to the initial one-frame lead-in. When a
 * loop end exists, `encoderDelaySamples` participates in the frame-alignment
 * remainder so the authored loop closes on the same delayed sample basis that
 * the decoder later uses.
 */
export function computeAtracEncodeFactParam(
  loopEnd,
  frameSamples,
  factBaseDelaySamples,
  encoderDelaySamples
) {
  const baseFactParam = frameSamples + factBaseDelaySamples;
  if (loopEnd < 0) {
    return baseFactParam >>> 0;
  }

  const loopAlignmentRemainder = (loopEnd + baseFactParam + encoderDelaySamples) % frameSamples;
  const trailingLoopPadSamples = frameSamples - 1 - loopAlignmentRemainder;

  return (baseFactParam + trailingLoopPadSamples) >>> 0;
}

/**
 * Resolves the authored FACT metadata plan from one ATRAC encode profile.
 *
 * This keeps the three delay-related profile fields together with the derived
 * `factParam` and the aligned sample count written into the shared WAV
 * `fact` chunk.
 */
export function resolveAtracEncodeFactPlan(profile, loopEnd = -1) {
  const { frameSamples, encoderDelaySamples, factBaseDelaySamples, factValueDelaySamples } =
    profile ?? {};
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new CodecError("missing frameSamples on ATRAC encode profile");
  }
  if (!Number.isInteger(encoderDelaySamples) || encoderDelaySamples < 0) {
    throw new CodecError("missing encoderDelaySamples on ATRAC encode profile");
  }
  if (!Number.isInteger(factBaseDelaySamples) || factBaseDelaySamples < 0) {
    throw new CodecError("missing factBaseDelaySamples on ATRAC encode profile");
  }
  if (!Number.isInteger(factValueDelaySamples) || factValueDelaySamples < 0) {
    throw new CodecError("missing factValueDelaySamples on ATRAC encode profile");
  }

  const factParam = computeAtracEncodeFactParam(
    loopEnd,
    frameSamples,
    factBaseDelaySamples,
    encoderDelaySamples
  );
  const alignedSampleCount = factParam - factValueDelaySamples;

  return {
    encoderDelaySamples,
    factBaseDelaySamples,
    factValueDelaySamples,
    factParam,
    alignedSampleCount,
  };
}
