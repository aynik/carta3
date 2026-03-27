import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3Package from "carta3/atrac3";
import * as Atrac3plusPackage from "carta3/atrac3plus";
import * as BrowserContainerPackage from "carta3/container";
import * as NodeContainerPackage from "carta3/container/node";
import * as EncodersPackage from "carta3/encoders";

import * as Atrac3Public from "../src/atrac3/index.js";
import * as Atrac3plusPublic from "../src/atrac3plus/index.js";
import * as BrowserContainer from "../src/container/index.js";
import * as NodeContainer from "../src/container/node.js";
import * as EncodersPublic from "../src/encoders/index.js";

test("package atrac3 subpath resolves to the stable decoder surface only", () => {
  assert.equal(Atrac3Package.Atrac3Decoder, Atrac3Public.Atrac3Decoder);
  assert.equal(Atrac3Package.createAtrac3DecoderState, Atrac3Public.createAtrac3DecoderState);

  assert.equal("createAtrac3EncoderState" in Atrac3Package, false);
  assert.equal("decodeAtrac3Frame" in Atrac3Package, false);
});

test("package atrac3plus subpath resolves to the stable decode-facing surface", () => {
  assert.equal(Atrac3plusPackage.Atrac3PlusDecoder, Atrac3plusPublic.Atrac3PlusDecoder);
  assert.equal(
    Atrac3plusPackage.createAtrac3PlusDecoderState,
    Atrac3plusPublic.createAtrac3PlusDecoderState
  );
  assert.equal(Atrac3plusPackage.unpackAtxFrame, Atrac3plusPublic.unpackAtxFrame);

  assert.equal("createAtrac3plusEncodeHandle" in Atrac3plusPackage, false);
  assert.equal("encodeAtrac3plusRuntimeFrame" in Atrac3plusPackage, false);
});

test("package encoder subpath resolves to the curated wrapper surface", () => {
  assert.equal(
    EncodersPackage.encodeAtracFramesFromInterleavedPcm,
    EncodersPublic.encodeAtracFramesFromInterleavedPcm
  );
  assert.equal(
    EncodersPackage.encodeAtrac3ScxFramesFromInterleavedPcm,
    EncodersPublic.encodeAtrac3ScxFramesFromInterleavedPcm
  );
  assert.equal(EncodersPackage.buildAtracWavBuffer, EncodersPublic.buildAtracWavBuffer);

  assert.equal("encodeAtrac3FramesFromInterleavedPcm" in EncodersPackage, false);
  assert.equal("encodeAtrac3plusFramesFromInterleavedPcm" in EncodersPackage, false);
});

test("package container subpaths keep browser-safe and node-specific helpers separate", () => {
  assert.equal(BrowserContainerPackage.parseAtracWavBuffer, BrowserContainer.parseAtracWavBuffer);
  assert.equal(BrowserContainerPackage.createPcmWriter, BrowserContainer.createPcmWriter);
  assert.equal(NodeContainerPackage.parseAtracWavBuffer, NodeContainer.parseAtracWavBuffer);
  assert.equal(NodeContainerPackage.decodeAt3WavContainer, NodeContainer.decodeAt3WavContainer);

  assert.equal("decodeAt3WavContainer" in BrowserContainerPackage, false);
});
