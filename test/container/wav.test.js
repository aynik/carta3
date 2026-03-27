import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeAt3WavBuffer as decodeBrowserAt3WavBuffer,
  parseAtracWavBuffer,
  parsePcm16WavBuffer,
} from "../../src/container/index.js";
import {
  createPcmWriter,
  decodeAt3WavBuffer,
  decodeAt3WavContainer,
} from "../../src/container/node.js";
import { encodeAtracWavBufferFromInterleavedPcm } from "../../src/encoders/atrac.js";
import { encodeAtrac3WavBufferFromInterleavedPcm } from "../../src/encoders/atrac3.js";

async function createTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "carta-wav-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function createPcm(sampleCount) {
  return Int16Array.from({ length: sampleCount }, (_, index) => ((index * 37) % 200) - 100);
}

test("createPcmWriter writes the same PCM WAV bytes it exposes in memory", async (t) => {
  const dir = await createTempDir(t);
  const writer = createPcmWriter(44100, 2, Int16Array.from([1, -2, 300, -400]));
  const { writePcmWav } = writer;
  const outputPath = join(dir, "output.wav");

  assert.deepEqual(Object.keys(writer).sort(), ["pcm", "toPcmWavBuffer", "writePcmWav"]);
  await writePcmWav(outputPath);

  assert.deepEqual(new Uint8Array(await readFile(outputPath)), writer.toPcmWavBuffer());
});

test("decodeAt3WavBuffer preserves metadata and writes decodable PCM WAV output", async (t) => {
  const dir = await createTempDir(t);
  const encoded = encodeAtrac3WavBufferFromInterleavedPcm(createPcm(1024 * 2), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const parsedMetadata = parseAtracWavBuffer(encoded.buffer);
  const decoded = decodeAt3WavBuffer(encoded.buffer);
  const outputPath = join(dir, "decoded.wav");

  await decoded.writePcmWav(outputPath);

  const writtenBytes = new Uint8Array(await readFile(outputPath));
  const parsed = parsePcm16WavBuffer(writtenBytes);
  assert.deepEqual(decoded.metadata, parsedMetadata);
  assert.equal(decoded.metadata.codec, "atrac3");
  assert.equal(decoded.metadata.frameCount, encoded.encodedFrames.length);
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.channels, 2);
  assert.deepEqual(Array.from(parsed.samples), Array.from(decoded.pcm));
  assert.deepEqual(writtenBytes, decoded.toPcmWavBuffer());
});

test("decodeAt3WavBuffer preserves the current ATRAC3plus container dispatch", () => {
  const encoded = encodeAtracWavBufferFromInterleavedPcm(createPcm(2048 * 2), {
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
  });
  const parsedMetadata = parseAtracWavBuffer(encoded.buffer);
  const decoded = decodeAt3WavBuffer(encoded.buffer);
  const parsedPcm = parsePcm16WavBuffer(decoded.toPcmWavBuffer());

  assert.deepEqual(decoded.metadata, parsedMetadata);
  assert.equal(decoded.metadata.codec, "atrac3plus");
  assert.equal(decoded.metadata.frameCount, encoded.encodedFrames.length);
  assert.equal(parsedPcm.sampleRate, 44100);
  assert.equal(parsedPcm.channels, 2);
  assert.deepEqual(Array.from(parsedPcm.samples), Array.from(decoded.pcm));
});

test("node decodeAt3WavBuffer extends the shared browser-safe decoded result", () => {
  const encoded = encodeAtrac3WavBufferFromInterleavedPcm(createPcm(1024 * 2), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const browserDecoded = decodeBrowserAt3WavBuffer(encoded.buffer);
  const nodeDecoded = decodeAt3WavBuffer(encoded.buffer);

  assert.equal(typeof browserDecoded.writePcmWav, "undefined");
  assert.equal(typeof nodeDecoded.writePcmWav, "function");
  assert.deepEqual(Object.keys(nodeDecoded).sort(), [
    "metadata",
    "pcm",
    "toPcmWavBuffer",
    "writePcmWav",
  ]);
  assert.deepEqual(nodeDecoded.metadata, browserDecoded.metadata);
  assert.deepEqual(Array.from(nodeDecoded.pcm), Array.from(browserDecoded.pcm));
  assert.deepEqual(nodeDecoded.toPcmWavBuffer(), browserDecoded.toPcmWavBuffer());
});

test("decodeAt3WavContainer reads ATRAC WAV files from disk", async (t) => {
  const dir = await createTempDir(t);
  const encoded = encodeAtrac3WavBufferFromInterleavedPcm(createPcm(1024 * 2), {
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
  });
  const inputPath = join(dir, "input.at3.wav");

  await writeFile(inputPath, encoded.buffer);

  const decoded = await decodeAt3WavContainer(inputPath);

  assert.equal(decoded.metadata.codec, "atrac3");
  assert.equal(decoded.metadata.frameCount, encoded.encodedFrames.length);
  assert.equal(decoded.pcm.length, 1024 * 2);
});
