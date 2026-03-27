import assert from "node:assert/strict";
import test from "node:test";

import { selectAtracEncodeProfile } from "../../src/encoders/profiles.js";
import {
  createDecodedAtracWavResult,
  decodeAt3WavBuffer,
  decodeParsedAtracWav,
} from "../../src/container/decode.js";
import { createPcmBufferWriter, writePcm16LeBytes } from "../../src/container/pcm-writer.js";
import {
  createAtracEncodeWavFormat,
  writeAtracFormatBody,
} from "../../src/container/wav-format.js";
import { buildAtracWavBuffer } from "../../src/container/wav-build.js";
import {
  parseAtracWavBuffer,
  parseFactChunk,
  parsePcm16WavBuffer,
  splitFrames,
  parseWavChunks,
} from "../../src/container/wav-parse.js";
import { parseAtracFormat } from "../../src/container/wav-format.js";
import { encodeAtracWavBufferFromInterleavedPcm } from "../../src/encoders/atrac.js";
import { encodeAtrac3WavBufferFromInterleavedPcm } from "../../src/encoders/atrac3.js";

function writeAscii(out, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    out[offset + i] = text.charCodeAt(i) & 0xff;
  }
}

function createFormatChunk(length) {
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  return { out, view };
}

function buildRiffWave(chunks) {
  const totalSize =
    12 + chunks.reduce((size, chunk) => size + 8 + chunk.body.length + (chunk.body.length & 1), 0);
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  writeAscii(out, 0, "RIFF");
  view.setUint32(4, totalSize - 8, true);
  writeAscii(out, 8, "WAVE");

  let offset = 12;
  for (const chunk of chunks) {
    writeAscii(out, offset, chunk.id);
    offset += 4;
    view.setUint32(offset, chunk.body.length, true);
    offset += 4;
    out.set(chunk.body, offset);
    offset += chunk.body.length;
    if ((chunk.body.length & 1) !== 0) {
      offset += 1;
    }
  }

  return out;
}

function getChunkBody(bytes, id) {
  return parseWavChunks(bytes).find((chunk) => chunk.id === id)?.body ?? null;
}

function createPcm(sampleCount) {
  return Int16Array.from({ length: sampleCount }, (_, index) => ((index * 37) % 200) - 100);
}

test("parseWavChunks keeps odd-sized chunk bodies aligned", () => {
  const bytes = buildRiffWave([
    { id: "JUNK", body: Uint8Array.of(0xaa) },
    { id: "data", body: Uint8Array.of(1, 2, 3, 4) },
  ]);

  const chunks = parseWavChunks(bytes);

  assert.deepEqual(
    chunks.map((chunk) => ({
      id: chunk.id,
      size: chunk.size,
      offset: chunk.offset,
      body: Array.from(chunk.body),
    })),
    [
      { id: "JUNK", size: 1, offset: 12, body: [0xaa] },
      { id: "data", size: 4, offset: 22, body: [1, 2, 3, 4] },
    ]
  );
});

test("parseWavChunks rejects malformed chunk sizes", () => {
  const bytes = buildRiffWave([{ id: "data", body: Uint8Array.of(1, 2, 3, 4) }]).subarray(0, 22);

  assert.throws(() => parseWavChunks(bytes), /truncated RIFF\/WAVE file/);
});

test("parseFactChunk rejects trailing partial words", () => {
  const bytes = Uint8Array.of(1, 0, 0, 0, 2, 0, 0, 0, 9);
  assert.throws(() => parseFactChunk(bytes), /malformed WAV fact chunk/);
  assert.throws(() => parseFactChunk(bytes.buffer), /malformed WAV fact chunk/);
});

test("parseFactChunk rejects short fact chunks", () => {
  assert.deepEqual(parseFactChunk(null), {
    sampleCount: null,
    raw: [],
  });
  const bytes = Uint8Array.of(1, 0, 0);
  assert.throws(() => parseFactChunk(bytes), /malformed WAV fact chunk/);
  assert.throws(() => parseFactChunk(bytes.buffer), /malformed WAV fact chunk/);
});

