import assert from "node:assert/strict";
import test from "node:test";

import * as BrowserContainer from "../../src/container/index.js";
import * as NodeContainer from "../../src/container/node.js";
import { createPcmBufferWriter } from "../../src/container/pcm-writer.js";
import { parseAtracWavBuffer } from "../../src/container/wav-parse.js";
import {
  createPcmWriter as createNodePcmWriter,
  decodeAt3WavContainer,
} from "../../src/container/node.js";

test("browser container barrel exposes only browser-safe WAV helpers", () => {
  assert.equal(BrowserContainer.createPcmWriter, createPcmBufferWriter);
  assert.equal(BrowserContainer.parseAtracWavBuffer, parseAtracWavBuffer);

  assert.equal("buildAtracWavBuffer" in BrowserContainer, false);
  assert.equal("createAtracEncodeWavFormat" in BrowserContainer, false);
  assert.equal("createPcmBufferWriter" in BrowserContainer, false);
  assert.equal("createDecodedAtracWavResult" in BrowserContainer, false);
  assert.equal("decodeParsedAtracWav" in BrowserContainer, false);
  assert.equal("decodeAt3WavContainer" in BrowserContainer, false);
});

test("node container barrel exposes the filesystem-aware container helpers", () => {
  assert.equal(NodeContainer.createPcmWriter, createNodePcmWriter);
  assert.equal(NodeContainer.decodeAt3WavContainer, decodeAt3WavContainer);
  assert.equal(NodeContainer.parseAtracWavBuffer, parseAtracWavBuffer);

  assert.equal("buildAtracWavBuffer" in NodeContainer, false);
  assert.equal("createAtracEncodeWavFormat" in NodeContainer, false);
  assert.equal("createPcmBufferWriter" in NodeContainer, false);
  assert.equal("createDecodedAtracWavResult" in NodeContainer, false);
  assert.equal("decodeParsedAtracWav" in NodeContainer, false);
});
