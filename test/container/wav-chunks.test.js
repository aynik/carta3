import assert from "node:assert/strict";
import test from "node:test";

import { ATRAC3PLUS_DELAY_SAMPLES, computeAtracEncodeFactParam } from "../../src/encoders/fact.js";
import { selectAtracEncodeProfile } from "../../src/encoders/profiles.js";
import { createAtracWavChunks } from "../../src/container/wav-chunks.js";
import { parseAtracFormat } from "../../src/container/wav-format.js";
import { createAtracEncodeWavFormat } from "../../src/container/wav-format.js";
import { parseFactChunk } from "../../src/container/wav-parse.js";

function readU32LE(buf, offset) {
  return (
    (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
  );
}

test("createAtracWavChunks preserves ATRAC3plus chunk order and factMode 0 loop offsets", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const format = createAtracEncodeWavFormat(profile);
  const dataBytes = Uint8Array.from({ length: profile.frameBytes }, (_, index) => index & 0xff);
  const loopStart = 10;
  const loopEnd = 20;
  const chunks = createAtracWavChunks({
    format,
    profile,
    dataBytes,
    totalSamples: profile.frameSamples,
    loopStart,
    loopEnd,
    factMode: 0,
  });
  const factParam = computeAtracEncodeFactParam(
    loopEnd,
    profile.frameSamples,
    ATRAC3PLUS_DELAY_SAMPLES,
    ATRAC3PLUS_DELAY_SAMPLES
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    ["fmt ", "fact", "smpl", "data"]
  );
  assert.equal(parseAtracFormat(chunks[0].body).codec, "atrac3plus");
  assert.deepEqual(parseFactChunk(chunks[1].body).raw, [
    profile.frameSamples,
    factParam - ATRAC3PLUS_DELAY_SAMPLES,
  ]);
  assert.equal(readU32LE(chunks[2].body, 44), loopStart + factParam - ATRAC3PLUS_DELAY_SAMPLES);
  assert.equal(readU32LE(chunks[2].body, 48), loopEnd + factParam - ATRAC3PLUS_DELAY_SAMPLES);
  assert.deepEqual(Array.from(chunks[3].body), Array.from(dataBytes));
});

test("createAtracWavChunks preserves factMode 1 values and omits smpl without a loop", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const format = createAtracEncodeWavFormat(profile);
  const dataBytes = new Uint8Array(profile.frameBytes * 2);
  const totalSamples = profile.frameSamples * 2;
  const chunks = createAtracWavChunks({
    format,
    profile,
    dataBytes,
    totalSamples,
    loopStart: -1,
    loopEnd: -1,
    factMode: 1,
  });
  const factParam = computeAtracEncodeFactParam(
    -1,
    profile.frameSamples,
    ATRAC3PLUS_DELAY_SAMPLES,
    ATRAC3PLUS_DELAY_SAMPLES
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    ["fmt ", "fact", "data"]
  );
  assert.deepEqual(parseFactChunk(chunks[1].body).raw, [
    totalSamples,
    factParam - ATRAC3PLUS_DELAY_SAMPLES,
    factParam,
  ]);
});

test("createAtracWavChunks preserves ATRAC3 factMode 0 loop offsets without delay subtraction", () => {
  const profile = selectAtracEncodeProfile(66, 2, 44100);
  const format = createAtracEncodeWavFormat(profile);
  const loopStart = 10;
  const loopEnd = 20;
  const chunks = createAtracWavChunks({
    format,
    profile,
    dataBytes: new Uint8Array(profile.frameBytes),
    totalSamples: profile.frameSamples,
    loopStart,
    loopEnd,
    factMode: 0,
  });
  const factParam = computeAtracEncodeFactParam(loopEnd, profile.frameSamples, 0, 69);

  assert.equal(readU32LE(chunks[2].body, 44), loopStart + factParam);
  assert.equal(readU32LE(chunks[2].body, 48), loopEnd + factParam);
});

test("createAtracWavChunks rejects unsupported fact modes", () => {
  const profile = selectAtracEncodeProfile(66, 2, 44100);
  const format = createAtracEncodeWavFormat(profile);

  assert.throws(
    () =>
      createAtracWavChunks({
        format,
        profile,
        dataBytes: new Uint8Array(profile.frameBytes),
        totalSamples: profile.frameSamples,
        loopStart: -1,
        loopEnd: -1,
        factMode: 2,
      }),
    /unsupported factMode: 2/
  );
});

test("createAtracWavChunks rejects totalSamples that exceed u32", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const format = createAtracEncodeWavFormat(profile);

  assert.throws(
    () =>
      createAtracWavChunks({
        format,
        profile,
        dataBytes: new Uint8Array(profile.frameBytes),
        totalSamples: 0x1_0000_0000,
        loopStart: -1,
        loopEnd: -1,
        factMode: 1,
      }),
    /invalid totalSamples: 4294967296/
  );
});

test("createAtracWavChunks rejects loop points that overflow smpl offsets", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const format = createAtracEncodeWavFormat(profile);
  const totalSamples = 0xffffffff;
  const loopStart = totalSamples - 1000;
  const loopEnd = loopStart + 10;

  assert.throws(
    () =>
      createAtracWavChunks({
        format,
        profile,
        dataBytes: new Uint8Array(profile.frameBytes),
        totalSamples,
        loopStart,
        loopEnd,
        factMode: 1,
      }),
    /invalid smpl loop(Start|End):/
  );
});

test("createAtracWavChunks rejects smpl writes when sampleRate is missing", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const format = createAtracEncodeWavFormat(profile);
  format.sampleRate = 0;

  assert.throws(
    () =>
      createAtracWavChunks({
        format,
        profile,
        dataBytes: new Uint8Array(profile.frameBytes),
        totalSamples: profile.frameSamples,
        loopStart: 0,
        loopEnd: 1,
        factMode: 1,
      }),
    /invalid smpl sampleRate: 0/
  );
});
