import assert from "node:assert/strict";
import test from "node:test";

import {
  at3ScxEncodeFrameFromPcm,
  at3ScxEncodeFrameFromSpectra,
  beginAtrac3ScxFrame,
  clearScxChannelFrameState,
} from "../../../../src/atrac3/scx/frame.js";
import { createAtrac3ScxEncoderContext } from "../../../../src/atrac3/scx/context.js";
import {
  getAt3GainControlMaxFirst,
  getAt3GainControlCount,
  setAt3GainControlCount,
  setAt3GainControlMaxFirst,
} from "../../../../src/atrac3/scx/gainc-layout.js";
import { time2freqAt3 } from "../../../../src/atrac3/scx/time2freq.js";

function createChannelBuffers() {
  return [new Float32Array(1024), new Float32Array(1024)];
}

function createSignalBuffers() {
  return [
    Float32Array.from(
      { length: 1024 },
      (_, i) => Math.sin((i + 1) / 13) * 0.25 + ((i % 17) - 8) * 0.001
    ),
    Float32Array.from(
      { length: 1024 },
      (_, i) => Math.cos((i + 1) / 11) * 0.2 - ((i % 19) - 9) * 0.0015
    ),
  ];
}

test("at3ScxEncodeFrameFromSpectra preserves current zero-frame output and state rotation", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const out = at3ScxEncodeFrameFromSpectra(createChannelBuffers(), createChannelBuffers(), ctx);
  const active = ctx.state.channelHistories[0].current;

  assert.equal(out.length, 384);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [162, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.equal(ctx.state.outputOffset, 384);
  assert.equal(active.specGroupCount, 1);
  assert.equal(active.componentGroupCount, 3);
  assert.equal(active.mddataEntryIndex, 0);
  assert.equal(active.scratchFlag, 0);
  assert.deepEqual(Array.from(active.config.activeWords), [3, 3, 3, 3]);
});

test("at3ScxEncodeFrameFromPcm preserves current zero-frame output", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const out = at3ScxEncodeFrameFromPcm(createChannelBuffers(), ctx);

  assert.equal(out.length, 384);
  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [162, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
});

test("at3ScxEncodeFrameFromPcm preserves current transform-prep failure propagation", () => {
  const ctx = createAtrac3ScxEncoderContext();
  ctx.state.time2freqMode = 2;
  const out = new Uint8Array(384).fill(255);

  assert.equal(at3ScxEncodeFrameFromPcm(createChannelBuffers(), ctx, out), -1);
  const active = ctx.state.channelHistories[0].current;
  assert.deepEqual(Array.from(out.slice(0, 16)), Array(16).fill(0));
  assert.equal(ctx.state.outputOffset, 0);
  assert.equal(active.specGroupCount, 29);
  assert.equal(active.componentGroupCount, 3);
  assert.equal(active.mddataEntryIndex, 0);
  assert.deepEqual(Array.from(active.config.activeWords), [3, 3, 3, 3]);
});

test("at3ScxEncodeFrameFromPcm preserves current no-forward-transform copy-through", () => {
  const pcmChannels = createSignalBuffers();
  const pcmCtx = createAtrac3ScxEncoderContext();
  const pcmFrame = at3ScxEncodeFrameFromPcm(pcmChannels, pcmCtx);

  const specCtx = createAtrac3ScxEncoderContext();
  const scratchChannels = specCtx.state.channelScratch;
  const specChannels = scratchChannels.map((channel) => channel.spectra);

  assert.equal(
    time2freqAt3(
      pcmChannels,
      scratchChannels,
      specCtx.state.channelHistories,
      specCtx.state.channelCount,
      specCtx.state.time2freqMode
    ),
    0
  );

  const spectraFrame = at3ScxEncodeFrameFromSpectra(specChannels, specChannels, specCtx);
  assert.deepEqual(pcmFrame, spectraFrame);
});

test("at3ScxEncodeFrameFromSpectra preserves current channel rotation carryover", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const leftHistory = ctx.state.channelHistories[0];
  const left = leftHistory.current;
  left.config.queuedWords.set([9, 8, 7, 6]);
  left.config.queuedLimit = 11;
  setAt3GainControlCount(left.gaincParams[0], 5);
  setAt3GainControlCount(leftHistory.recycled.gaincParams[0], 7);

  at3ScxEncodeFrameFromSpectra(createChannelBuffers(), createChannelBuffers(), ctx);
  const active = leftHistory.current;

  assert.deepEqual(Array.from(active.config.activeWords), [9, 8, 7, 6]);
  assert.equal(active.config.limit, 11);
  assert.equal(active.scratchFlag, 0);
  assert.equal(getAt3GainControlCount(active.gaincParams[0]), 0);
  assert.equal(getAt3GainControlCount(active.prevState.gaincParams[0]), 5);
});

