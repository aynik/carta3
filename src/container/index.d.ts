import type {
  BinaryInput,
  ParsedAtracFormat,
  DecodedAtracBuffer,
  ParsedAtracContainer,
  ParsedFactChunk,
  ParsedPcm16Wav,
  PcmBufferWriter,
  WavChunk,
} from "../public-types.js";

/**
 * Browser-safe WAV container declarations.
 */
export function parseWavChunks(input: BinaryInput): WavChunk[];
export function parseAtracFormat(fmtChunk: BinaryInput): ParsedAtracFormat;
export function parseFactChunk(factChunk: BinaryInput | null): ParsedFactChunk;
export function parsePcm16WavBuffer(input: BinaryInput): ParsedPcm16Wav;
export function splitFrames(dataChunk: BinaryInput, frameBytes: number): Uint8Array[];
export function parseAtracWavBuffer(input: BinaryInput): ParsedAtracContainer;
export function createPcmWriter(
  sampleRate: number,
  channels: number,
  pcmI16: Int16Array
): PcmBufferWriter;
export function decodeAt3WavBuffer(input: BinaryInput): DecodedAtracBuffer;
