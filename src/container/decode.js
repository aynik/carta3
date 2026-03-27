import { decodeAtrac3Frames } from "../atrac3/decode-output.js";
import { createAtrac3DecoderState } from "../atrac3/decoder-state.js";
import { decodeAtrac3PlusFrames } from "../atrac3plus/decode-output.js";
import { createAtrac3PlusDecoderState } from "../atrac3plus/state.js";
import { CodecError } from "../common/errors.js";
import { createPcmBufferWriter } from "./pcm-writer.js";
import { parseAtracWavBuffer } from "./wav-parse.js";

/**
 * @typedef {import("../public-types.js").DecodedAtracBuffer} DecodedAtracBuffer
 * @typedef {import("../public-types.js").ParsedAtracContainer} ParsedAtracContainer
 */

/**
 * Decodes an already parsed ATRAC WAV container to interleaved PCM16 samples.
 *
 * This stays package-private to the stable container barrels, but it gives the
 * shared codebase one explicit seam between "parse the WAV container" and
 * "decode the ATRAC frames". Because that seam is package-private, it can call
 * codec-owned decode state and decode-output owners directly instead of
 * round-tripping through the public decoder wrapper classes.
 *
 * @param {ParsedAtracContainer} metadata
 * @returns {Int16Array}
 */
export function decodeParsedAtracWav(metadata) {
  switch (metadata.codec) {
    case "atrac3":
      return decodeAtrac3Frames(
        createAtrac3DecoderState(metadata),
        metadata.channels,
        metadata.frames,
        metadata.factSamples,
        metadata.factRaw
      );
    case "atrac3plus":
      return decodeAtrac3PlusFrames(
        createAtrac3PlusDecoderState(metadata),
        metadata.frames,
        metadata.factSamples,
        metadata.factRaw
      );
    default:
      throw new CodecError(`unsupported ATRAC WAV codec: ${metadata.codec}`);
  }
}

/**
 * Builds the shared browser-safe decoded-container result for a parsed ATRAC
 * WAV stream.
 *
 * `pcm-writer.js` owns the PCM16 WAV serialization policy. This owner combines
 * that writer with the parsed ATRAC metadata so browser entrypoints can expose
 * one stable in-memory result shape, and `node.js` can extend the same shape
 * with filesystem writes locally.
 *
 * @param {ParsedAtracContainer} metadata
 * @returns {DecodedAtracBuffer}
 */
export function createDecodedAtracWavResult(metadata) {
  const pcm = decodeParsedAtracWav(metadata);
  const { toPcmWavBuffer } = createPcmBufferWriter(metadata.sampleRate, metadata.channels, pcm);

  return {
    metadata,
    pcm,
    toPcmWavBuffer,
  };
}

/**
 * Decodes an ATRAC WAV buffer straight to PCM while preserving the parsed
 * container metadata alongside the writer result.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {DecodedAtracBuffer}
 */
export function decodeAt3WavBuffer(input) {
  return createDecodedAtracWavResult(parseAtracWavBuffer(input));
}