test("at3ScxEncodeFrameFromSpectra preserves current empty-channel fallback packing", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const leftHistory = ctx.state.channelHistories[0];
  const left = leftHistory.current;
  left.config.queuedWords.set([9, 8, 7, 6]);
  left.config.queuedLimit = 2;
  leftHistory.recycled.unitBytes = 0x14;
  leftHistory.recycled.specTableIndex = 4;
  leftHistory.recycled.idwl[0] = 3;

  const out = at3ScxEncodeFrameFromSpectra(createChannelBuffers(), createChannelBuffers(), ctx);
  const active = leftHistory.current;

  assert.deepEqual(
    Array.from(out.slice(0, 16)),
    [160, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.equal(ctx.state.outputOffset, 212);
  assert.equal(active.unitBytes, 0x14);
  assert.equal(active.config.limit, 0x0f);
  assert.deepEqual(Array.from(active.config.activeWords), [3, 3, 3, 3]);
  assert.equal(active.componentGroupCount, 1);
  assert.equal(active.specGroupCount, 1);
  assert.equal(active.specTableIndex, 0);
  assert.equal(active.idwl[0], 0);
});

test("SCX frame encoders preserve current input validation", () => {
  const ctx = createAtrac3ScxEncoderContext();

  assert.throws(
    () => at3ScxEncodeFrameFromPcm(createChannelBuffers(), null),
    /ctx must be a valid ATRAC3 SCX encoder context/
  );
  assert.throws(
    () => at3ScxEncodeFrameFromSpectra([new Float32Array(1024)], createChannelBuffers(), ctx),
    /expected 2 channel buffers/
  );
  assert.throws(
    () => at3ScxEncodeFrameFromPcm([new Float32Array(1024)], ctx),
    /expected 2 channel buffers/
  );
  assert.throws(
    () =>
      at3ScxEncodeFrameFromSpectra(
        createChannelBuffers(),
        createChannelBuffers(),
        ctx,
        new Uint8Array(32)
      ),
    /at least 384 bytes/
  );
});

test("beginAtrac3ScxFrame preserves channel rotation and frame reset before packing", () => {
  const ctx = createAtrac3ScxEncoderContext();
  const leftHistory = ctx.state.channelHistories[0];
  const left = leftHistory.current;
  left.config.queuedWords.set([9, 8, 7, 6]);
  left.config.queuedLimit = 11;
  setAt3GainControlCount(left.gaincParams[0], 5);
  setAt3GainControlCount(leftHistory.recycled.gaincParams[0], 7);
  const out = new Uint8Array(ctx.frameBytes).fill(255);

  const { encoderState, frame, channelCount } = beginAtrac3ScxFrame(ctx, out);
  const active = leftHistory.current;

  assert.equal(frame, out);
  assert.equal(encoderState, ctx.state);
  assert.equal(channelCount, 2);
  assert.equal(ctx.state.outputOffset, 0);
  assert.deepEqual(Array.from(frame.slice(0, 16)), Array(16).fill(0));
  assert.deepEqual(Array.from(active.config.activeWords), [9, 8, 7, 6]);
  assert.equal(active.config.limit, 11);
  assert.equal(active.scratchFlag, 0);
  assert.equal(active.specGroupCount, 29);
  assert.equal(active.componentGroupCount, 3);
  assert.equal(getAt3GainControlCount(active.gaincParams[0]), 0);
  assert.equal(getAt3GainControlCount(active.prevState.gaincParams[0]), 5);
});

test("clearScxChannelFrameState resets transient SCX metadata without replacing buffers", () => {
  const channel = createAtrac3ScxEncoderContext().state.channelHistories[0].current;
  const gainBlock = channel.gaincParams[0];
  const mddataEntry = channel.mddataEntries[0];
  const mddataList = mddataEntry.lists[0];
  const tone = channel.tonePool[0];
  const toneCoefficients = tone.coefficients;

  setAt3GainControlCount(gainBlock, 2);
  setAt3GainControlMaxFirst(gainBlock, 9);
  channel.mddataEntryIndex = 8;
  mddataEntry.huffTableBaseIndex = 3;
  mddataEntry.twiddleId = 4;
  mddataEntry.huffTableSetIndex = 5;
  mddataEntry.groupFlags[0] = 6;
  mddataEntry.listCounts[0] = 7;
  mddataList[0] = 8;
  channel.toneCount = 7;
  tone.start = 9;
  tone.scaleFactorIndex = 10;
  toneCoefficients[0] = 11;
  tone.twiddleId = 12;
  tone.huffTableBaseIndex = 13;
  tone.huffTableSetIndex = 14;
  channel.idwl[0] = 21;
  channel.quidsf[0] = 22;
  channel.quantSpecs[0] = 23;

  clearScxChannelFrameState(channel);

  assert.equal(channel.gaincParams[0], gainBlock);
  assert.equal(channel.mddataEntries[0], mddataEntry);
  assert.equal(channel.mddataEntries[0].lists[0], mddataList);
  assert.equal(channel.tonePool[0], tone);
  assert.equal(channel.tonePool[0].coefficients, toneCoefficients);
  assert.equal(channel.mddataEntryIndex, 0);
  assert.equal(channel.toneCount, 0);
  assert.equal(getAt3GainControlCount(gainBlock), 0);
  assert.equal(getAt3GainControlMaxFirst(gainBlock), 0);
  assert.equal(mddataEntry.huffTableBaseIndex, 0);
  assert.equal(mddataEntry.twiddleId, 0);
  assert.equal(mddataEntry.huffTableSetIndex, 0);
  assert.deepEqual(Array.from(mddataEntry.groupFlags.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(mddataEntry.listCounts.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(mddataList.slice(0, 4)), [0, 0, 0, 0]);
  assert.equal(tone.start, 0);
  assert.equal(tone.scaleFactorIndex, 0);
  assert.deepEqual(Array.from(toneCoefficients.slice(0, 4)), [0, 0, 0, 0]);
  assert.equal(tone.twiddleId, 0);
  assert.equal(tone.huffTableBaseIndex, 0);
  assert.equal(tone.huffTableSetIndex, 0);
  assert.equal(channel.idwl[0], 21);
  assert.equal(channel.quidsf[0], 22);
  assert.equal(channel.quantSpecs[0], 23);
});

test("clearScxChannelFrameState rejects invalid channel values", () => {
  assert.throws(() => clearScxChannelFrameState(null), /channel must be an object/);
});
