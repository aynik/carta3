import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3 from "../../../src/atrac3/index.js";
import * as Atrac3Internal from "../../../src/atrac3/internal.js";
import { Atrac3Decoder } from "../../../src/atrac3/decoder.js";
import { createAtrac3DecoderState } from "../../../src/atrac3/decoder-state.js";
import * as Frame from "../../../src/atrac3/frame.js";
import * as FrameOutput from "../../../src/atrac3/frame-output.js";
import * as FrameChannel from "../../../src/atrac3/frame-channel.js";
import * as FrameChannelPack from "../../../src/atrac3/frame-channel-pack.js";
import * as FrameChannelSpectrum from "../../../src/atrac3/frame-channel-spectrum.js";
import * as FrameChannelTone from "../../../src/atrac3/frame-channel-tone.js";
import * as DecodeChannel from "../../../src/atrac3/decode-channel.js";
import * as DecodeChannelTransport from "../../../src/atrac3/decode-channel-transport.js";
import * as DecodeChannelTone from "../../../src/atrac3/decode-channel-tone.js";
import * as DecodeChannelSpcode from "../../../src/atrac3/decode-channel-spcode.js";
import * as DecodeRebuild from "../../../src/atrac3/decode-rebuild.js";
import * as DecodeRebuildBlock from "../../../src/atrac3/decode-rebuild-block.js";

test("ATRAC3 public barrel exposes only decoder entrypoints", () => {
  assert.equal(Atrac3.Atrac3Decoder, Atrac3Decoder);
  assert.equal(Atrac3.createAtrac3DecoderState, createAtrac3DecoderState);

  assert.equal("createAtrac3LayerPair" in Atrac3, false);
  assert.equal("createAtrac3ChannelPair" in Atrac3, false);
  assert.equal("hasAtrac3LayerPair" in Atrac3, false);
});

test("ATRAC3 internal codec namespace stays focused on live codec owners", () => {
  assert.equal("createAtrac3LayerPair" in Atrac3Internal.Codec, false);
  assert.equal("createAtrac3ChannelPair" in Atrac3Internal.Codec, false);
  assert.equal("hasAtrac3LayerPair" in Atrac3Internal.Codec, false);
  assert.equal(Atrac3Internal.Codec.createAtrac3DecoderState, createAtrac3DecoderState);
});

test("ATRAC3 frame owner files keep lifecycle, transport, and payload stages separate", () => {
  assert.equal(typeof Frame.encodeAtrac3Algorithm0Frame, "function");
  assert.equal(typeof FrameOutput.at3encPrepareChannelProcWords, "function");
  assert.equal(typeof FrameOutput.packAtrac3Algorithm0FrameOutput, "function");
  assert.equal(typeof FrameChannel.at3encPackChannel, "function");
  assert.equal(typeof FrameChannelPack.at3encPackBitsU16, "function");
  assert.equal(typeof FrameChannelSpectrum.writeAtrac3SpectralPayload, "function");
  assert.equal(typeof FrameChannelTone.writeAtrac3ToneRegionSideband, "function");

  assert.equal("packAtrac3Algorithm0FrameOutput" in Frame, false);
  assert.equal("at3encPrepareChannelProcWords" in Frame, false);
  assert.equal("writeAtrac3SpectralPayload" in FrameChannel, false);
  assert.equal("writeAtrac3ToneRegionSideband" in FrameChannel, false);
  assert.equal("at3encPackBitsU16" in FrameChannel, false);
});

test("ATRAC3 decode owner files keep transport, payload, and rebuild stages separate", () => {
  assert.equal(typeof DecodeChannelTransport.openAtrac3ChannelTransport, "function");
  assert.equal(typeof DecodeChannelTransport.markAtrac3DecodeError, "function");
  assert.equal(typeof DecodeChannelSpcode.decodeSpcode, "function");
  assert.equal(typeof DecodeChannelTone.decodeAtrac3TonePasses, "function");
  assert.equal(typeof DecodeChannel.stageAtrac3GainPairTables, "function");
  assert.equal(typeof DecodeChannel.decodeAtrac3ChannelPayload, "function");
  assert.equal(typeof DecodeChannel.decodeAtrac3ChannelTransport, "function");
  assert.equal(typeof DecodeRebuild.rebuildAtrac3ChannelWorkArea, "function");
  assert.equal(typeof DecodeRebuildBlock.applyAtrac3BlockTransform, "function");

  assert.equal("openAtrac3ChannelTransport" in DecodeChannel, false);
  assert.equal("decodeSpcode" in DecodeChannel, false);
  assert.equal("decodeAtrac3TonePasses" in DecodeChannel, false);
  assert.equal("applyAtrac3BlockTransform" in DecodeRebuild, false);
});
