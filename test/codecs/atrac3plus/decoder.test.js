import assert from "node:assert/strict";
import test from "node:test";

import { Atrac3PlusDecoder } from "../../../src/atrac3plus/decoder.js";
import { parseAtracWavBuffer } from "../../../src/container/index.js";
import { buildAtracWavBuffer } from "../../../src/container/wav-build.js";
import { encodeAtrac3plusFramesFromInterleavedPcm } from "../../../src/encoders/atrac3plus.js";
import { selectAtracEncodeProfile } from "../../../src/encoders/profiles.js";

function createPcm(sampleCount) {
  return Int16Array.from({ length: sampleCount }, (_, index) => ((index * 53) % 400) - 200);
}

function createAtrac3PlusContainer() {
  const encoded = encodeAtrac3plusFramesFromInterleavedPcm(createPcm(2048 * 2), {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const profile = selectAtracEncodeProfile(96, 2, 44100);
  const wav = buildAtracWavBuffer({
    profile,
    encodedFrames: encoded.encodedFrames,
    totalSamples: encoded.totalSamples,
  });

  return parseAtracWavBuffer(wav);
}

test("Atrac3PlusDecoder preserves current trimmed output", () => {
  const container = createAtrac3PlusContainer();
  const pcm = new Atrac3PlusDecoder(container).decodeFrames(
    container.frames.map((frame) => new DataView(frame.buffer, frame.byteOffset, frame.byteLength)),
    container.factSamples,
    container.factRaw
  ).pcm;

  assert.equal(pcm.length, 4096);
  assert.deepEqual(
    Array.from(pcm.slice(0, 16)),
    [-138, -90, -116, -66, 36, 97, 42, 110, -106, -58, -88, -67, 75, 100, 56, 118]
  );
});

test("Atrac3PlusDecoder preserves current fact fallback trim", () => {
  const container = createAtrac3PlusContainer();
  const pcm = new Atrac3PlusDecoder(container).decodeFrames(container.frames).pcm;

  assert.equal(pcm.length, 7824);
  assert.deepEqual(Array.from(pcm.slice(0, 16)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("Atrac3PlusDecoder preserves current two-word fact trim fallback", () => {
  const container = createAtrac3PlusContainer();
  const pcm = new Atrac3PlusDecoder(container).decodeFrames(
    container.frames,
    container.factSamples,
    container.factRaw.slice(0, 2)
  ).pcm;

  assert.equal(pcm.length, 4096);
  assert.deepEqual(Array.from(pcm.slice(0, 16)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("Atrac3PlusDecoder preserves current null-fact trim fallback", () => {
  const container = createAtrac3PlusContainer();
  const pcm = new Atrac3PlusDecoder(container).decodeFrames(
    container.frames,
    container.factSamples,
    null
  ).pcm;

  assert.equal(pcm.length, 4096);
  assert.deepEqual(Array.from(pcm.slice(0, 16)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("Atrac3PlusDecoder preserves current validation errors", () => {
  const container = createAtrac3PlusContainer();
  const decoder = new Atrac3PlusDecoder(container);

  assert.throws(() => decoder.decodeFrames([]), /ATRAC3plus input has no frames/);
  assert.throws(
    () =>
      decoder.decodeFrames(
        [container.frames[0].subarray(0, container.frameBytes - 1)],
        container.factSamples,
        container.factRaw
      ),
    /invalid ATRAC3plus frame length at index 0 \(expected 560, got 559\)/
  );
  assert.throws(
    () =>
      new Atrac3PlusDecoder({ channels: 2, frameBytes: 560, sampleRate: 44100 }).decodeFrames([
        new Uint8Array(560),
      ]),
    /ATRAC3plus decode handle is not initialized \(missing codec bytes\/mode\)/
  );
});

test("Atrac3PlusDecoder unpack errors include failing block and channel context", () => {
  const container = createAtrac3PlusContainer();
  const decoder = new Atrac3PlusDecoder(container);
  const corrupted = new Uint8Array(container.frameBytes);
  corrupted.fill(0xff);
  corrupted[0] = 0x3f;

  assert.throws(
    () => decoder.decodeFrames([corrupted], container.factSamples, container.factRaw),
    /ATRAC3plus unpack failed at frame 0: .*block=0 .*channelErrors=\[.*\] .*channel=0/
  );
});
