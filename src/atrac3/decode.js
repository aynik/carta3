import { CodecError } from "../common/errors.js";
import { decodeAtrac3ChannelTransport } from "./decode-channel.js";
import { AT3_DEC_FLAG_ERROR } from "./decode-channel-transport.js";
import { buildAtrac3StereoPcm, synthesizeAtrac3Channel } from "./decode-synthesis.js";
import { mixAtrac3StereoChannels } from "./decode-stereo.js";
import { ATRAC3_TRANSPORT_SWAPPED_TAIL } from "./profiles.js";

/**
 * Decodes one ATRAC3 frame through lane reopen, swapped-tail stereo mixing,
 * synthesis, and final stereo PCM packing.
 *
 * Each lane rebuilds its overlap/add work area first. Swapped-tail stereo, if
 * active for the secondary lane, mixes those rebuilt work buffers before the
 * synthesis filterbank turns them into the canonical stereo PCM pair returned
 * from this frame-level owner.
 */
function decodeAtrac3FrameWork(state, frame, decodeSecondary = true) {
  state.callCount += 1;
  const bitstream = state.bitstream;
  bitstream.stream = bitstream.baseStream ?? bitstream.stream;
  bitstream.stream.set(frame, 0);
  bitstream.stream.fill(0, frame.length);
  bitstream.flags = 0;

  decodeAtrac3ChannelTransport(state, state.primaryChannel, 0);
  const secondaryTransportMode = state.secondaryChannel.transportMode;
  const decodeSecondaryLane =
    decodeSecondary || secondaryTransportMode === ATRAC3_TRANSPORT_SWAPPED_TAIL;
  const secondaryUnitMode = decodeSecondaryLane
    ? decodeAtrac3ChannelTransport(state, state.secondaryChannel, 1)
    : 0;

  if (
    decodeSecondaryLane &&
    (state.bitstream.flags & AT3_DEC_FLAG_ERROR) === 0 &&
    secondaryTransportMode === ATRAC3_TRANSPORT_SWAPPED_TAIL
  ) {
    // Swapped-tail stereo can only mix after both channels have rebuilt their
    // overlap/add work areas for the current frame.
    mixAtrac3StereoChannels(state, secondaryUnitMode);
  }

  synthesizeAtrac3Channel(state.primaryChannel);
  if (decodeSecondaryLane) {
    synthesizeAtrac3Channel(state.secondaryChannel);
  }

  if (state.bitstream.flags !== 0) {
    throw new CodecError("ATRAC3 frame decode failed");
  }
}

export function decodeAtrac3Frame(
  state,
  frame,
  pcm = null,
  pcmOffset = 0,
  startSample = 0,
  sampleCount = state.frameSamples,
  decodeSecondary = true
) {
  decodeAtrac3FrameWork(state, frame, decodeSecondary);
  return buildAtrac3StereoPcm(
    state.primaryChannel,
    state.secondaryChannel,
    pcm,
    pcmOffset,
    startSample,
    sampleCount
  );
}
