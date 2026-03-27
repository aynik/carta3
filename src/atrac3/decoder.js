import { decodeAtrac3Frames } from "./decode-output.js";
import { createAtrac3DecoderState } from "./decoder-state.js";

export class Atrac3Decoder {
  /**
   * Creates a reusable ATRAC3 decoder for one stream configuration.
   *
   * `config.channels` stays live across decode calls so callers can keep one
   * decoder state while switching the public mono/stereo projection policy.
   * The authored transport layout still resolves from the container-facing
   * bitrate, frame size, and optional `atrac3Flag`.
   *
   * @param {object} config Container-derived ATRAC3 stream metadata.
   */
  constructor(config) {
    this.config = config;
    this.state = createAtrac3DecoderState(config);
  }

  /**
   * Decodes a sequence of ATRAC3 frames and trims the codec lead-in samples.
   *
   * The wrapper keeps reusable stream layout on `config`, but `fact` trim
   * metadata stays per decode call so callers can replay the same state against
   * different container metadata when needed.
   *
   * @param {(ArrayBuffer|ArrayBufferView)[]} frames
   * @param {number | null | undefined} factSamples
   * @param {number[] | null} [factRaw=[]]
   * @returns {{ pcm: Int16Array }}
   */
  decodeFrames(frames, factSamples, factRaw = []) {
    const requestedChannels = this.config?.channels;

    return {
      pcm: decodeAtrac3Frames(this.state, requestedChannels, frames, factSamples, factRaw),
    };
  }
}
