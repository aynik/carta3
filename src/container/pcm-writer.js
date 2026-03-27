import { CodecError } from "../common/errors.js";
import { HOST_IS_LITTLE_ENDIAN } from "../common/endian.js";
import { assertInterleavedPcmInput } from "../common/pcm-planar.js";
import { buildRiffWaveBuffer } from "./wav-bytes.js";
import { WAV_TAG_PCM } from "./wav-format.js";

const PCM16_BITS_PER_SAMPLE = 16;
const PCM16_BYTES_PER_SAMPLE = 2;
const PCM_FORMAT_CHUNK_BYTES = 16;
const PCM_FORMAT_CHUNK_ID = "fmt ";
const PCM_DATA_CHUNK_ID = "data";

function assertU32(value, label) {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new CodecError(`invalid PCM ${label}: ${value}`);
  }
}

export function writePcm16LeBytes(pcmI16, dst, hostIsLittleEndian = HOST_IS_LITTLE_ENDIAN) {
  if (!(pcmI16 instanceof Int16Array)) {
    throw new CodecError("pcmI16 must be an Int16Array");
  }
  if (!(dst instanceof Uint8Array)) {
    throw new CodecError("dst must be a Uint8Array");
  }
  if (dst.length !== pcmI16.length * PCM16_BYTES_PER_SAMPLE) {
    throw new CodecError(`invalid PCM dst byte length: ${dst.length}`);
  }

  if (hostIsLittleEndian) {
    new Int16Array(dst.buffer, dst.byteOffset, pcmI16.length).set(pcmI16);
    return;
  }

  for (let i = 0; i < pcmI16.length; i += 1) {
    const sample = pcmI16[i] | 0;
    const base = i * PCM16_BYTES_PER_SAMPLE;
    dst[base] = sample & 0xff;
    dst[base + 1] = (sample >> 8) & 0xff;
  }
}

/**
 * Creates an in-memory PCM16 WAV writer used by both browser and Node wrappers.
 *
 * @param {number} sampleRate
 * @param {number} channels
 * @param {Int16Array} pcmI16
 * @returns {{ pcm: Int16Array, toPcmWavBuffer(): Uint8Array }}
 */
export function createPcmBufferWriter(sampleRate, channels, pcmI16) {
  assertU32(sampleRate, "sampleRate");
  assertInterleavedPcmInput(pcmI16, channels);
  if (channels > 0xffff) {
    throw new CodecError(`invalid PCM channel count: ${channels}`);
  }

  return {
    pcm: pcmI16,
    toPcmWavBuffer() {
      const blockAlign = channels * PCM16_BYTES_PER_SAMPLE;
      if (blockAlign > 0xffff) {
        throw new CodecError(`invalid PCM blockAlign: ${blockAlign}`);
      }
      const byteRate = sampleRate * blockAlign;
      if (byteRate > 0xffffffff) {
        throw new CodecError(`invalid PCM byteRate: ${byteRate}`);
      }
      const formatBody = new Uint8Array(PCM_FORMAT_CHUNK_BYTES);
      const formatView = new DataView(
        formatBody.buffer,
        formatBody.byteOffset,
        formatBody.byteLength
      );

      formatView.setUint16(0, WAV_TAG_PCM, true);
      formatView.setUint16(2, channels, true);
      formatView.setUint32(4, sampleRate, true);
      formatView.setUint32(8, byteRate, true);
      formatView.setUint16(12, blockAlign, true);
      formatView.setUint16(14, PCM16_BITS_PER_SAMPLE, true);

      const dataBody = new Uint8Array(pcmI16.length * PCM16_BYTES_PER_SAMPLE);
      writePcm16LeBytes(pcmI16, dataBody);

      return buildRiffWaveBuffer([
        { id: PCM_FORMAT_CHUNK_ID, body: formatBody },
        { id: PCM_DATA_CHUNK_ID, body: dataBody },
      ]);
    },
  };
}
