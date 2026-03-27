import { normalizeInputBytes } from "../common/bytes.js";
import { HOST_IS_LITTLE_ENDIAN } from "../common/endian.js";
import { CodecError } from "../common/errors.js";
import { parseAtracFormat, readWaveFormat, WAV_TAG_PCM } from "./wav-format.js";

/**
 * @typedef {import("../public-types.js").ParsedAtracContainer} ParsedAtracContainer
 * @typedef {import("../public-types.js").ParsedPcm16Wav} ParsedPcm16Wav
 * @typedef {{ fmtChunk: Uint8Array, dataChunk: Uint8Array, factChunk: Uint8Array | null }} FirstWavChunks
 */

const WAV_HEADER_BYTES = 12;
const WAV_CHUNK_HEADER_BYTES = 8;
const WAV_FMT_CHUNK_ID = "fmt ";
const WAV_DATA_CHUNK_ID = "data";
const WAV_FACT_CHUNK_ID = "fact";
const PCM16_BITS_PER_SAMPLE = 16;

const RIFF_CHUNK_ID_U32 = 0x52494646;
const WAVE_SIGNATURE_U32 = 0x57415645;
const WAV_FMT_CHUNK_ID_U32 = 0x666d7420;
const WAV_DATA_CHUNK_ID_U32 = 0x64617461;
const WAV_FACT_CHUNK_ID_U32 = 0x66616374;

const ERR_NOT_RIFF_WAVE = "input is not a RIFF/WAVE file";

function wavChunkIdString(idCode) {
  switch (idCode >>> 0) {
    case RIFF_CHUNK_ID_U32:
      return "RIFF";
    case WAVE_SIGNATURE_U32:
      return "WAVE";
    case WAV_FMT_CHUNK_ID_U32:
      return WAV_FMT_CHUNK_ID;
    case WAV_DATA_CHUNK_ID_U32:
      return WAV_DATA_CHUNK_ID;
    case WAV_FACT_CHUNK_ID_U32:
      return WAV_FACT_CHUNK_ID;
    default:
      return String.fromCharCode(
        (idCode >>> 24) & 0xff,
        (idCode >>> 16) & 0xff,
        (idCode >>> 8) & 0xff,
        idCode & 0xff
      );
  }
}

/**
 * Iterates RIFF/WAVE chunks while preserving the file's original chunk order.
 *
 * Each yielded body stays a view into the original byte buffer.
 */
function* iterateWavChunks(input) {
  const bytes = normalizeInputBytes(input);
  if (bytes.length < WAV_HEADER_BYTES) {
    throw new CodecError(ERR_NOT_RIFF_WAVE);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, false) !== RIFF_CHUNK_ID_U32 ||
    view.getUint32(8, false) !== WAVE_SIGNATURE_U32
  ) {
    throw new CodecError(ERR_NOT_RIFF_WAVE);
  }

  const riffSize = view.getUint32(4, true);
  const riffTotalBytes = riffSize + 8;
  if (riffTotalBytes < WAV_HEADER_BYTES) {
    throw new CodecError("malformed RIFF/WAVE header: RIFF size is too small");
  }
  if (riffTotalBytes > bytes.length) {
    throw new CodecError("truncated RIFF/WAVE file: RIFF size exceeds buffer length");
  }

  const parseLimit = riffTotalBytes;
  let offset = WAV_HEADER_BYTES;
  while (offset + WAV_CHUNK_HEADER_BYTES <= parseLimit) {
    const idCode = view.getUint32(offset, false);
    const id = wavChunkIdString(idCode);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + WAV_CHUNK_HEADER_BYTES;
    const bodyEnd = bodyStart + size;

    if (bodyEnd > parseLimit) {
      throw new CodecError(`malformed WAV chunk: ${id}`);
    }

    yield {
      id,
      size,
      offset,
      body: bytes.subarray(bodyStart, bodyEnd),
    };

    offset = bodyEnd + (size & 1);
  }

  if (offset !== parseLimit) {
    throw new CodecError("malformed RIFF/WAVE file: trailing bytes after last chunk");
  }
}

/**
 * Splits a RIFF/WAVE buffer into aligned chunk records.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {{ id: string, size: number, offset: number, body: Uint8Array }[]}
 */
export function parseWavChunks(input) {
  return Array.from(iterateWavChunks(input));
}