test("parseAtracFormat parses ATRAC3 fmt chunks", () => {
  const { out, view } = createFormatChunk(32);
  view.setUint16(0, 0x0270, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 8269, true);
  view.setUint16(12, 192, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, 14, true);
  view.setUint16(18, 1, true);
  view.setUint32(20, 2 << 11, true);
  view.setUint16(24, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 1, true);
  view.setUint16(30, 0, true);

  const expected = {
    codec: "atrac3",
    formatTag: 0x0270,
    channels: 2,
    sampleRate: 44100,
    avgBytesPerSec: 8269,
    bitrateKbps: 66,
    frameBytes: 192,
    bitsPerSample: 0,
    frameSamples: 1024,
    atrac3Flag: 1,
  };

  assert.deepEqual(parseAtracFormat(out), expected);
  assert.deepEqual(parseAtracFormat(out.buffer), expected);
});

test("parseAtracFormat rejects ATRAC3 extension size mismatches", () => {
  const { out, view } = createFormatChunk(32);
  view.setUint16(0, 0x0270, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 8269, true);
  view.setUint16(12, 192, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, 0, true);

  assert.throws(() => parseAtracFormat(out), /invalid ATRAC3 fmt extension size: 0/);
});

test("parseAtracFormat rejects unsupported format tags", () => {
  const { out, view } = createFormatChunk(16);
  view.setUint16(0, 7, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 8269, true);
  view.setUint16(12, 192, true);
  view.setUint16(14, 0, true);

  assert.throws(() => parseAtracFormat(out), /unsupported WAV format tag: 0x7/);
});

test("parseAtracFormat rejects invalid WAVEFORMATEXTENSIBLE sizes", () => {
  const { out, view } = createFormatChunk(40);
  view.setUint16(0, 0xfffe, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 12059, true);
  view.setUint16(12, 560, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, 34, true);

  assert.throws(() => parseAtracFormat(out), /invalid WAVEFORMATEXTENSIBLE size/);
});

test("parseAtracFormat rejects ATRAC3plus extension size mismatches", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: Uint8Array.from({ length: profile.frameBytes }, (_, index) => index & 0xff),
    totalSamples: profile.frameSamples,
  });

  const fmtChunk = getChunkBody(wav, "fmt ");
  const truncated = fmtChunk.slice(0, 40);
  const view = new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength);
  view.setUint16(16, 22, true);

  assert.throws(
    () => parseAtracFormat(truncated),
    /invalid ATRAC3plus WAVEFORMATEXTENSIBLE extension size: 22/
  );
});

test("parseAtracFormat rejects unsupported WAVE extensible subtypes", () => {
  const { out, view } = createFormatChunk(52);
  view.setUint16(0, 0xfffe, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 12059, true);
  view.setUint16(12, 560, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, 34, true);
  view.setUint16(18, 2048, true);
  view.setUint32(20, 0x3, true);

  assert.throws(() => parseAtracFormat(out), /unsupported WAVE extensible subtype/);
});

test("parseAtracFormat preserves ATRAC3plus extensible metadata", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: Uint8Array.from({ length: profile.frameBytes }, (_, index) => index & 0xff),
    totalSamples: profile.frameSamples,
  });

  const fmtChunk = getChunkBody(wav, "fmt ");
  const fmtCopy = fmtChunk.slice();

  assert.deepEqual(parseAtracFormat(fmtChunk), {
    codec: "atrac3plus",
    formatTag: 0xfffe,
    channels: 2,
    sampleRate: 44100,
    avgBytesPerSec: 12059,
    bitrateKbps: 96,
    frameBytes: 560,
    bitsPerSample: 0,
    frameSamples: 2048,
    channelMask: 0x3,
    atracxVersion: 1,
    atracxCodecBytes: profile.atracxCodecBytes,
    atracxReserved: new Uint8Array(8),
  });
  assert.deepEqual(parseAtracFormat(fmtCopy.buffer), parseAtracFormat(fmtChunk));
});

