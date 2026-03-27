import { decodeAtrac3PlusFrames } from "./decode-output.js";
import { createAtrac3PlusDecoderState } from "./state.js";

export class Atrac3PlusDecoder {
  /**
   * Creates a reusable ATRAC3plus decoder for one stream configuration.
   *
   * @param {object} config Container-derived ATRAC3plus stream metadata.
   */
  constructor(config) {
    this.config = config;
    this.state = createAtrac3PlusDecoderState(config);
  }

  /**
   * Decodes a sequence of ATRAC3plus frames and trims the codec lead-in samples.
   *
   * The wrapper owns reusable decode state, while optional `fact` trim
   * metadata remains a per-call input that flows straight to the decode-output
   * owner.
   *
   * @param {(ArrayBuffer|ArrayBufferView)[]} frames
   * @param {number | null | undefined} factSamples
   * @param {number[] | null} [factRaw=[]]
   * @returns {{ pcm: Int16Array }}
   */
  decodeFrames(frames, factSamples, factRaw = []) {
    return {
      pcm: decodeAtrac3PlusFrames(this.state, frames, factSamples, factRaw),
    };
  }
}
