#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { CodecError } from "./common/errors.js";
import { decodeAt3WavContainer, parsePcm16WavBuffer } from "./container/node.js";
import { encodeAtracWavBufferFromInterleavedPcm } from "./encoders/atrac.js";

const USAGE_LINES = [
  "usage: carta3 decode input.at3.wav output.pcm.wav",
  "       carta3 encode input.pcm.wav output.at3.wav [--bitrate kbps] [--codec atrac3|atrac3plus]",
  "       carta3 --help",
];
const DEFAULT_ENCODE_OPTIONS = Object.freeze({
  bitrateKbps: 132,
  codec: "atrac3",
});

function usage(code) {
  console.error(USAGE_LINES.join("\n"));
  return code;
}

function parsePositiveIntegerOption(name, value) {
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new CodecError(`invalid ${name} value: ${value}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CodecError(`invalid ${name} value: ${value}`);
  }
  return parsed;
}

function parseEncodeArgs(argv) {
  const options = {
    ...DEFAULT_ENCODE_OPTIONS,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--bitrate": {
        const value = argv[index + 1];
        if (!value) {
          throw new CodecError(`missing value for ${token}`);
        }
        options.bitrateKbps = parsePositiveIntegerOption(token, value);
        index += 1;
        break;
      }
      case "--codec": {
        const value = argv[index + 1];
        if (!value) {
          throw new CodecError(`missing value for ${token}`);
        }
        options.codec = String(value);
        index += 1;
        break;
      }
      default:
        if (token.startsWith("--")) {
          throw new CodecError(`unknown option: ${token}`);
        }
        positional.push(token);
        break;
    }
  }

  if (positional.length !== 2) {
    throw new CodecError("encode requires input and output paths");
  }

  if (options.codec !== "atrac3" && options.codec !== "atrac3plus") {
    throw new CodecError(`unsupported --codec value: ${options.codec}`);
  }

  const [inputPath, outputPath] = positional;

  return {
    inputPath,
    outputPath,
    ...options,
  };
}

async function runDecodeCommand(argv) {
  const [inputPath, outputPath] = argv;
  if (!inputPath || !outputPath || argv.length !== 2) {
    return usage(2);
  }

  const result = await decodeAt3WavContainer(inputPath);
  await result.writePcmWav(outputPath);
  return 0;
}

async function runEncodeCommand(argv) {
  const { inputPath, outputPath, bitrateKbps, codec } = parseEncodeArgs(argv);
  const { samples, channels, sampleRate } = parsePcm16WavBuffer(await readFile(inputPath));
  const { buffer } = encodeAtracWavBufferFromInterleavedPcm(samples, {
    codec,
    bitrateKbps,
    channels,
    sampleRate,
  });
  await writeFile(outputPath, buffer);
  return 0;
}

async function main(argv) {
  const [, , command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return usage(0);
  }

  switch (command) {
    case "decode":
      return runDecodeCommand(rest);
    case "encode":
      return runEncodeCommand(rest);
    default:
      return usage(2);
  }
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
