import type {
  BinaryInput,
  ParsedAtracFormat,
  DecodedAtracContainer,
  ParsedAtracContainer,
  ParsedFactChunk,
  ParsedPcm16Wav,
  PcmWriter,
  WavChunk,
} from "../public-types.js";

/**
 * Node WAV container declarations.
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
): PcmWriter;
export function decodeAt3WavBuffer(input: BinaryInput): DecodedAtracContainer;
export function decodeAt3WavContainer(inputPath: string): Promise<DecodedAtracContainer>;
