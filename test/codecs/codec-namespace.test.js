import assert from "node:assert/strict";
import test from "node:test";

import * as Atrac3Internal from "../../src/atrac3/internal.js";
import * as Atrac3plus from "../../src/atrac3plus/subsystems.js";
import * as Atrac3plusInternal from "../../src/atrac3plus/internal.js";
import * as Common from "../../src/common/index.js";

test("shared common namespace stays focused on genuine cross-domain helpers", () => {
  assert.equal(typeof Common.normalizeInputBytes, "function");
  assert.equal(typeof Common.ensurePlanarF32Frame, "function");
  assert.equal(typeof Common.resolveCodecDecodedSampleWindow, "function");
  assert.equal(typeof Common.trimInterleavedPcm, "function");
  assert.equal("atracEncoderDelaySamples" in Common, false);
  assert.equal("computeAtracEncodeFactParam" in Common, false);
  assert.equal("normalizeCodecFrames" in Common, false);
  assert.equal("computeAtracEncodePadPlan" in Common, false);
  assert.equal("collectAtracEncodeFrames" in Common, false);
});

test("ATRAC3 internal namespace retains low-level transport helpers", () => {
  assert.deepEqual(Object.keys(Atrac3Internal.Bitstream).sort(), [
    "AT3_SPCODE_ERROR_FLAG",
    "decodeSpcode",
    "openAtrac3ChannelTransport",
    "peekAtrac3Bits",
    "readAtrac3Bits",
  ]);
  assert.deepEqual(Object.keys(Atrac3Internal.Codec).sort(), [
    "AT3_DEC_FLAG_ERROR",
    "Atrac3Decoder",
    "applyAtrac3BlockTransform",
    "buildAtrac3StereoPcm",
    "createAtrac3DecoderState",
    "decodeAtrac3ChannelPayload",
    "decodeAtrac3ChannelTransport",
    "decodeAtrac3Frame",
    "decodeAtrac3Frames",
    "decodeAtrac3TonePasses",
    "markAtrac3DecodeError",
    "mixAtrac3StereoChannels",
    "rebuildAtrac3ChannelWorkArea",
    "resolveAtrac3DecodeOutputChannels",
    "rollAtrac3StereoMixHeader",
    "stageAtrac3GainPairTables",
    "synthesizeAtrac3Channel",
  ]);
  assert.deepEqual(Object.keys(Atrac3Internal.Encode).sort(), [
    "ChannelConversion",
    "ChannelRebalance",
    "Frame",
    "FrameChannel",
    "ProcLowBudgetTone",
    "ProcPayload",
    "ProcWords",
    "Qmf",
    "Runtime",
    "Transform",
  ]);
  assert.equal(typeof Atrac3Internal.Bitstream.decodeSpcode, "function");
  assert.equal(typeof Atrac3Internal.Bitstream.readAtrac3Bits, "function");
  assert.equal(typeof Atrac3Internal.Bitstream.openAtrac3ChannelTransport, "function");
  assert.equal(typeof Atrac3Internal.Codec.createAtrac3DecoderState, "function");
  assert.equal(typeof Atrac3Internal.Codec.decodeAtrac3ChannelTransport, "function");
  assert.equal(typeof Atrac3Internal.Codec.decodeAtrac3Frame, "function");
  assert.equal(typeof Atrac3Internal.Codec.decodeAtrac3Frames, "function");
  assert.equal(typeof Atrac3Internal.Encode.Runtime.createAtrac3Algorithm0RuntimeState, "function");
  assert.equal(typeof Atrac3Internal.Encode.Runtime.isAtrac3Algorithm0EncoderState, "function");
  assert.equal(typeof Atrac3Internal.Encode.ChannelConversion.selectChannelConversion, "function");
  assert.equal(typeof Atrac3Internal.Encode.ChannelRebalance.dbaMainSub, "function");
  assert.equal(typeof Atrac3Internal.Encode.Frame.encodeAtrac3Algorithm0Frame, "function");
  assert.equal(typeof Atrac3Internal.Encode.Frame.packAtrac3Algorithm0FrameOutput, "function");
  assert.equal(typeof Atrac3Internal.Encode.FrameChannel.at3encPackChannel, "function");
  assert.equal(typeof Atrac3Internal.Encode.FrameChannel.writeAtrac3SpectralPayload, "function");
  assert.equal(typeof Atrac3Internal.Encode.ProcPayload.planLowBudgetBandPayloads, "function");
  assert.equal(typeof Atrac3Internal.Encode.ProcPayload.finalizeLowBudgetBandPayload, "function");
  assert.equal(typeof Atrac3Internal.Encode.ProcWords.fillAt3ProcWordsLowBudget, "function");
  assert.equal(typeof Atrac3Internal.Encode.ProcLowBudgetTone.runLowBudgetTonePath, "function");
  assert.equal(typeof Atrac3Internal.Encode.Qmf.at3encQmfAnalyze, "function");
  assert.equal(typeof Atrac3Internal.Encode.Transform.at3encProcessLayerTransform, "function");
  assert.equal(typeof Atrac3Internal.Scx.createAtrac3ScxEncoderContext, "function");
  assert.equal(typeof Atrac3Internal.Scx.at3ScxEncodeFrameFromPcm, "function");
  assert.equal(typeof Atrac3Internal.Scx.at3ScxEncodeFrameFromSpectra, "function");
  assert.equal(typeof Atrac3Internal.Tables.AT3_DEC_OFFSET_TABLE, "object");
  assert.equal("decodeSpcode" in Atrac3Internal.Codec, false);
  assert.equal("readAtrac3Bits" in Atrac3Internal.Codec, false);
  assert.equal("Bitstream" in Atrac3Internal.Codec, false);
  assert.equal("ATRAC3_FRAME_SAMPLES" in Atrac3Internal.Codec, false);
  assert.equal("Io" in Atrac3Internal.Codec, false);
  assert.equal("createAtrac3EncoderState" in Atrac3Internal, false);
  assert.equal("createAtrac3Algorithm0RuntimeState" in Atrac3Internal.Encode, false);
  assert.equal("encodeAtrac3Algorithm0Frame" in Atrac3Internal.Encode, false);
  assert.equal("packAtrac3Algorithm0FrameOutput" in Atrac3Internal.Encode, false);
  assert.equal("isAtrac3Algorithm0EncoderState" in Atrac3Internal.Encode, false);
  assert.equal("createAtrac3ScxEncoderContext" in Atrac3Internal, false);
  assert.equal("at3ScxEncodeFrameFromPcm" in Atrac3Internal, false);
  assert.equal("at3ScxEncodeFrameFromSpectra" in Atrac3Internal, false);
  assert.equal("Io" in Atrac3Internal, false);
  assert.equal("readPcmData" in Atrac3Internal, false);
});

