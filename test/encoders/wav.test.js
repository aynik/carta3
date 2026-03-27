import assert from "node:assert/strict";
import test from "node:test";

import { parseAtracWavBuffer } from "../../src/container/index.js";
import { createAtracEncodeWavFormat } from "../../src/container/wav-format.js";
import { buildAtracWavBuffer } from "../../src/container/wav-build.js";
import { selectAtracEncodeProfile } from "../../src/encoders/profiles.js";

test("createAtracEncodeWavFormat maps ATRAC3 and ATRAC3plus profiles to WAV metadata", () => {
  const atrac3 = selectAtracEncodeProfile(66, 2, 44100);
  const atrac3plus = selectAtracEncodeProfile(96, 2, 44100);

  assert.deepEqual(createAtracEncodeWavFormat(atrac3), {
    codec: "atrac3",
    formatTag: 0x0270,
    formatChunkBytes: 32,
    channels: 2,
    sampleRate: 44100,
    avgBytesPerSec: 8269,
    blockAlign: 192,
    bitsPerSample: 0,
    frameSamples: 1024,
    atrac3Flag: 1,
  });

  assert.equal(createAtracEncodeWavFormat(selectAtracEncodeProfile(132, 2, 44100)).atrac3Flag, 0);

  assert.deepEqual(createAtracEncodeWavFormat(atrac3plus), {
    codec: "atrac3plus",
    formatTag: 0xfffe,
    formatChunkBytes: 52,
    channels: 2,
    sampleRate: 44100,
    avgBytesPerSec: 12059,
    blockAlign: 560,
    bitsPerSample: 0,
    frameSamples: 2048,
    extSize: 34,
    samplesPerBlock: 2048,
    channelMask: 0x3,
    atracxVersion: 1,
    atracxCodecBytes: atrac3plus.atracxCodecBytes,
    atracxReserved: new Uint8Array(8),
  });
});

test("createAtracEncodeWavFormat rejects unsupported codecs", () => {
  assert.throws(
    () =>
      createAtracEncodeWavFormat({
        codec: "pcm",
        frameBytes: 192,
        frameSamples: 1024,
        sampleRate: 44100,
      }),
    /unsupported ATRAC codec: pcm/
  );
});

test("createAtracEncodeWavFormat rejects null profiles without crashing", () => {
  assert.throws(() => createAtracEncodeWavFormat(null), /profile must be an object/);
});

test("createAtracEncodeWavFormat requires ATRAC3 transport flags from the profile catalog", () => {
  assert.throws(
    () =>
      createAtracEncodeWavFormat({
        codec: "atrac3",
        mode: 2,
        channels: 2,
        sampleRate: 44100,
        frameBytes: 192,
        frameSamples: 1024,
      }),
    /missing ATRAC3 flag on encode profile/
  );
});

test("createAtracEncodeWavFormat keeps the fmt chunk size with the format metadata", () => {
  const atrac3 = createAtracEncodeWavFormat(selectAtracEncodeProfile(66, 2, 44100));
  const atrac3plus = createAtracEncodeWavFormat(selectAtracEncodeProfile(96, 2, 44100));

  assert.equal(atrac3.formatChunkBytes, 32);
  assert.equal(atrac3plus.formatChunkBytes, 52);
});

test("buildAtracWavBuffer rejects null requests without crashing", () => {
  assert.throws(() => buildAtracWavBuffer(null), /profile is required/);
});

test("buildAtracWavBuffer accepts ArrayBuffer view frames", () => {
  const profile = selectAtracEncodeProfile(66, 2, 44100);
  const source = Uint8Array.from(
    { length: profile.frameBytes * 2 + 1 },
    (_, index) => index & 0xff
  );
  const firstFrame = new DataView(source.buffer, 1, profile.frameBytes);
  const secondFrame = source.subarray(profile.frameBytes + 1);
  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: [firstFrame, secondFrame],
    totalSamples: profile.frameSamples * 2,
  });
  const parsed = parseAtracWavBuffer(wav);

  assert.deepEqual(
    Array.from(parsed.frames[0]),
    Array.from(source.subarray(1, profile.frameBytes + 1))
  );
  assert.deepEqual(Array.from(parsed.frames[1]), Array.from(secondFrame));
});

test("buildAtracWavBuffer accepts one contiguous ArrayBuffer view payload", () => {
  const profile = selectAtracEncodeProfile(66, 2, 44100);
  const source = Uint8Array.from(
    { length: profile.frameBytes * 2 + 2 },
    (_, index) => (index * 29) & 0xff
  );
  const payload = new DataView(source.buffer, 1, profile.frameBytes * 2);
  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: payload,
    totalSamples: profile.frameSamples * 2,
  });
  const parsed = parseAtracWavBuffer(wav);

  assert.deepEqual(
    Array.from(parsed.frames[0]),
    Array.from(source.subarray(1, profile.frameBytes + 1))
  );
  assert.deepEqual(
    Array.from(parsed.frames[1]),
    Array.from(source.subarray(profile.frameBytes + 1, profile.frameBytes * 2 + 1))
  );
});

test("buildAtracWavBuffer rejects misaligned encoded frame data", () => {
  const profile = selectAtracEncodeProfile(66, 2, 44100);

  assert.throws(
    () =>
      buildAtracWavBuffer({
        profile,
        encodedFrames: Uint8Array.of(1, 2, 3),
        totalSamples: profile.frameSamples,
      }),
    /not aligned to frame size/
  );

  assert.throws(
    () =>
      buildAtracWavBuffer({
        profile,
        encodedFrames: [Uint8Array.of(1, 2, 3)],
        totalSamples: profile.frameSamples,
      }),
    /expected 192/
  );
});

test("buildAtracWavBuffer validateTrim rejects payloads that cannot satisfy the FACT trim window", () => {
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const frameBytes = profile.frameBytes;
  const frame1 = new Uint8Array(frameBytes);
  const frame2 = new Uint8Array(frameBytes);
  const frame3 = new Uint8Array(frameBytes);

  assert.throws(
    () =>
      buildAtracWavBuffer({
        profile,
        encodedFrames: [frame1, frame2],
        totalSamples: profile.frameSamples,
        validateTrim: true,
      }),
    /encoded frames are too short/
  );

  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: [frame1, frame2, frame3],
    totalSamples: profile.frameSamples,
    validateTrim: true,
  });
  assert.equal(parseAtracWavBuffer(wav).frameCount, 3);
});
