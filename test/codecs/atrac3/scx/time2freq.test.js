import assert from "node:assert/strict";
import test from "node:test";

import {
  channelNeedsForwardTransformAt3,
  createAt3Time2freqTable,
  forwardTransformAt3,
  getAt3Time2freqMdctBlocks,
  getAt3Time2freqNoGainScratch,
  time2freqAt3,
} from "../../../../src/atrac3/scx/time2freq.js";
import { createAtrac3ScxEncoderContext } from "../../../../src/atrac3/scx/context.js";
import {
  createAt3GainControlBlock,
  createAt3GainControlBlocks,
  setAt3GainControlCount,
  setAt3GainControlEntry,
} from "../../../../src/atrac3/scx/gainc-layout.js";

test("time2freq table helpers preserve current slice layout", () => {
  const table = createAt3Time2freqTable();
  const mdctBlocks = getAt3Time2freqMdctBlocks(table);
  const noGainScratch = getAt3Time2freqNoGainScratch(table);

  assert.equal(table.length, 5258);
  assert.deepEqual(
    mdctBlocks.map((view) => view.length),
    [256, 256, 256, 256]
  );
  assert.deepEqual(
    mdctBlocks.map((view) => view.byteOffset - table.byteOffset),
    [1024, 4096, 7168, 10240]
  );
  assert.equal(noGainScratch.length, 1024);
  assert.equal(noGainScratch.byteOffset - table.byteOffset, 16384);
});

test("channelNeedsForwardTransformAt3 preserves current gain-control gating", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const channel = ctx.state.channelHistories[0].current;

  assert.equal(channelNeedsForwardTransformAt3(channel), 0);

  setAt3GainControlCount(channel.gaincParams[0], 1);
  assert.equal(channelNeedsForwardTransformAt3(channel), 1);
});

test("time2freqAt3 preserves current zero-input output and stereo mode rejection", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const srcList = [new Float32Array(1024), new Float32Array(1024)];
  const scratchChannels = ctx.state.channelScratch;
  const spectra = scratchChannels.map((channel) => channel.spectra);

  assert.equal(time2freqAt3(srcList, scratchChannels, ctx.state.channelHistories, 2, 1), 0);
  assert.deepEqual(Array.from(spectra[0].slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(spectra[1].slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);

  assert.equal(time2freqAt3(srcList, scratchChannels, ctx.state.channelHistories, 2, 2), -1);
});

test("time2freqAt3 preserves current table prep before stereo mode rejection", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const srcList = [
    Float32Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) / 19) * 0.25),
    Float32Array.from({ length: 1024 }, (_, i) => Math.cos((i + 1) / 23) * 0.2),
  ];
  const scratchChannels = ctx.state.channelScratch;
  const spectra = scratchChannels.map((channel) => channel.spectra);

  assert.equal(time2freqAt3(srcList, scratchChannels, ctx.state.channelHistories, 2, 2), -1);
  assert.deepEqual(Array.from(spectra[0].slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(ctx.state.channelScratch[0].time2freq.slice(512, 520)),
    [
      1.7452467249157166e-10, -5.670817634917391e-11, 8.442134769026666e-10, -7.934534140829896e-10,
      4.63363658553817e-9, -4.918035401146881e-8, -0.0000043711984289984684, -7.187363166849536e-7,
    ]
  );
});

test("forwardTransformAt3 preserves the current deterministic MDCT output", () => {
  const blocks = Array.from({ length: 4 }, (_, band) =>
    Float32Array.from({ length: 256 }, (_, i) => (band + 1) * ((i % 17) - 8) * 0.125)
  );
  const out = new Float32Array(1024);
  const paramsA = createAt3GainControlBlocks(4);
  const paramsB = createAt3GainControlBlocks(4);
  const buf = Float32Array.from({ length: 1024 }, (_, i) => ((i % 29) - 14) * 0.0625);

  assert.equal(forwardTransformAt3(blocks, out, paramsA, paramsB, 4, buf), 0);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [
      0.01274105068296194, -0.01435165200382471, -0.01103837788105011, 0.01598808355629444,
      0.009094390086829662, -0.01776897720992565, -0.00667945109307766, 0.019849689677357674,
      0.0033795235212892294, -0.022493064403533936, 0.0016795876435935497, 0.02628009393811226,
      -0.010762502439320087, -0.03308439254760742, 0.032186802476644516, 0.05745762959122658,
    ]
  );
  assert.deepEqual(
    Array.from(out.slice(256, 272)),
    [
      0.0015142748598009348, 0.002514870371669531, -0.0008356052567251027, -0.0038589835166931152,
      0.0007793314289301634, 0.005759233608841896, -0.003681673901155591, -0.0038980538956820965,
      0.009091272950172424, -0.01774398423731327, 0.02794768661260605, -0.013707403093576431,
      -0.02803589403629303, 0.03752534091472626, 0.11826767772436142, 0.11257694661617279,
    ]
  );
  assert.deepEqual(
    Array.from(buf.slice(0, 16)),
    [
      -1, -0.875, -0.75, -0.625, -0.5, -0.375, -0.25, -0.125, 0, 0.125, 0.25, 0.375, 0.5, 0.625,
      0.75, 0.875,
    ]
  );
});

