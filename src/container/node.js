/**
 * Node container public surface.
 *
 * This module extends the browser-safe WAV helpers with filesystem-aware PCM
 * writing and container decoding. Like the browser barrel, it re-exports the
 * shared browser-safe container barrel and only adds the filesystem-specific
 * writer attachment locally.
 */
import { decodeAt3WavBuffer as decodeBrowserAt3WavBuffer } from "./decode.js";
import { createPcmBufferWriter } from "./pcm-writer.js";
export {
  parseAtracFormat,
  parseWavChunks,
  parseFactChunk,
  splitFrames,
  parsePcm16WavBuffer,
  parseAtracWavBuffer,
} from "./index.js";

const fsPromisesPromise = import("node:fs/promises");

/**
 * Creates a PCM WAV writer that can either materialize bytes in memory or
 * write the same buffer straight to disk.
 */
export function createPcmWriter(sampleRate, channels, pcmI16) {
  const { pcm, toPcmWavBuffer } = createPcmBufferWriter(sampleRate, channels, pcmI16);

  return {
    pcm,
    toPcmWavBuffer,
    async writePcmWav(outputPath) {
      const { writeFile } = await fsPromisesPromise;
      await writeFile(outputPath, toPcmWavBuffer());
    },
  };
}

/**
 * Decodes an ATRAC WAV buffer and exposes the resulting PCM through the same
 * Node-capable writer interface used by `createPcmWriter`.
 */
export function decodeAt3WavBuffer(input) {
  const { metadata, pcm, toPcmWavBuffer } = decodeBrowserAt3WavBuffer(input);

  return {
    metadata,
    pcm,
    toPcmWavBuffer,
    async writePcmWav(outputPath) {
      const { writeFile } = await fsPromisesPromise;
      await writeFile(outputPath, toPcmWavBuffer());
    },
  };
}

/** Reads and decodes an ATRAC WAV container from disk. */
export async function decodeAt3WavContainer(inputPath) {
  const { readFile } = await fsPromisesPromise;
  return decodeAt3WavBuffer(await readFile(inputPath));
}
