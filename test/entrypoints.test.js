import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as browserApi from "../src/browser.js";
import * as nodeApi from "../src/index.js";
import * as atrac3Api from "../src/atrac3/index.js";
import * as atrac3plusApi from "../src/atrac3plus/index.js";
import * as browserContainer from "../src/container/index.js";
import * as nodeContainer from "../src/container/node.js";
import * as encoderApi from "../src/encoders/index.js";
import { computeAtracEncodePadPlan } from "../src/encoders/pcm.js";
import { encodeAtracFramesFromInterleavedPcm } from "../src/encoders/atrac.js";

function sortedKeys(module) {
  return Object.keys(module).sort();
}

function readLocalText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("browser and node entrypoints preserve shared public exports", () => {
  assert.equal(browserApi.computeAtracEncodePadPlan, computeAtracEncodePadPlan);
  assert.equal(nodeApi.computeAtracEncodePadPlan, computeAtracEncodePadPlan);
  assert.equal(browserApi.encodeAtracFramesFromInterleavedPcm, encodeAtracFramesFromInterleavedPcm);
  assert.equal(nodeApi.encodeAtracFramesFromInterleavedPcm, encodeAtracFramesFromInterleavedPcm);
  assert.equal(browserApi.parseAtracWavBuffer, browserContainer.parseAtracWavBuffer);
  assert.equal(nodeApi.parseAtracWavBuffer, nodeContainer.parseAtracWavBuffer);
});

test("entrypoints preserve the current browser-vs-node PCM writer contract", () => {
  const browserWriter = browserApi.createPcmWriter(44100, 2, Int16Array.from([1, -2]));
  const nodeWriter = nodeApi.createPcmWriter(44100, 2, Int16Array.from([1, -2]));

  assert.equal(browserApi.createPcmWriter, browserContainer.createPcmWriter);
  assert.equal(nodeApi.createPcmWriter, nodeContainer.createPcmWriter);
  assert.equal(typeof browserWriter.writePcmWav, "undefined");
  assert.equal(typeof nodeWriter.writePcmWav, "function");
  assert.deepEqual(browserWriter.toPcmWavBuffer(), nodeWriter.toPcmWavBuffer());
});

test("browser and node entrypoints preserve current container-specific exports", () => {
  assert.equal(typeof browserApi.decodeAt3WavContainer, "undefined");
  assert.equal(typeof nodeApi.decodeAt3WavContainer, "function");
});

test("browser entrypoint stays aligned with the curated browser subpath surface", () => {
  const expectedBrowserKeys = Array.from(
    new Set([
      ...Object.keys(atrac3Api),
      ...Object.keys(atrac3plusApi),
      ...Object.keys(encoderApi),
      ...Object.keys(browserContainer),
    ])
  ).sort();

  assert.deepEqual(sortedKeys(browserApi), expectedBrowserKeys);
});

test("node entrypoint stays aligned with the curated node subpath surface", () => {
  const expectedNodeKeys = Array.from(
    new Set([
      ...Object.keys(atrac3Api),
      ...Object.keys(atrac3plusApi),
      ...Object.keys(encoderApi),
      ...Object.keys(nodeContainer),
    ])
  ).sort();

  assert.deepEqual(sortedKeys(nodeApi), expectedNodeKeys);
});

test("root declaration entrypoints mirror the runtime barrel composition", () => {
  const browserDeclarations = readLocalText("../src/browser.d.ts");
  const nodeDeclarations = readLocalText("../src/index.d.ts");

  for (const exportLine of [
    'export * from "./atrac3/index.js";',
    'export * from "./atrac3plus/index.js";',
    'export * from "./encoders/index.js";',
  ]) {
    assert.equal(browserDeclarations.includes(exportLine), true);
    assert.equal(nodeDeclarations.includes(exportLine), true);
  }

  assert.equal(browserDeclarations.includes('export * from "./container/index.js";'), true);
  assert.equal(nodeDeclarations.includes('export * from "./container/node.js";'), true);
  assert.equal(browserDeclarations.includes("./atrac3/decoder.js"), false);
  assert.equal(nodeDeclarations.includes("./container/wav-parse.js"), false);
});
