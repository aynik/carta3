import { CodecError } from "../common/errors.js";
import { ATRAC3PLUS_FRAME_SAMPLES } from "./constants.js";

export const ATRAC3PLUS_WAV_FORMAT_TAG = 0xfffe;

const ATRAC3PLUS_FMT_CHUNK_BYTES = 52;
const ATRAC3PLUS_WAVE_EXTENSION_BYTES = 34;
const WAVE_EXTENSIBLE_MIN_BYTES = 40;
const WAVE_EXTENSIBLE_HEADER_BYTES = 18;
const EXTENSION_SIZE_OFFSET = 16;
const SAMPLES_PER_BLOCK_OFFSET = 18;
const CHANNEL_MASK_OFFSET = 20;
const SUBTYPE_OFFSET = 24;
const ATRAC3PLUS_VERSION_OFFSET = 40;
const ATRAC3PLUS_CODEC_BYTES_OFFSET = 42;
const ATRAC3PLUS_RESERVED_OFFSET = 44;

const WAV_SUBTYPE_ATRAC3PLUS = new Uint8Array([
  0xbf, 0xaa, 0x23, 0xe9, 0x58, 0xcb, 0x71, 0x44, 0xa1, 0x19, 0xff, 0xfa, 0x01, 0xe4, 0xce, 0x62,
]);

function isAtrac3PlusSubtype(bytes) {
  const subtype = bytes.subarray(SUBTYPE_OFFSET, SUBTYPE_OFFSET + WAV_SUBTYPE_ATRAC3PLUS.length);
  return (
    subtype.length === WAV_SUBTYPE_ATRAC3PLUS.length &&
    subtype.every((byte, index) => byte === WAV_SUBTYPE_ATRAC3PLUS[index])
  );
}

/**
 * ATRAC3plus stores its transport metadata in a WAVEFORMATEXTENSIBLE wrapper
 * whose subtype points to the Sony ATRAC3plus GUID.
 */
export function parseAtrac3PlusFormat(fmtChunk, baseFormat) {
  if (fmtChunk.length < WAVE_EXTENSIBLE_MIN_BYTES) {
    throw new CodecError("WAVEFORMATEXTENSIBLE fmt chunk too small");
  }

  const view = new DataView(fmtChunk.buffer, fmtChunk.byteOffset, fmtChunk.byteLength);
  const extSize = view.getUint16(EXTENSION_SIZE_OFFSET, true);
  if (extSize !== ATRAC3PLUS_WAVE_EXTENSION_BYTES) {
    throw new CodecError(`invalid ATRAC3plus WAVEFORMATEXTENSIBLE extension size: ${extSize}`);
  }
  if (fmtChunk.length < WAVE_EXTENSIBLE_HEADER_BYTES + extSize) {
    throw new CodecError("invalid WAVEFORMATEXTENSIBLE size");
  }
  if (!isAtrac3PlusSubtype(fmtChunk)) {
    throw new CodecError("unsupported WAVE extensible subtype");
  }

  return {
    codec: "atrac3plus",
    formatTag: baseFormat.formatTag,
    channels: baseFormat.channels,
    sampleRate: baseFormat.sampleRate,
    avgBytesPerSec: baseFormat.avgBytesPerSec,
    bitrateKbps: baseFormat.bitrateKbps,
    frameBytes: baseFormat.frameBytes,
    bitsPerSample: baseFormat.bitsPerSample,
    frameSamples: ATRAC3PLUS_FRAME_SAMPLES,
    channelMask: view.getUint32(CHANNEL_MASK_OFFSET, true),
    atracxVersion: view.getUint16(ATRAC3PLUS_VERSION_OFFSET, true),
    atracxCodecBytes: fmtChunk.subarray(ATRAC3PLUS_CODEC_BYTES_OFFSET, ATRAC3PLUS_RESERVED_OFFSET),
    atracxReserved: fmtChunk.subarray(ATRAC3PLUS_RESERVED_OFFSET, ATRAC3PLUS_FMT_CHUNK_BYTES),
  };
}

export function createAtrac3PlusWavFormat(profile, baseFormat) {
  if (!Number.isInteger(profile.channelMask)) {
    throw new CodecError(`missing ATRAC3plus channel mask for profile: ${profile.channels}ch`);
  }
  if (!(profile.atracxCodecBytes instanceof Uint8Array) || profile.atracxCodecBytes.length < 2) {
    throw new CodecError("missing ATRAC3plus codec bytes on encode profile");
  }

  return {
    codec: baseFormat.codec,
    formatTag: ATRAC3PLUS_WAV_FORMAT_TAG,
    channels: baseFormat.channels,
    sampleRate: baseFormat.sampleRate,
    avgBytesPerSec: baseFormat.avgBytesPerSec,
    blockAlign: baseFormat.blockAlign,
    bitsPerSample: baseFormat.bitsPerSample,
    frameSamples: baseFormat.frameSamples,
    formatChunkBytes: ATRAC3PLUS_FMT_CHUNK_BYTES,
    extSize: ATRAC3PLUS_WAVE_EXTENSION_BYTES,
    samplesPerBlock: profile.frameSamples,
    channelMask: profile.channelMask,
    atracxVersion: 1,
    atracxCodecBytes: profile.atracxCodecBytes,
    atracxReserved: new Uint8Array(8),
  };
}

/**
 * Writes the authored ATRAC3plus WAVEFORMATEXTENSIBLE payload after the shared
 * WAVEFORMATEX header.
 */
export function writeAtrac3PlusFormatBody(out, view, offset, format) {
  view.setUint16(offset + EXTENSION_SIZE_OFFSET, format.extSize, true);
  view.setUint16(offset + SAMPLES_PER_BLOCK_OFFSET, format.samplesPerBlock, true);
  view.setUint32(offset + CHANNEL_MASK_OFFSET, format.channelMask, true);
  out.set(WAV_SUBTYPE_ATRAC3PLUS, offset + SUBTYPE_OFFSET);
  view.setUint16(offset + ATRAC3PLUS_VERSION_OFFSET, format.atracxVersion, true);
  out.set(format.atracxCodecBytes, offset + ATRAC3PLUS_CODEC_BYTES_OFFSET);
  out.set(format.atracxReserved, offset + ATRAC3PLUS_RESERVED_OFFSET);
  return offset + ATRAC3PLUS_FMT_CHUNK_BYTES;
}