test("writeAtracFormatBody round-trips authored ATRAC fmt chunk layouts", () => {
  const profiles = [selectAtracEncodeProfile(66, 2, 44100), selectAtracEncodeProfile(96, 2, 44100)];

  for (const profile of profiles) {
    const format = createAtracEncodeWavFormat(profile);
    const chunk = new Uint8Array(format.formatChunkBytes);
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    assert.equal(writeAtracFormatBody(chunk, view, 0, format), chunk.length);
    assert.deepEqual(parseAtracFormat(chunk), {
      codec: format.codec,
      formatTag: format.formatTag,
      channels: format.channels,
      sampleRate: format.sampleRate,
      avgBytesPerSec: format.avgBytesPerSec,
      bitrateKbps: Math.round((format.avgBytesPerSec * 8) / 1000),
      frameBytes: format.blockAlign,
      bitsPerSample: format.bitsPerSample,
      frameSamples: format.frameSamples,
      ...(format.codec === "atrac3"
        ? { atrac3Flag: format.atrac3Flag }
        : {
            channelMask: format.channelMask,
            atracxVersion: format.atracxVersion,
            atracxCodecBytes: format.atracxCodecBytes,
            atracxReserved: format.atracxReserved,
          }),
    });
  }
});

test("writeAtracFormatBody rejects unsupported format tags", () => {
  const { out, view } = createFormatChunk(16);

  assert.throws(
    () =>
      writeAtracFormatBody(out, view, 0, {
        formatTag: 7,
        channels: 2,
        sampleRate: 44100,
        avgBytesPerSec: 8269,
        blockAlign: 192,
        bitsPerSample: 0,
      }),
    /unsupported WAV format tag: 0x7/
  );
});

test("parsePcm16WavBuffer round-trips PCM WAV buffers", () => {
  const pcm = Int16Array.from([1, -2, 300, -400]);
  const wav = createPcmBufferWriter(44100, 2, pcm).toPcmWavBuffer();

  const parsed = parsePcm16WavBuffer(wav);

  assert.deepEqual(Object.keys(parsed).sort(), [
    "avgBytesPerSec",
    "bitsPerSample",
    "blockAlign",
    "channels",
    "dataSize",
    "formatTag",
    "sampleRate",
    "samples",
  ]);
  assert.equal(parsed.formatTag, 1);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.dataSize, pcm.length * 2);
  assert.deepEqual(Array.from(parsed.samples), Array.from(pcm));
});

test("parsePcm16WavBuffer reads PCM16 data via DataView when unaligned", () => {
  const pcm = Int16Array.from([1, -2, 300, -400]);
  const wav = createPcmBufferWriter(44100, 2, pcm).toPcmWavBuffer();

  const padded = new Uint8Array(wav.length + 1);
  padded.set(wav, 1);

  const parsed = parsePcm16WavBuffer(padded.subarray(1));
  assert.deepEqual(Array.from(parsed.samples), Array.from(pcm));
});

test("parsePcm16WavBuffer ignores trailing bytes after the RIFF payload", () => {
  const pcm = Int16Array.from([1, -2, 300, -400]);
  const wav = createPcmBufferWriter(44100, 2, pcm).toPcmWavBuffer();
  const padded = new Uint8Array(wav.length + 3);
  padded.set(wav, 0);
  padded.fill(0xaa, wav.length);

  const parsed = parsePcm16WavBuffer(padded);

  assert.deepEqual(Array.from(parsed.samples), Array.from(pcm));
});

test("writePcm16LeBytes preserves little-endian bytes independent of host endianness", () => {
  const pcm = Int16Array.from([1, -2, 300, -400]);
  const fast = new Uint8Array(pcm.length * 2);
  const slow = new Uint8Array(pcm.length * 2);

  writePcm16LeBytes(pcm, fast, true);
  writePcm16LeBytes(pcm, slow, false);

  assert.deepEqual(Array.from(fast), Array.from(slow));
});

