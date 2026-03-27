import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3plus from "../../../src/atrac3plus/subsystems.js";
import * as Atrac3plusInternal from "../../../src/atrac3plus/internal.js";
import * as Codec from "../../../src/atrac3plus/codec.js";
import * as CodecInternal from "../../../src/atrac3plus/codec-internal.js";

test("ATRAC3plus codec public barrel exposes the lifecycle entrypoints only", () => {
  assert.equal(Atrac3plus.Codec, Codec);

  assert.equal(typeof Codec.Atrac3PlusDecoder, "function");
  assert.equal(typeof Codec.decodeAtrac3PlusFrame, "function");
  assert.equal(typeof Codec.createAtxDecodeHandle, "function");
  assert.equal(typeof Codec.createAtrac3PlusDecoderState, "function");
  assert.equal(typeof Codec.analyzeAtrac3plusRuntimeFrame, "function");
  assert.equal(typeof Codec.analyzeAtrac3plusSignalBlocks, "function");
  assert.equal(typeof Codec.normalizeAtrac3plusEncodeRuntime, "function");
  assert.equal(typeof Codec.encodeAtrac3plusRuntimeFrame, "function");
  assert.equal(typeof Codec.packAtrac3plusFrameFromRegularBlocks, "function");

  assert.equal("reconstructBlockSpectra" in Codec, false);
  assert.equal("applyStereoMapTransforms" in Codec, false);
  assert.equal("applySynthesisFilterbank" in Codec, false);
  assert.equal("blockLayoutForMode" in Codec, false);
  assert.equal("resolveBlockMode" in Codec, false);
  assert.equal("computeSpcNoiseBaseScale" in Codec, false);
});

test("ATRAC3plus codec internal barrel retains decode and topology helpers", () => {
  assert.equal(Atrac3plusInternal.Codec, CodecInternal);

  assert.equal(typeof CodecInternal.reconstructBlockSpectra, "function");
  assert.equal(typeof CodecInternal.applyStereoMapTransforms, "function");
  assert.equal(typeof CodecInternal.resolveStereoMapSourceChannelIndex, "function");
  assert.equal(typeof CodecInternal.decodeAtrac3PlusFrames, "function");
  assert.equal(typeof CodecInternal.analyzeAtrac3plusRuntimeFrame, "function");
  assert.equal(typeof CodecInternal.normalizeAtrac3plusEncodeRuntime, "function");
  assert.equal(typeof CodecInternal.encodeAtrac3plusRuntimeFrame, "function");
  assert.equal(typeof CodecInternal.applySynthesisFilterbank, "function");
  assert.equal(typeof CodecInternal.blockLayoutForMode, "function");
  assert.equal(typeof CodecInternal.resolveBlockMode, "function");
  assert.equal(typeof CodecInternal.computeSpcNoiseBaseScale, "function");
  assert.equal(typeof CodecInternal.resolveGhBandSynthesisState, "function");
});
