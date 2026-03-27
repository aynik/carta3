import { CodecError } from "../common/errors.js";

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const RIFF_CHUNK_ID = "RIFF";
const WAVE_SIGNATURE = "WAVE";
const RIFF_U32_MAX = 0xffffffff;

/** Writes ASCII code units into a RIFF/WAV byte buffer. */
export function writeAscii(out, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    out[offset + index] = text.charCodeAt(index) & 0xff;
  }
}

/** Reads one 4-byte RIFF chunk identifier from a WAV byte buffer. */
export function readChunkId(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

/**
 * Serializes authored RIFF/WAVE chunks into one padded file buffer.
 *
 * Each chunk body must already contain its wire-format payload; this owner
 * writes the shared RIFF header, per-chunk headers, and odd-byte padding.
 */
export function buildRiffWaveBuffer(chunks) {
  const totalBytes =
    RIFF_HEADER_BYTES +
    chunks.reduce((sum, { body }) => sum + CHUNK_HEADER_BYTES + body.length + (body.length & 1), 0);
  if (totalBytes - 8 > RIFF_U32_MAX) {
    throw new CodecError(`RIFF/WAV output exceeds 4GB: ${totalBytes} bytes`);
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  writeAscii(out, 0, RIFF_CHUNK_ID);
  view.setUint32(4, totalBytes - 8, true);
  writeAscii(out, 8, WAVE_SIGNATURE);

  let offset = RIFF_HEADER_BYTES;
  for (const { id, body } of chunks) {
    if (typeof id !== "string" || id.length !== 4) {
      throw new CodecError(`invalid RIFF chunk id: ${String(id)}`);
    }
    for (let index = 0; index < id.length; index += 1) {
      const codeUnit = id.charCodeAt(index);
      if (codeUnit < 0x20 || codeUnit > 0x7e) {
        throw new CodecError(`invalid RIFF chunk id: ${String(id)}`);
      }
    }
    if (body.length > RIFF_U32_MAX) {
      throw new CodecError(`RIFF/WAV chunk '${id}' exceeds 4GB: ${body.length} bytes`);
    }

    writeAscii(out, offset, id);
    view.setUint32(offset + 4, body.length, true);
    offset += CHUNK_HEADER_BYTES;
    out.set(body, offset);
    offset += body.length + (body.length & 1);
  }

  if (offset !== out.length) {
    throw new CodecError(`internal WAV sizing mismatch: wrote ${offset}, expected ${out.length}`);
  }

  return out;
}