test("forwardTransformAt3 preserves the current gain-window branch", () => {
  const blocks = [Float32Array.from({ length: 256 }, (_, i) => ((i % 13) - 6) * 0.5)];
  const out = new Float32Array(256);
  const paramsA = [createAt3GainControlBlock()];
  const paramsB = [createAt3GainControlBlock()];
  setAt3GainControlCount(paramsA[0], 1);
  setAt3GainControlEntry(paramsA[0], 0, 0, 1);
  const buf = Float32Array.from({ length: 256 }, (_, i) => ((i % 11) - 5) * 0.25);

  assert.equal(forwardTransformAt3(blocks, out, paramsA, paramsB, 1, buf), 0);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [
      0.041529517620801926, -0.04122607782483101, -0.04197484999895096, 0.041061580181121826,
      0.0425691083073616, -0.041037097573280334, -0.04332383722066879, 0.0411580428481102,
      0.0442558191716671, -0.041434627026319504, -0.04538825526833534, 0.0418831929564476,
      0.04675278812646866, -0.04252783954143524, -0.04839220270514488, 0.043403346091508865,
    ]
  );
  assert.deepEqual(
    Array.from(buf.slice(0, 16)),
    [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, -3, -2.5, -2]
  );
});

test("forwardTransformAt3 preserves current gain-window failure propagation", () => {
  const blocks = [Float32Array.from({ length: 256 }, (_, i) => ((i % 13) - 6) * 0.5)];
  const out = new Float32Array(256).fill(7);
  const paramsA = [createAt3GainControlBlock()];
  const paramsB = [createAt3GainControlBlock()];
  setAt3GainControlCount(paramsA[0], 1);
  setAt3GainControlEntry(paramsA[0], 0, 0, 99);
  const buf = Float32Array.from({ length: 256 }, (_, i) => ((i % 11) - 5) * 0.25);
  const beforeBuf = Array.from(buf.slice(0, 16));

  assert.equal(forwardTransformAt3(blocks, out, paramsA, paramsB, 1, buf), -1);
  assert.deepEqual(Array.from(out.slice(0, 8)), Array(8).fill(7));
  assert.deepEqual(Array.from(buf.slice(0, 16)), beforeBuf);
});

test("forwardTransformAt3 preserves history when a later gain-window block fails", () => {
  const blocks = Array.from({ length: 2 }, (_, band) =>
    Float32Array.from({ length: 256 }, (_, i) => (band + 1) * ((i % 7) - 3))
  );
  const out = new Float32Array(512).fill(9);
  const paramsA = createAt3GainControlBlocks(2);
  const paramsB = createAt3GainControlBlocks(2);
  setAt3GainControlCount(paramsA[1], 1);
  setAt3GainControlEntry(paramsA[1], 0, 0, 99);
  const buf = Float32Array.from({ length: 512 }, (_, i) => i - 20);
  const beforeBuf = Array.from(buf);

  assert.equal(forwardTransformAt3(blocks, out, paramsA, paramsB, 2, buf), -1);
  assert.notDeepEqual(Array.from(out.slice(0, 8)), Array(8).fill(9));
  assert.deepEqual(Array.from(out.slice(256, 264)), Array(8).fill(9));
  assert.deepEqual(Array.from(buf), beforeBuf);
});

test("time2freqAt3 preserves current validation errors", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const srcList = [new Float32Array(1024), new Float32Array(1024)];

  assert.throws(
    () =>
      time2freqAt3(
        srcList,
        [
          { spectra: new Float32Array(1024), time2freq: new Float32Array(10) },
          ctx.state.channelScratch[1],
        ],
        ctx.state.channelHistories,
        2,
        1
      ),
    /scratchChannels\[0\]\.time2freq must be a Float32Array with at least 5258 entries/
  );
  assert.throws(
    () =>
      time2freqAt3(
        [new Float32Array(1024)],
        ctx.state.channelScratch,
        ctx.state.channelHistories,
        2,
        1
      ),
    /srcList must be an array with at least 2 channels/
  );
});