test("createPcmBufferWriter rejects invalid PCM format metadata", () => {
  assert.throws(() => createPcmBufferWriter(0, 1, new Int16Array(0)), /invalid PCM sampleRate/);
  assert.throws(() => createPcmBufferWriter(44100, 0, new Int16Array(0)), /invalid channel count/);
  assert.throws(
    () => createPcmBufferWriter(44100, 0x10000, new Int16Array(0)),
    /invalid PCM channel count/
  );
  assert.throws(
    () => createPcmBufferWriter(44100, 0x8000, new Int16Array(0)).toPcmWavBuffer(),
    /invalid PCM blockAlign/
  );
  assert.throws(
    () => createPcmBufferWriter(0xffffffff, 2, new Int16Array(0)).toPcmWavBuffer(),
    /invalid PCM byteRate/
  );
});

test("parsePcm16WavBuffer keeps the first fmt and data chunks", () => {
  const { out: pcmFmt, view: pcmFmtView } = createFormatChunk(16);
  pcmFmtView.setUint16(0, 1, true);
  pcmFmtView.setUint16(2, 1, true);
  pcmFmtView.setUint32(4, 44100, true);
  pcmFmtView.setUint32(8, 88200, true);
  pcmFmtView.setUint16(12, 2, true);
  pcmFmtView.setUint16(14, 16, true);

  const { out: atracFmt, view: atracFmtView } = createFormatChunk(16);
  atracFmtView.setUint16(0, 0x0270, true);
  atracFmtView.setUint16(2, 2, true);
  atracFmtView.setUint32(4, 44100, true);
  atracFmtView.setUint32(8, 8269, true);
  atracFmtView.setUint16(12, 192, true);
  atracFmtView.setUint16(14, 0, true);

  const wav = buildRiffWave([
    { id: "fmt ", body: pcmFmt },
    { id: "data", body: Uint8Array.of(1, 0, 2, 0) },
    { id: "fmt ", body: atracFmt },
    { id: "data", body: Uint8Array.of(9, 0, 9, 0) },
  ]);

  assert.deepEqual(Array.from(parsePcm16WavBuffer(wav).samples), [1, 2]);
});

test("parseAtracWavBuffer keeps the first fact chunk", () => {
  const { out: fmt, view } = createFormatChunk(32);
  view.setUint16(0, 0x0270, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 8269, true);
  view.setUint16(12, 192, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, 14, true);
  view.setUint16(18, 1, true);
  view.setUint32(20, 2 << 11, true);
  view.setUint16(24, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 1, true);
  view.setUint16(30, 0, true);

  const wav = buildRiffWave([
    { id: "fmt ", body: fmt },
    { id: "fact", body: Uint8Array.of(1, 0, 0, 0) },
    { id: "data", body: new Uint8Array(192) },
    { id: "fact", body: Uint8Array.of(9, 0, 0, 0) },
  ]);

  assert.deepEqual(parseAtracWavBuffer(wav).factRaw, [1]);
});

test("parseAtracWavBuffer reads fact chunks that follow data", () => {
  const { out: fmt, view } = createFormatChunk(32);
  view.setUint16(0, 0x0270, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 8269, true);
  view.setUint16(12, 192, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, 14, true);
  view.setUint16(18, 1, true);
  view.setUint32(20, 2 << 11, true);
  view.setUint16(24, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 1, true);
  view.setUint16(30, 0, true);

  const wav = buildRiffWave([
    { id: "fmt ", body: fmt },
    { id: "data", body: new Uint8Array(192) },
    { id: "fact", body: Uint8Array.of(1, 0, 0, 0) },
  ]);

  const parsed = parseAtracWavBuffer(wav);

  assert.deepEqual(parsed.factRaw, [1]);
  assert.equal(parsed.factSamples, 1);
});

