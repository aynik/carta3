import { CodecError } from "../common/errors.js";
import { ATRAC3_FRAME_SAMPLES } from "./constants.js";

export const ATRAC3_WAV_FORMAT_TAG = 0x0270;

const ATRAC3_FMT_CHUNK_BYTES = 32;
const ATRAC3_WAVE_EXTENSION_BYTES = 14;
const WAVE_FORMAT_EX_HEADER_BYTES = 18;
const EXTENSION_SIZE_OFFSET = 16;
const EXTENSION_REVISION_OFFSET = 18;
const CHANNEL_LAYOUT_OFFSET = 20;
const FLAG_OFFSET = 24;
const FLAG_DUPLICATE_OFFSET = 26;
const RESERVED_WORD_OFFSET = 28;
const RESERVED_TAIL_OFFSET = 30;

/**
 * ATRAC3 keeps its transport metadata in the legacy 14-byte WAVEFORMATEX
 * extension block instead of the newer extensible wrapper.
 */
export function parseAtrac3Format(fmtChunk, baseFormat) {
  if (fmtChunk.length < ATRAC3_FMT_CHUNK_BYTES) {
    throw new CodecError("ATRAC3 fmt chunk too small");
  }

  const view = new DataView(fmtChunk.buffer, fmtChunk.byteOffset, fmtChunk.byteLength);
  const extSize = view.getUint16(EXTENSION_SIZE_OFFSET, true);
  if (extSize !== ATRAC3_WAVE_EXTENSION_BYTES) {
    throw new CodecError(`invalid ATRAC3 fmt extension size: ${extSize}`);
  }
  if (fmtChunk.length < WAVE_FORMAT_EX_HEADER_BYTES + extSize) {
    throw new CodecError("invalid ATRAC3 fmt size");
  }
  const extRevision = view.getUint16(EXTENSION_REVISION_OFFSET, true);
  if (extRevision !== 1) {
    throw new CodecError(`invalid ATRAC3 fmt revision: ${extRevision}`);
  }
  const expectedChannelLayout = (baseFormat.channels << 11) >>> 0;
  const channelLayout = view.getUint32(CHANNEL_LAYOUT_OFFSET, true);
  if (channelLayout !== expectedChannelLayout) {
    throw new CodecError(
      `ATRAC3 channel layout mismatch: expected 0x${expectedChannelLayout.toString(16)}, got 0x${channelLayout.toString(16)}`
    );
  }
  const atrac3Flag = view.getUint16(FLAG_OFFSET, true);
  const atrac3FlagDuplicate = view.getUint16(FLAG_DUPLICATE_OFFSET, true);
  if (atrac3FlagDuplicate !== atrac3Flag) {
    throw new CodecError(
      `ATRAC3 fmt flag mismatch: expected 0x${atrac3Flag.toString(16)}, got 0x${atrac3FlagDuplicate.toString(16)}`
    );
  }
  if (view.getUint16(RESERVED_WORD_OFFSET, true) !== 1) {
    throw new CodecError("invalid ATRAC3 fmt reserved word");
  }
  if (view.getUint16(RESERVED_TAIL_OFFSET, true) !== 0) {
    throw new CodecError("invalid ATRAC3 fmt reserved tail");
  }
  return {
    codec: "atrac3",
    formatTag: baseFormat.formatTag,
    channels: baseFormat.channels,
    sampleRate: baseFormat.sampleRate,
    avgBytesPerSec: baseFormat.avgBytesPerSec,
    bitrateKbps: baseFormat.bitrateKbps,
    frameBytes: baseFormat.frameBytes,
    bitsPerSample: baseFormat.bitsPerSample,
    frameSamples: ATRAC3_FRAME_SAMPLES,
    atrac3Flag,
  };
}

export function createAtrac3WavFormat(profile, baseFormat) {
  if (!Number.isInteger(profile.atrac3Flag)) {
    throw new CodecError("missing ATRAC3 flag on encode profile");
  }

  return {
    codec: baseFormat.codec,
    formatTag: ATRAC3_WAV_FORMAT_TAG,
    channels: baseFormat.channels,
    sampleRate: baseFormat.sampleRate,
    avgBytesPerSec: baseFormat.avgBytesPerSec,
    blockAlign: baseFormat.blockAlign,
    bitsPerSample: baseFormat.bitsPerSample,
    frameSamples: baseFormat.frameSamples,
    formatChunkBytes: ATRAC3_FMT_CHUNK_BYTES,
    atrac3Flag: profile.atrac3Flag,
  };
}

/**
 * Writes the authored ATRAC3 transport fields after the shared 16-byte
 * WAVEFORMATEX header.
 */
export function writeAtrac3FormatBody(_out, view, offset, format) {
  view.setUint16(offset + EXTENSION_SIZE_OFFSET, ATRAC3_WAVE_EXTENSION_BYTES, true);
  view.setUint16(offset + EXTENSION_REVISION_OFFSET, 1, true);
  view.setUint32(offset + CHANNEL_LAYOUT_OFFSET, format.channels << 11, true);
  view.setUint16(offset + FLAG_OFFSET, format.atrac3Flag, true);
  view.setUint16(offset + FLAG_DUPLICATE_OFFSET, format.atrac3Flag, true);
  view.setUint16(offset + RESERVED_WORD_OFFSET, 1, true);
  view.setUint16(offset + RESERVED_TAIL_OFFSET, 0, true);
  return offset + ATRAC3_FMT_CHUNK_BYTES;
}
