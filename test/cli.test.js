import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAtracWavBuffer, parsePcm16WavBuffer } from "../src/container/index.js";
import { createPcmWriter } from "../src/container/node.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function createPcm(sampleCount) {
  return Int16Array.from({ length: sampleCount }, (_, index) => ((index * 37) % 200) - 100);
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
  });
}

async function createTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "carta-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("CLI prints usage for --help", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^usage: carta3 decode input\.at3\.wav output\.pcm\.wav/m);
});

test("CLI prints usage when no command is provided", () => {
  const result = runCli([]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^usage: carta3 decode input\.at3\.wav output\.pcm\.wav/m);
});

test("CLI encode rejects invalid bitrate values", () => {
  for (const value of ["zero", "128kbps"]) {
    const result = runCli(["encode", "input.wav", "output.at3.wav", "--bitrate", value]);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^invalid --bitrate value: ${value}$`, "m"));
  }
});

test("CLI encode rejects missing option values", () => {
  for (const option of ["--bitrate", "--codec"]) {
    const result = runCli(["encode", "input.wav", "output.at3.wav", option]);
    const expectedError = new RegExp(`^missing value for ${option}$`, "m");

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, expectedError);
  }
});

test("CLI encode rejects unsupported codec values", () => {
  const result = runCli(["encode", "input.wav", "output.at3.wav", "--codec", "pcm"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^unsupported --codec value: pcm$/m);
});

test("CLI encode rejects unknown options", () => {
  const result = runCli(["encode", "input.wav", "output.at3.wav", "--nope"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^unknown option: --nope$/m);
});

test("CLI decode prints usage when paths are missing", () => {
  const result = runCli(["decode", "input.at3.wav"]);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^usage: carta3 decode input\.at3\.wav output\.pcm\.wav/m);
});

test("CLI encode and decode preserve current file-flow behavior", async (t) => {
  const dir = await createTempDir(t);
  const inputPath = join(dir, "input.wav");
  const encodedPath = join(dir, "output.at3.wav");
  const decodedPath = join(dir, "decoded.wav");

  await writeFile(inputPath, createPcmWriter(44100, 2, createPcm(1024 * 2)).toPcmWavBuffer());

  const encodeResult = runCli([
    "encode",
    inputPath,
    encodedPath,
    "--bitrate",
    "66",
    "--codec",
    "atrac3",
  ]);

  assert.equal(encodeResult.status, 0);
  assert.equal(encodeResult.stdout, "");
  assert.equal(encodeResult.stderr, "");

  const encoded = parseAtracWavBuffer(await readFile(encodedPath));
  assert.equal(encoded.codec, "atrac3");
  assert.equal(encoded.frameCount, 3);

  const decodeResult = runCli(["decode", encodedPath, decodedPath]);

  assert.equal(decodeResult.status, 0);
  assert.equal(decodeResult.stdout, "");
  assert.equal(decodeResult.stderr, "");

  const decoded = parsePcm16WavBuffer(await readFile(decodedPath));
  assert.equal(decoded.sampleRate, 44100);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.samples.length, 1024 * 2);
});

test("CLI encode preserves the current default ATRAC3 encode options", async (t) => {
  const dir = await createTempDir(t);
  const inputPath = join(dir, "input.wav");
  const encodedPath = join(dir, "output.at3.wav");

  await writeFile(inputPath, createPcmWriter(44100, 2, createPcm(1024 * 2)).toPcmWavBuffer());

  const result = runCli(["encode", inputPath, encodedPath]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  const encoded = parseAtracWavBuffer(await readFile(encodedPath));
  assert.equal(encoded.codec, "atrac3");
  assert.equal(encoded.frameBytes, 384);
});