test("parseAtracWavBuffer keeps the first fmt and data chunks", () => {
  const { out: atracFmt, view: atracFmtView } = createFormatChunk(32);
  atracFmtView.setUint16(0, 0x0270, true);
  atracFmtView.setUint16(2, 2, true);
  atracFmtView.setUint32(4, 44100, true);
  atracFmtView.setUint32(8, 8269, true);
  atracFmtView.setUint16(12, 192, true);
  atracFmtView.setUint16(14, 0, true);
  atracFmtView.setUint16(16, 14, true);
  atracFmtView.setUint16(18, 1, true);
  atracFmtView.setUint32(20, 2 << 11, true);
  atracFmtView.setUint16(24, 1, true);
  atracFmtView.setUint16(26, 1, true);
  atracFmtView.setUint16(28, 1, true);
  atracFmtView.setUint16(30, 0, true);

  const { out: pcmFmt, view: pcmFmtView } = createFormatChunk(16);
  pcmFmtView.setUint16(0, 1, true);
  pcmFmtView.setUint16(2, 1, true);
  pcmFmtView.setUint32(4, 44100, true);
  pcmFmtView.setUint32(8, 88200, true);
  pcmFmtView.setUint16(12, 2, true);
  pcmFmtView.setUint16(14, 16, true);

  const firstFrame = Uint8Array.from({ length: 192 }, (_, index) => index & 0xff);
  const laterFrame = Uint8Array.from({ length: 192 }, (_, index) => (255 - index) & 0xff);
  const wav = buildRiffWave([
    { id: "fmt ", body: atracFmt },
    { id: "data", body: firstFrame },
    { id: "fmt ", body: pcmFmt },
    { id: "data", body: laterFrame },
  ]);

  const parsed = parseAtracWavBuffer(wav);

  assert.deepEqual(Object.keys(parsed).sort(), [
    "atrac3Flag",
    "avgBytesPerSec",
    "bitrateKbps",
    "bitsPerSample",
    "channels",
    "codec",
    "dataSize",
    "factRaw",
    "factSamples",
    "formatTag",
    "frameBytes",
    "frameCount",
    "frameSamples",
    "frames",
    "sampleRate",
  ]);
  assert.equal(parsed.codec, "atrac3");
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.frameCount, 1);
  assert.deepEqual(Array.from(parsed.frames[0]), Array.from(firstFrame));
});

test("ATRAC and PCM WAV parsers reject missing fmt or data chunks", () => {
  const missingFmt = buildRiffWave([{ id: "data", body: Uint8Array.of(0, 0, 0, 0) }]);
  const missingData = buildRiffWave([{ id: "fmt ", body: createFormatChunk(16).out }]);

  assert.throws(() => parsePcm16WavBuffer(missingFmt), /missing fmt or data chunk/);
  assert.throws(() => parseAtracWavBuffer(missingFmt), /missing fmt or data chunk/);
  assert.throws(() => parsePcm16WavBuffer(missingData), /missing fmt or data chunk/);
  assert.throws(() => parseAtracWavBuffer(missingData), /missing fmt or data chunk/);
});

test("parsePcm16WavBuffer rejects non-PCM formats", () => {
  const { out, view } = createFormatChunk(16);
  view.setUint16(0, 0x0270, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 8269, true);
  view.setUint16(12, 192, true);
  view.setUint16(14, 16, true);
  const wav = buildRiffWave([
    { id: "fmt ", body: out },
    { id: "data", body: Uint8Array.of(0, 0, 0, 0) },
  ]);

  assert.throws(() => parsePcm16WavBuffer(wav), /unsupported PCM WAV format tag: 0x270/);
});

test("parsePcm16WavBuffer rejects PCM fmt chunks with mismatched blockAlign", () => {
  const { out, view } = createFormatChunk(16);
  view.setUint16(0, 1, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 88200, true);
  view.setUint16(12, 2, true);
  view.setUint16(14, 16, true);
  const wav = buildRiffWave([
    { id: "fmt ", body: out },
    { id: "data", body: Uint8Array.of(0, 0, 0, 0) },
  ]);

  assert.throws(() => parsePcm16WavBuffer(wav), /blockAlign/);
});

test("parsePcm16WavBuffer rejects PCM fmt chunks with mismatched avgBytesPerSec", () => {
  const { out, view } = createFormatChunk(16);
  view.setUint16(0, 1, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 0, true);
  view.setUint16(12, 4, true);
  view.setUint16(14, 16, true);
  const wav = buildRiffWave([
    { id: "fmt ", body: out },
    { id: "data", body: Uint8Array.of(0, 0, 0, 0) },
  ]);

  assert.throws(() => parsePcm16WavBuffer(wav), /avgBytesPerSec/);
});

