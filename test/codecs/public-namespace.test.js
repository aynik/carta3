import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3Public from "../../src/atrac3/index.js";
import { Atrac3Decoder } from "../../src/atrac3/decoder.js";
import { createAtrac3DecoderState } from "../../src/atrac3/decoder-state.js";
import * as Atrac3plusPublic from "../../src/atrac3plus/index.js";
import * as Atrac3plusCodec from "../../src/atrac3plus/codec.js";
import * as Atrac3plusBitstream from "../../src/atrac3plus/bitstream/index.js";
import * as Atrac3plusDsp from "../../src/atrac3plus/dsp.js";
import * as EncodersPublic from "../../src/encoders/index.js";
import * as EncodersAtrac from "../../src/encoders/atrac.js";
import * as EncodersAtrac3 from "../../src/encoders/atrac3.js";
import * as EncodersAtrac3Scx from "../../src/encoders/atrac3-scx.js";
import * as EncodersAtrac3plus from "../../src/encoders/atrac3plus.js";
import * as PcmEncodePlan from "../../src/encoders/pcm.js";
import * as EncodersProfile from "../../src/encoders/profiles.js";
import * as EncodersWav from "../../src/container/wav-build.js";
import * as WavFormat from "../../src/container/wav-format.js";

test("ATRAC3 public barrel exposes only stable decoder entrypoints", () => {
  assert.equal(Atrac3Public.Atrac3Decoder, Atrac3Decoder);
  assert.equal(Atrac3Public.createAtrac3DecoderState, createAtrac3DecoderState);

  assert.equal("decodeAtrac3Frame" in Atrac3Public, false);
  assert.equal("createAtrac3EncoderState" in Atrac3Public, false);
  assert.equal("ATRAC3_FRAME_SAMPLES" in Atrac3Public, false);
});

test("ATRAC3plus public barrel exposes decode, transport, and DSP helpers only", () => {
  assert.equal(Atrac3plusPublic.Atrac3PlusDecoder, Atrac3plusCodec.Atrac3PlusDecoder);
  assert.equal(Atrac3plusPublic.createAtxDecodeHandle, Atrac3plusCodec.createAtxDecodeHandle);
  assert.equal(Atrac3plusPublic.unpackAtxFrame, Atrac3plusBitstream.unpackAtxFrame);
  assert.equal(
    Atrac3plusPublic.unpackChannelBlockAt5Reg,
    Atrac3plusBitstream.unpackChannelBlockAt5Reg
  );
  assert.equal(Atrac3plusPublic.backwardTransformAt5, Atrac3plusDsp.backwardTransformAt5);

  assert.equal("createAtrac3plusEncodeHandle" in Atrac3plusPublic, false);
  assert.equal("encodeAtrac3plusRuntimeFrame" in Atrac3plusPublic, false);
  assert.equal("packAndProbeAtrac3plusFrameFromRegularBlocks" in Atrac3plusPublic, false);
  assert.equal("packChannelBlockAt5Reg" in Atrac3plusPublic, false);
  assert.equal("calcNbitsForGhaAt5" in Atrac3plusPublic, false);
});

test("encoder public barrel exposes package-level helpers without direct codec runtimes", () => {
  assert.equal(
    EncodersPublic.encodeAtracFramesFromInterleavedPcm,
    EncodersAtrac.encodeAtracFramesFromInterleavedPcm
  );
  assert.equal(
    EncodersPublic.encodeAtrac3ScxFramesFromInterleavedPcm,
    EncodersAtrac3Scx.encodeAtrac3ScxFramesFromInterleavedPcm
  );
  assert.equal(EncodersPublic.computeAtracEncodePadPlan, PcmEncodePlan.computeAtracEncodePadPlan);
  assert.equal(EncodersPublic.selectAtracEncodeProfile, EncodersProfile.selectAtracEncodeProfile);
  assert.equal(EncodersPublic.buildAtracWavBuffer, EncodersWav.buildAtracWavBuffer);
  assert.equal(EncodersPublic.createAtracEncodeWavFormat, WavFormat.createAtracEncodeWavFormat);

  assert.equal("encodeAtrac3FramesFromInterleavedPcm" in EncodersPublic, false);
  assert.equal("encodeAtrac3plusFramesFromInterleavedPcm" in EncodersPublic, false);
  assert.equal("createAtracWavEncodeResult" in EncodersPublic, false);
  assert.equal(typeof EncodersAtrac3.encodeAtrac3FramesFromInterleavedPcm, "function");
  assert.equal(typeof EncodersAtrac3Scx.encodeAtrac3ScxFramesFromInterleavedPcm, "function");
  assert.equal(typeof EncodersAtrac3plus.encodeAtrac3plusFramesFromInterleavedPcm, "function");
  assert.equal(typeof EncodersAtrac3plus.analyzeAtrac3plusFramesFromInterleavedPcm, "function");
});
