import type { Atrac3DecoderConfig, BinaryInput, DecodeFrameResult } from "../public-types.js";

/**
 * Stable ATRAC3 package declarations.
 */
export class Atrac3Decoder {
  constructor(config: Atrac3DecoderConfig);
  readonly config: Atrac3DecoderConfig;
  readonly state: unknown;
  decodeFrames(
    frames: BinaryInput[],
    factSamples?: number | null,
    factRaw?: number[] | null
  ): DecodeFrameResult;
}

export function createAtrac3DecoderState(config: Atrac3DecoderConfig): unknown;