test("parsePcm16WavBuffer rejects PCM data chunk sizes that are not block-aligned", () => {
  const { out, view } = createFormatChunk(16);
  view.setUint16(0, 1, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 176400, true);
  view.setUint16(12, 4, true);
  view.setUint16(14, 16, true);
  const wav = buildRiffWave([
    { id: "fmt ", body: out },
    { id: "data", body: Uint8Array.of(1, 0, 2, 0, 3, 0) },
  ]);

  assert.throws(() => parsePcm16WavBuffer(wav), /aligned to blockAlign/);
});

test("parsePcm16WavBuffer rejects odd PCM data sizes", () => {
  const { out, view } = createFormatChunk(16);
  view.setUint16(0, 1, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, 44100, true);
  view.setUint32(8, 88200, true);
  view.setUint16(12, 2, true);
  view.setUint16(14, 16, true);
  const wav = buildRiffWave([
    { id: "fmt ", body: out },
    { id: "data", body: Uint8Array.of(1, 2, 3) },
  ]);

  assert.throws(() => parsePcm16WavBuffer(wav), /PCM16 data chunk has odd byte length/);
});

test("parsePcm16WavBuffer preserves PCM data from odd byte offsets", () => {
  const pcm = Int16Array.from([1, -2, 300, -400]);
  const wav = createPcmBufferWriter(44100, 2, pcm).toPcmWavBuffer();
  const wrapped = new Uint8Array(wav.length + 1);
  wrapped.set(wav, 1);

  const parsed = parsePcm16WavBuffer(wrapped.subarray(1));

  assert.equal(parsed.dataSize, pcm.length * 2);
  assert.deepEqual(Array.from(parsed.samples), Array.from(pcm));
});

test("parseAtracWavBuffer round-trips ATRAC container metadata and frames", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const frameA = Uint8Array.from({ length: profile.frameBytes }, (_, index) => index & 0xff);
  const frameB = Uint8Array.from(
    { length: profile.frameBytes },
    (_, index) => (255 - index) & 0xff
  );
  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: [frameA, frameB],
    totalSamples: profile.frameSamples * 2,
    loopStart: 0,
    loopEnd: 511,
    factMode: 1,
  });

  const parsed = parseAtracWavBuffer(wav);

  assert.deepEqual(Object.keys(parsed).sort(), [
    "atracxCodecBytes",
    "atracxReserved",
    "atracxVersion",
    "avgBytesPerSec",
    "bitrateKbps",
    "bitsPerSample",
    "channelMask",
    "channels",
    "codec",
    "dataSize",
    "factRaw",
    "factSamples",
    "formatTag",
    "frameBytes",
    "frameCount",
    "frameSamples",
    "frames",
    "sampleRate",
  ]);
  assert.equal(parsed.codec, "atrac3plus");
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.frameBytes, profile.frameBytes);
  assert.equal(parsed.frameSamples, profile.frameSamples);
  assert.equal(parsed.frameCount, 2);
  assert.equal(parsed.dataSize, profile.frameBytes * 2);
  assert.equal(parsed.factSamples, profile.frameSamples * 2);
  assert.equal(parsed.factRaw.length, 3);
  assert.deepEqual(Array.from(parsed.frames[0]), Array.from(frameA));
  assert.deepEqual(Array.from(parsed.frames[1]), Array.from(frameB));
});

