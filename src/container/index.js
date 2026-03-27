/**
 * Browser-safe container public surface.
 *
 * This barrel exposes the WAV parsing and in-memory PCM writer helpers that do
 * not depend on Node's filesystem APIs. Public exports point at the real owner
 * modules: `wav-format.js` for one fmt chunk, `wav-parse.js` for parsed WAV
 * streams, `pcm-writer.js` for in-memory PCM output, and `decode.js` for the
 * decoded-container result.
 */
export { parseAtracFormat } from "./wav-format.js";
export {
  parseAtracWavBuffer,
  parseFactChunk,
  parsePcm16WavBuffer,
  parseWavChunks,
  splitFrames,
} from "./wav-parse.js";
export { createPcmBufferWriter as createPcmWriter } from "./pcm-writer.js";
export { decodeAt3WavBuffer } from "./decode.js";