/**
 * Reads the first `fmt `, `data`, and `fact` chunks from a WAV file.
 *
 * Later duplicates are ignored so container parsing follows the same
 * first-definition behavior as the current CLI and tests.
 *
 * `fact` stays optional because PCM WAV files do not carry it.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {FirstWavChunks}
 */
function readFirstWavChunks(input) {
  /** @type {Uint8Array | null} */
  let fmtChunk = null;
  /** @type {Uint8Array | null} */
  let dataChunk = null;
  /** @type {Uint8Array | null} */
  let factChunk = null;
  /** @type {number | null} */
  let formatTag = null;

  for (const { id, body } of iterateWavChunks(input)) {
    if (id === WAV_FMT_CHUNK_ID) {
      fmtChunk ??= body;
      if (fmtChunk && formatTag === null) {
        formatTag = readWaveFormat(fmtChunk).formatTag;
      }
    } else if (id === WAV_DATA_CHUNK_ID) {
      dataChunk ??= body;
    } else if (id === WAV_FACT_CHUNK_ID) {
      factChunk ??= body;
    }

    if (fmtChunk && dataChunk) {
      if (factChunk) {
        break;
      }
      if (formatTag === WAV_TAG_PCM) {
        break;
      }
    }
  }

  if (!fmtChunk || !dataChunk) {
    throw new CodecError("missing fmt or data chunk");
  }

  return {
    fmtChunk,
    dataChunk,
    factChunk,
  };
}

/**
 * Parses the optional WAV `fact` chunk used by ATRAC containers.
 *
 * @param {ArrayBuffer|ArrayBufferView|null} factChunk
 * @returns {{ sampleCount: number | null, raw: number[] }}
 */
export function parseFactChunk(factChunk) {
  if (!factChunk) {
    return { sampleCount: null, raw: [] };
  }

  const bytes = normalizeInputBytes(factChunk);
  if (bytes.length < 4) {
    throw new CodecError(
      `malformed WAV fact chunk: expected at least 4 bytes, got ${bytes.length}`
    );
  }
  if (bytes.length % 4 !== 0) {
    throw new CodecError("malformed WAV fact chunk: size is not 4-byte aligned");
  }

  const wordCount = bytes.length / 4;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = new Array(wordCount);

  for (let index = 0; index < wordCount; index += 1) {
    raw[index] = view.getUint32(index * 4, true);
  }

  return {
    sampleCount: raw[0] ?? null,
    raw,
  };
}

/**
 * Slices the ATRAC payload into frame-aligned views.
 *
 * @param {ArrayBuffer|ArrayBufferView} dataChunk
 * @param {number} frameBytes
 * @returns {Uint8Array[]}
 */
export function splitFrames(dataChunk, frameBytes) {
  const bytes = normalizeInputBytes(dataChunk);
  if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
    throw new CodecError(`invalid frame size: ${frameBytes}`);
  }
  if (bytes.length % frameBytes !== 0) {
    throw new CodecError(
      `data chunk size ${bytes.length} is not aligned to frame size ${frameBytes}`
    );
  }

  const frameCount = bytes.length / frameBytes;
  const frames = new Array(frameCount);

  for (let index = 0; index < frameCount; index += 1) {
    const frameStart = index * frameBytes;
    frames[index] = bytes.subarray(frameStart, frameStart + frameBytes);
  }

  return frames;
}

