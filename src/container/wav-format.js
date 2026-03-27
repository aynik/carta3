import {
  ATRAC3_WAV_FORMAT_TAG,
  createAtrac3WavFormat,
  parseAtrac3Format,
  writeAtrac3FormatBody,
} from "../atrac3/wav-format.js";
import {
  ATRAC3PLUS_WAV_FORMAT_TAG,
  createAtrac3PlusWavFormat,
  parseAtrac3PlusFormat,
  writeAtrac3PlusFormatBody,
} from "../atrac3plus/wav-format.js";
import { normalizeInputBytes } from "../common/bytes.js";
import { CodecError } from "../common/errors.js";
import { roundDivU32 } from "../common/math.js";

export const WAV_TAG_PCM = 1;

const WAVE_FORMAT_BYTES = 16;

/**
 * Reads the shared 16-byte WAVEFORMATEX header used by PCM, ATRAC3, and the
 * WAVEFORMATEXTENSIBLE wrapper used by ATRAC3plus.
 */
export function readWaveFormat(fmtChunk) {
  const bytes = fmtChunk instanceof Uint8Array ? fmtChunk : normalizeInputBytes(fmtChunk);
  if (bytes.length < WAVE_FORMAT_BYTES) {
    throw new CodecError("fmt chunk too small");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    formatTag: view.getUint16(0, true),
    channels: view.getUint16(2, true),
    sampleRate: view.getUint32(4, true),
    avgBytesPerSec: view.getUint32(8, true),
    blockAlign: view.getUint16(12, true),
    bitsPerSample: view.getUint16(14, true),
  };
}

/**
 * Parses the shared WAVEFORMATEX header, then dispatches to the codec-owned
 * ATRAC fmt chunk reader for the trailing metadata. The return value is always
 * one authored ATRAC3 or ATRAC3plus format object, not a generic record bag.
 */
export function parseAtracFormat(fmtChunk) {
  const bytes = fmtChunk instanceof Uint8Array ? fmtChunk : normalizeInputBytes(fmtChunk);
  const waveFormat = readWaveFormat(bytes);
  const baseFormat = {
    formatTag: waveFormat.formatTag,
    channels: waveFormat.channels,
    sampleRate: waveFormat.sampleRate,
    avgBytesPerSec: waveFormat.avgBytesPerSec,
    bitrateKbps: Math.round((waveFormat.avgBytesPerSec * 8) / 1000),
    frameBytes: waveFormat.blockAlign,
    bitsPerSample: waveFormat.bitsPerSample,
  };

  switch (waveFormat.formatTag) {
    case ATRAC3_WAV_FORMAT_TAG:
      return parseAtrac3Format(bytes, baseFormat);
    case ATRAC3PLUS_WAV_FORMAT_TAG:
      return parseAtrac3PlusFormat(bytes, baseFormat);
    default:
      throw new CodecError(`unsupported WAV format tag: 0x${waveFormat.formatTag.toString(16)}`);
  }
}

/**
 * Builds the authored ATRAC WAV metadata object used by the container writer.
 * This mirrors the same closed ATRAC3/ATRAC3plus format family exposed by the
 * public container declarations.
 */
export function createAtracEncodeWavFormat(profile) {
  if (!profile || typeof profile !== "object") {
    throw new CodecError("profile must be an object");
  }

  const baseFormat = {
    codec: profile.codec,
    channels: profile.channels,
    sampleRate: profile.sampleRate,
    avgBytesPerSec: roundDivU32(profile.frameBytes * profile.sampleRate, profile.frameSamples),
    blockAlign: profile.frameBytes,
    bitsPerSample: 0,
    frameSamples: profile.frameSamples,
  };

  if (profile.codec === "atrac3") {
    return createAtrac3WavFormat(profile, baseFormat);
  }
  if (profile.codec === "atrac3plus") {
    return createAtrac3PlusWavFormat(profile, baseFormat);
  }

  throw new CodecError(`unsupported ATRAC codec: ${profile.codec}`);
}

/**
 * Writes the shared WAVEFORMATEX header, then appends the codec-owned ATRAC
 * extension fields.
 */
export function writeAtracFormatBody(out, view, offset, format) {
  view.setUint16(offset, format.formatTag, true);
  view.setUint16(offset + 2, format.channels, true);
  view.setUint32(offset + 4, format.sampleRate, true);
  view.setUint32(offset + 8, format.avgBytesPerSec, true);
  view.setUint16(offset + 12, format.blockAlign, true);
  view.setUint16(offset + 14, format.bitsPerSample, true);

  switch (format.formatTag) {
    case ATRAC3_WAV_FORMAT_TAG:
      return writeAtrac3FormatBody(out, view, offset, format);
    case ATRAC3PLUS_WAV_FORMAT_TAG:
      return writeAtrac3PlusFormatBody(out, view, offset, format);
    default:
      throw new CodecError(`unsupported WAV format tag: 0x${format.formatTag.toString(16)}`);
  }
}