test("buildAtracWavBuffer rejects out-of-range loop points", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const totalSamples = profile.frameSamples;
  const encodedFrame = new Uint8Array(profile.frameBytes);

  assert.throws(
    () =>
      buildAtracWavBuffer({
        profile,
        encodedFrames: [encodedFrame],
        totalSamples,
        loopStart: 0,
        loopEnd: totalSamples,
      }),
    new RegExp(`loopEnd ${totalSamples} must be < totalSamples ${totalSamples}`)
  );
  assert.throws(
    () =>
      buildAtracWavBuffer({
        profile,
        encodedFrames: [encodedFrame],
        totalSamples,
        loopStart: totalSamples,
        loopEnd: totalSamples,
      }),
    new RegExp(`loopStart ${totalSamples} must be < totalSamples ${totalSamples}`)
  );
  assert.throws(
    () =>
      buildAtracWavBuffer({
        profile,
        encodedFrames: [encodedFrame],
        totalSamples,
        loopStart: -1,
        loopEnd: totalSamples,
      }),
    new RegExp(`loopEnd ${totalSamples} must be < totalSamples ${totalSamples}`)
  );
});

test("parseAtracWavBuffer ignores ATRAC3plus samplesPerBlock mismatches", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const encodedFrame = new Uint8Array(profile.frameBytes);
  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: [encodedFrame],
    totalSamples: profile.frameSamples,
  });

  const chunks = parseWavChunks(wav);
  const fmtChunk = chunks.find(({ id }) => id === "fmt ");
  assert.ok(fmtChunk);

  // Corrupt the WAVEFORMATEXTENSIBLE "samplesPerBlock" value at offset 18.
  fmtChunk.body[18] = 0x00;
  fmtChunk.body[19] = 0x04;

  const parsed = parseAtracWavBuffer(wav);
  assert.equal(parsed.codec, "atrac3plus");
  assert.equal(parsed.frameSamples, profile.frameSamples);
});

test("decodeParsedAtracWav preserves the package-private parsed-container decode seam", () => {
  const encoded = encodeAtrac3WavBufferFromInterleavedPcm(createPcm(1024 * 2), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const metadata = parseAtracWavBuffer(encoded.buffer);

  assert.deepEqual(
    Array.from(decodeParsedAtracWav(metadata)),
    Array.from(decodeAt3WavBuffer(encoded.buffer).pcm)
  );
});

test("decodeParsedAtracWav preserves the ATRAC3plus parsed-container decode seam", () => {
  const encoded = encodeAtracWavBufferFromInterleavedPcm(createPcm(2048 * 2), {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const metadata = parseAtracWavBuffer(encoded.buffer);

  assert.deepEqual(
    Array.from(decodeParsedAtracWav(metadata)),
    Array.from(decodeAt3WavBuffer(encoded.buffer).pcm)
  );
});

test("decodeParsedAtracWav rejects unsupported parsed codecs", () => {
  assert.throws(() => decodeParsedAtracWav({ codec: "pcm" }), /unsupported ATRAC WAV codec: pcm/);
});

test("createDecodedAtracWavResult preserves the shared decoded-container result shape", () => {
  const encoded = encodeAtrac3WavBufferFromInterleavedPcm(createPcm(1024 * 2), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const metadata = parseAtracWavBuffer(encoded.buffer);
  const result = createDecodedAtracWavResult(metadata);
  const direct = decodeAt3WavBuffer(encoded.buffer);

  assert.deepEqual(Object.keys(result).sort(), ["metadata", "pcm", "toPcmWavBuffer"]);
  assert.deepEqual(result.metadata, metadata);
  assert.deepEqual(Array.from(result.pcm), Array.from(direct.pcm));
  assert.deepEqual(result.toPcmWavBuffer(), direct.toPcmWavBuffer());
});

test("splitFrames preserves current validation errors and empty-input behavior", () => {
  assert.deepEqual(splitFrames(new Uint8Array(0), 4), []);
  assert.deepEqual(splitFrames(new Uint8Array(0).buffer, 4), []);
  assert.throws(() => splitFrames(Uint8Array.of(1, 2), 0), /invalid frame size: 0/);
  assert.throws(
    () => splitFrames(Uint8Array.of(1, 2, 3), 2),
    /data chunk size 3 is not aligned to frame size 2/
  );
  assert.deepEqual(
    splitFrames(Uint8Array.of(1, 2, 3, 4).buffer, 2).map((frame) => Array.from(frame)),
    [
      [1, 2],
      [3, 4],
    ]
  );
});