function assertPcm16Format(format, dataSize) {
  if (format.formatTag !== WAV_TAG_PCM) {
    throw new CodecError(`unsupported PCM WAV format tag: 0x${format.formatTag.toString(16)}`);
  }
  if (format.bitsPerSample !== PCM16_BITS_PER_SAMPLE) {
    throw new CodecError(`expected 16-bit PCM, got ${format.bitsPerSample}`);
  }

  const size = dataSize >>> 0;
  if ((size & 1) !== 0) {
    throw new CodecError("PCM16 data chunk has odd byte length");
  }

  const channels = format.channels >>> 0;
  if (channels === 0) {
    throw new CodecError("malformed PCM16 WAV fmt chunk: channels is zero");
  }
  const sampleRate = format.sampleRate >>> 0;
  if (sampleRate === 0) {
    throw new CodecError("malformed PCM16 WAV fmt chunk: sampleRate is zero");
  }

  const expectedBlockAlign = channels * 2;
  if (format.blockAlign >>> 0 !== expectedBlockAlign >>> 0) {
    throw new CodecError(
      `malformed PCM16 WAV fmt chunk: blockAlign ${format.blockAlign} does not match channels (${channels})`
    );
  }

  const expectedAvgBytesPerSec = sampleRate * expectedBlockAlign;
  if (expectedAvgBytesPerSec > 0xffffffff) {
    throw new CodecError("malformed PCM16 WAV fmt chunk: avgBytesPerSec overflows u32");
  }
  if (format.avgBytesPerSec >>> 0 !== expectedAvgBytesPerSec >>> 0) {
    throw new CodecError(
      `malformed PCM16 WAV fmt chunk: avgBytesPerSec ${format.avgBytesPerSec} does not match sampleRate (${sampleRate})`
    );
  }

  if (expectedBlockAlign !== 0 && size % expectedBlockAlign !== 0) {
    throw new CodecError("malformed PCM16 WAV data chunk: size is not aligned to blockAlign");
  }
}

function createPcm16SampleView(dataChunk) {
  if (dataChunk.length % 2 !== 0) {
    throw new CodecError("PCM16 data chunk has odd byte length");
  }

  if (HOST_IS_LITTLE_ENDIAN && (dataChunk.byteOffset & 1) === 0) {
    return new Int16Array(dataChunk.buffer, dataChunk.byteOffset, dataChunk.length / 2);
  }

  const sampleCount = dataChunk.length / 2;
  const samples = new Int16Array(sampleCount);
  const view = new DataView(dataChunk.buffer, dataChunk.byteOffset, dataChunk.byteLength);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }

  return samples;
}

/**
 * Parses a PCM16 WAV buffer into normalized metadata and an Int16 sample view.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {ParsedPcm16Wav}
 */
export function parsePcm16WavBuffer(input) {
  const { fmtChunk, dataChunk } = readFirstWavChunks(input);
  const format = readWaveFormat(fmtChunk);
  assertPcm16Format(format, dataChunk.length);

  return {
    formatTag: format.formatTag,
    channels: format.channels,
    sampleRate: format.sampleRate,
    avgBytesPerSec: format.avgBytesPerSec,
    blockAlign: format.blockAlign,
    bitsPerSample: format.bitsPerSample,
    dataSize: dataChunk.length,
    samples: createPcm16SampleView(dataChunk),
  };
}

/**
 * Parses an ATRAC WAV buffer into stream metadata plus frame views.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {ParsedAtracContainer}
 */
export function parseAtracWavBuffer(input) {
  const { fmtChunk, dataChunk, factChunk } = readFirstWavChunks(input);
  const format = parseAtracFormat(fmtChunk);
  const { sampleCount: factSamples, raw: factRaw } = parseFactChunk(factChunk);
  const frames = splitFrames(dataChunk, format.frameBytes);
  const frameCount = frames.length;
  const dataSize = dataChunk.length;

  switch (format.codec) {
    case "atrac3":
      return {
        codec: format.codec,
        formatTag: format.formatTag,
        channels: format.channels,
        sampleRate: format.sampleRate,
        avgBytesPerSec: format.avgBytesPerSec,
        bitrateKbps: format.bitrateKbps,
        frameBytes: format.frameBytes,
        frameSamples: format.frameSamples,
        bitsPerSample: format.bitsPerSample,
        factSamples,
        factRaw,
        frameCount,
        dataSize,
        frames,
        atrac3Flag: format.atrac3Flag,
      };
    case "atrac3plus":
      return {
        codec: format.codec,
        formatTag: format.formatTag,
        channels: format.channels,
        sampleRate: format.sampleRate,
        avgBytesPerSec: format.avgBytesPerSec,
        bitrateKbps: format.bitrateKbps,
        frameBytes: format.frameBytes,
        frameSamples: format.frameSamples,
        bitsPerSample: format.bitsPerSample,
        factSamples,
        factRaw,
        frameCount,
        dataSize,
        frames,
        channelMask: format.channelMask,
        atracxVersion: format.atracxVersion,
        atracxCodecBytes: format.atracxCodecBytes,
        atracxReserved: format.atracxReserved,
      };
    default:
      throw new CodecError(`unsupported ATRAC WAV codec: ${format.codec}`);
  }
}
