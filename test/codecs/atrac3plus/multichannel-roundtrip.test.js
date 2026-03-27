import assert from "node:assert/strict";
import test from "node:test";

import { decodeParsedAtracWav } from "../../../src/container/decode.js";
import { parseAtracWavBuffer } from "../../../src/container/wav-parse.js";
import { encodeAtracWavBufferFromInterleavedPcm } from "../../../src/encoders/atrac.js";

function createInterleavedPcm(channels, samplesPerChannel) {
  const pcm = new Int16Array(channels * samplesPerChannel);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = ((index * 37) % 2000) - 1000;
  }
  return pcm;
}

test("ATRAC3plus 6-channel encode/decode preserves sample counts", () => {
  const channels = 6;
  const samplesPerChannel = 128;
  const pcm = createInterleavedPcm(channels, samplesPerChannel);
  const encoded = encodeAtracWavBufferFromInterleavedPcm(pcm, {
    codec: "atrac3plus",
    bitrateKbps: 192,
    channels,
    sampleRate: 44100,
  });
  const parsed = parseAtracWavBuffer(encoded.buffer);

  assert.equal(parsed.codec, "atrac3plus");
  assert.equal(parsed.channels, channels);
  assert.equal(parsed.sampleRate, 44100);

  const decoded = decodeParsedAtracWav(parsed);
  assert.equal(decoded.length, pcm.length);
});

test("ATRAC3plus 8-channel encode/decode preserves sample counts", () => {
  const channels = 8;
  const samplesPerChannel = 128;
  const pcm = createInterleavedPcm(channels, samplesPerChannel);
  const encoded = encodeAtracWavBufferFromInterleavedPcm(pcm, {
    codec: "atrac3plus",
    bitrateKbps: 768,
    channels,
    sampleRate: 48000,
  });
  const parsed = parseAtracWavBuffer(encoded.buffer);

  assert.equal(parsed.codec, "atrac3plus");
  assert.equal(parsed.channels, channels);
  assert.equal(parsed.sampleRate, 48000);

  const decoded = decodeParsedAtracWav(parsed);
  assert.equal(decoded.length, pcm.length);
});
