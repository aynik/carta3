import { ATRAC3_FRAME_SAMPLES, ATRAC3_RESIDUAL_DELAY_SAMPLES } from "./constants.js";
import { markAtrac3DecodeError } from "./decode-channel-transport.js";
import { AT3_DEC_GAIN_SCALE_TABLE, AT3_DEC_PAIR_SCALE_TABLE } from "./decode-tables.js";

const AT3_DEC_MIX_STRIDE = 4;
const AT3_DEC_MIX_BAND_COUNT = 4;
const AT3_DEC_MIX_GROUPS = 0xf8;
const AT3_DEC_MIX_TRANSITION_GROUPS = 8;
const AT3_DEC_MIX_TRANSITION_RATIO = 1 / AT3_DEC_MIX_TRANSITION_GROUPS;
const AT3_DEC_PAIR_SCALE_IDENTITY = 2;
const AT3_DEC_WORK_FLOATS = ATRAC3_FRAME_SAMPLES + ATRAC3_RESIDUAL_DELAY_SAMPLES;
const AT3_DEC_MIX_OFFSET = AT3_DEC_WORK_FLOATS - AT3_DEC_MIX_GROUPS * AT3_DEC_MIX_STRIDE;
const AT3_DEC_MIX_TRANSITION_START =
  AT3_DEC_MIX_OFFSET - AT3_DEC_MIX_TRANSITION_GROUPS * AT3_DEC_MIX_STRIDE;
const AT3_DEC_INVALID_GAIN_SELECTOR = 2;

/**
 * Rolls the swapped-tail ATRAC3 stereo header into the next target mix phase.
 *
 * The current target phase becomes the just-applied source phase, then the
 * newly parsed header stages the mix settings that will apply after the next
 * overlap/add rebuild.
 */
export function rollAtrac3StereoMixHeader(state, unitMode, markError = markAtrac3DecodeError) {
  [state.stereoMix.source, state.stereoMix.target] = [
    state.stereoMix.target,
    state.stereoMix.source,
  ];
  const nextTargetPhase = state.stereoMix.target;
  nextTargetPhase.unitMode = unitMode;

  const firstByte = state.bitstream.stream[0];
  nextTargetPhase.pairScaleIndex = (firstByte >> 4) * 2;

  let headerSelectors = (((firstByte << 8) | state.bitstream.stream[1]) >>> 4) >>> 0;
  for (let band = AT3_DEC_MIX_BAND_COUNT - 1; band >= 0; band -= 1) {
    const selector = headerSelectors & 3;
    if (selector === AT3_DEC_INVALID_GAIN_SELECTOR) {
      markError(state, `gain-sel band=${band}`);
      break;
    }

    headerSelectors >>>= 2;
    nextTargetPhase.gainSelectors[band] = selector;
  }
}

function resolveAtrac3StereoPairScale(unitMode, pairScaleIndex, band, offset) {
  return unitMode < band
    ? AT3_DEC_PAIR_SCALE_TABLE[pairScaleIndex + offset]
    : AT3_DEC_PAIR_SCALE_IDENTITY;
}

function mixAtrac3StereoBand(leftWork, rightWork, band, sourcePhase, targetPhase) {
  const sourceGainSelector = sourcePhase.gainSelectors[band] | 0;
  const sourceUnitMode = sourcePhase.unitMode | 0;
  const sourcePairScaleIndex = sourcePhase.pairScaleIndex | 0;
  const sourceGainLeft = AT3_DEC_GAIN_SCALE_TABLE[sourceGainSelector];
  const sourceGainRight = AT3_DEC_GAIN_SCALE_TABLE[sourceGainSelector + 1];
  const sourcePairLeft = resolveAtrac3StereoPairScale(
    sourceUnitMode,
    sourcePairScaleIndex,
    band,
    0
  );
  const sourcePairRight = resolveAtrac3StereoPairScale(
    sourceUnitMode,
    sourcePairScaleIndex,
    band,
    1
  );
  const targetGainSelector = targetPhase.gainSelectors[band] | 0;
  const targetUnitMode = targetPhase.unitMode | 0;
  const targetPairScaleIndex = targetPhase.pairScaleIndex | 0;
  const targetGainLeft = AT3_DEC_GAIN_SCALE_TABLE[targetGainSelector];
  const targetGainRight = AT3_DEC_GAIN_SCALE_TABLE[targetGainSelector + 1];
  const targetPairLeft = resolveAtrac3StereoPairScale(
    targetUnitMode,
    targetPairScaleIndex,
    band,
    0
  );
  const targetPairRight = resolveAtrac3StereoPairScale(
    targetUnitMode,
    targetPairScaleIndex,
    band,
    1
  );
  const hasLeadInTransition =
    sourceGainSelector !== targetGainSelector ||
    (!Number.isNaN(sourcePairLeft) &&
      !Number.isNaN(targetPairLeft) &&
      sourcePairLeft !== targetPairLeft);
  let sampleIndex = AT3_DEC_MIX_TRANSITION_START + band;
  if (hasLeadInTransition) {
    const gainLeftDelta = targetGainLeft - sourceGainLeft;
    const gainRightDelta = targetGainRight - sourceGainRight;
    const pairLeftDelta = targetPairLeft - sourcePairLeft;
    const pairRightDelta = targetPairRight - sourcePairRight;

    for (
      let transitionStep = 0;
      transitionStep < AT3_DEC_MIX_TRANSITION_GROUPS;
      transitionStep += 1, sampleIndex += AT3_DEC_MIX_STRIDE
    ) {
      const leadInWeight =
        (transitionStep - AT3_DEC_MIX_TRANSITION_GROUPS) * AT3_DEC_MIX_TRANSITION_RATIO;
      const leftSample = leftWork[sampleIndex];
      const mixedSample =
        (leadInWeight * gainLeftDelta + targetGainLeft) * leftSample +
        (targetGainRight + gainRightDelta * leadInWeight) * rightWork[sampleIndex];

      leftWork[sampleIndex] = (leadInWeight * pairLeftDelta + targetPairLeft) * mixedSample;
      rightWork[sampleIndex] =
        (leftSample - mixedSample) * (leadInWeight * pairRightDelta + targetPairRight);
    }
  }

  for (; sampleIndex < AT3_DEC_WORK_FLOATS; sampleIndex += AT3_DEC_MIX_STRIDE) {
    const leftSample = leftWork[sampleIndex];
    const mixedSample = targetGainLeft * leftSample + targetGainRight * rightWork[sampleIndex];
    leftWork[sampleIndex] = mixedSample * targetPairLeft;
    rightWork[sampleIndex] = (leftSample - mixedSample) * targetPairRight;
  }
}

/** Applies the swapped-tail ATRAC3 stereo mix to the rebuilt overlap/add work areas. */
export function mixAtrac3StereoChannels(state, unitMode, markError = markAtrac3DecodeError) {
  const { source: sourcePhase, target: targetPhase } = state.stereoMix;
  const leftWork = state.primaryChannel.workF32;
  const rightWork = state.secondaryChannel.workF32;

  // Swapped stereo transport applies the already-rolled source/target mix
  // state, then interpolates any changed band scales across the lead-in and
  // finally applies the steady mix for the rest of the overlap/add work.
  // Only after that can the just-read header roll into the target slot for the
  // frame after the current overlap/add mix finishes.
  for (let band = 0; band < AT3_DEC_MIX_BAND_COUNT; band += 1) {
    mixAtrac3StereoBand(leftWork, rightWork, band, sourcePhase, targetPhase);
  }

  rollAtrac3StereoMixHeader(state, unitMode, markError);
}