test("ATRAC3 internal namespace stays subsystem-shaped", () => {
  assert.equal("createAtrac3Algorithm0RuntimeState" in Atrac3Internal, false);
  assert.equal("createAtrac3DecoderState" in Atrac3Internal, false);
  assert.equal("decodeAtrac3Frame" in Atrac3Internal, false);
  assert.equal("AT3_DEC_OFFSET_TABLE" in Atrac3Internal, false);
  assert.equal("decodeSpcode" in Atrac3Internal, false);
});

test("ATRAC3plus public namespace exposes major lifecycle subsystems", () => {
  assert.equal(typeof Atrac3plus.Codec, "object");
  assert.equal(typeof Atrac3plus.ChannelBlock, "object");
  assert.equal(typeof Atrac3plus.Gainc, "object");
  assert.equal(typeof Atrac3plus.Ghwave, "object");
  assert.equal(typeof Atrac3plus.Sigproc, "object");
  assert.equal(typeof Atrac3plus.Time2freq, "object");

  assert.equal("Bitstream" in Atrac3plus, false);
  assert.equal("Dsp" in Atrac3plus, false);
});

test("ATRAC3plus internal namespace retains bitstream and DSP helpers", () => {
  assert.equal(typeof Atrac3plusInternal.Bitstream.unpackAtxFrame, "function");
  assert.equal(typeof Atrac3plusInternal.Dsp.backwardTransformAt5, "function");
  assert.equal(typeof Atrac3plusInternal.Codec.reconstructBlockSpectra, "function");
  assert.equal(typeof Atrac3plusInternal.Codec.resolveBlockMode, "function");
  assert.equal(typeof Atrac3plusInternal.ChannelBlock.prepareLatePriorityOrder, "function");
  assert.equal(typeof Atrac3plusInternal.ChannelBlock.quantAt5, "function");
  assert.equal(typeof Atrac3plusInternal.Gainc.attackPassAt5, "function");
  assert.equal(typeof Atrac3plusInternal.Gainc.releasePassAt5, "function");
  assert.equal(typeof Atrac3plusInternal.Ghwave.analysisCtxForSlot, "function");
  assert.equal(typeof Atrac3plusInternal.Ghwave.resolveGhwaveModeConfigAt5, "function");
  assert.equal(typeof Atrac3plusInternal.Sigproc.createAt5SigprocAux, "function");
  assert.equal(typeof Atrac3plusInternal.Time2freq.createAt5EncodeBufBlock, "function");
});
