import assert from "node:assert/strict";
import test from "node:test";

import {
  createAtrac3ScxEncoderContext,
  createAt3DbaState,
  initDbaAt3,
  isAtrac3ScxEncoderContext,
} from "../../../../src/atrac3/scx/context.js";
import {
  getAt3GainControlCount,
  getAt3GainControlMaxFirst,
  setAt3GainControlCount,
  setAt3GainControlMaxFirst,
} from "../../../../src/atrac3/scx/gainc-layout.js";

test("createAtrac3ScxEncoderContext preserves the SCX channel state layout", () => {
  const context = createAtrac3ScxEncoderContext();
  const [leftHistory, rightHistory] = context.state.channelHistories;
  const { current: left } = leftHistory;
  const { current: right } = rightHistory;

  assert.equal(context.channels, 2);
  assert.equal(context.frameBytes, 0x180);
  assert.deepEqual(Array.from(context.configWords), [0xc0, 0xc0]);
  assert.deepEqual(Array.from(context.workSizes), [0x3afc, 0x3afc]);

  assert.equal(context.state.channelCount, 2);
  assert.equal(context.state.time2freqMode, 1);
  assert.equal(context.state.channelScratch.length, 2);
  assert.equal(context.state.channelScratch[0].spectra.length, 1024);
  assert.equal(context.state.channelScratch[0].transformed.length, 1024);
  assert.equal(context.state.channelScratch[0].time2freq.length, 5258);
  assert.deepEqual(
    context.state.channelScratch[0].mdctBlocks.map((block) => block.length),
    [256, 256, 256, 256]
  );
  assert.equal(context.state.channelScratch[0].noGainScratch.length, 1024);
  assert.notEqual(context.state.channelScratch[0].spectra, context.state.channelScratch[1].spectra);
  assert.notEqual(
    context.state.channelScratch[0].transformed,
    context.state.channelScratch[1].transformed
  );
  assert.notEqual(
    context.state.channelScratch[0].time2freq,
    context.state.channelScratch[1].time2freq
  );
  assert.notEqual(
    context.state.channelScratch[0].noGainScratch,
    context.state.channelScratch[1].noGainScratch
  );
  assert.equal(left.channelIndex, 0);
  assert.equal(right.channelIndex, 1);
  assert.equal(leftHistory.current, left);
  assert.equal(rightHistory.current, right);
  assert.equal(left.globalState, context.state);
  assert.equal(right.globalState, context.state);
  assert.equal(left.unitBytes, 0xc0);
  assert.equal(left.unitBytes << 3, 0x600);
  assert.equal(left.specGroupCount, left.dba.iqtIndexPlus1);
  assert.equal(left.componentGroupCount, left.dba.scaledQ11CeilQ8);
  assert.deepEqual(Array.from(left.config.activeWords), [3, 3, 3, 3]);
  assert.deepEqual(Array.from(left.config.queuedWords), [3, 3, 3, 3]);
  assert.equal(left.prevState.unitBytes, left.unitBytes);
  assert.equal(leftHistory.recycled.unitBytes << 3, left.unitBytes << 3);
  assert.equal(left.prevState.config.limit, 0x0f);
  assert.equal(leftHistory.recycled.specGroupCount, left.specGroupCount);
  assert.equal(leftHistory.recycled.componentGroupCount, left.componentGroupCount);
  assert.equal(left.prevState.channelIndex, 0);
  assert.equal(leftHistory.recycled.channelIndex, 0);
  assert.equal(left.prevState.globalState, context.state);
  assert.equal(leftHistory.recycled.globalState, context.state);
  assert.equal(left.prevState.prevState, left.prevState);
  assert.equal(leftHistory.recycled.prevState, left.prevState);
});

test("SCX channel block clones preserve isolation between nested buffers", () => {
  const context = createAtrac3ScxEncoderContext();
  const history = context.state.channelHistories[0];
  const block = history.current;
  const next = history.recycled;
  const prev = block.prevState;
  const prevDbaValue = prev.dba.value;
  const nextDbaValue = next.dba.value;

  setAt3GainControlCount(block.gaincParams[0], 9);
  setAt3GainControlMaxFirst(block.gaincParams[0], 7);
  block.mddataEntries[0].huffTableBaseIndex = 10;
  block.mddataEntries[0].twiddleId = 11;
  block.mddataEntries[0].groupFlags[0] = 11;
  block.mddataEntries[0].lists[0][0] = 12;
  block.tonePool[0].start = 13;
  block.tonePool[0].scaleFactorIndex = 14;
  block.tonePool[0].coefficients[0] = 13;
  block.tonePool[0].twiddleId = 15;
  block.tonePool[0].huffTableBaseIndex = 16;
  block.tonePool[0].huffTableSetIndex = 17;
  block.idwl[0] = 14;
  block.quidsf[0] = 15;
  block.quantSpecs[0] = 16;
  block.config.activeWords[0] = 17;
  block.config.queuedWords[0] = 18;
  block.dba.value = prevDbaValue + 1;

  assert.notEqual(block.gaincParams[0], prev.gaincParams[0]);
  assert.notEqual(block.mddataEntries[0], prev.mddataEntries[0]);
  assert.notEqual(block.mddataEntries[0].lists[0], prev.mddataEntries[0].lists[0]);
  assert.notEqual(block.tonePool[0], prev.tonePool[0]);
  assert.notEqual(block.tonePool[0].coefficients, prev.tonePool[0].coefficients);
  assert.notEqual(block.dba, prev.dba);

  assert.equal(getAt3GainControlCount(prev.gaincParams[0]), 0);
  assert.equal(getAt3GainControlMaxFirst(prev.gaincParams[0]), 0);
  assert.equal(prev.mddataEntries[0].huffTableBaseIndex, 0);
  assert.equal(prev.mddataEntries[0].twiddleId, 0);
  assert.equal(prev.mddataEntries[0].groupFlags[0], 0);
  assert.equal(prev.mddataEntries[0].lists[0][0], 0);
  assert.equal(prev.tonePool[0].start, 0);
  assert.equal(prev.tonePool[0].scaleFactorIndex, 0);
  assert.equal(prev.tonePool[0].coefficients[0], 0);
  assert.equal(prev.tonePool[0].twiddleId, 0);
  assert.equal(prev.tonePool[0].huffTableBaseIndex, 0);
  assert.equal(prev.tonePool[0].huffTableSetIndex, 0);
  assert.equal(prev.idwl[0], 0);
  assert.equal(prev.quidsf[0], 0);
  assert.equal(prev.quantSpecs[0], 0);
  assert.equal(prev.config.activeWords[0], 3);
  assert.equal(prev.config.queuedWords[0], 3);
  assert.equal(prev.dba.value, prevDbaValue);
  assert.equal(getAt3GainControlCount(next.gaincParams[0]), 0);
  assert.equal(next.mddataEntries[0].huffTableBaseIndex, 0);
  assert.equal(next.mddataEntries[0].lists[0][0], 0);
  assert.equal(next.tonePool[0].start, 0);
  assert.equal(next.tonePool[0].coefficients[0], 0);
  assert.equal(next.dba.value, nextDbaValue);
});

test("createAtrac3ScxEncoderContext rejects unsupported bitrate and mode values", () => {
  assert.throws(
    () => createAtrac3ScxEncoderContext(128, 1),
    /unsupported ATRAC3 SCX encoder config/
  );
  assert.throws(
    () => createAtrac3ScxEncoderContext(132, 0),
    /unsupported ATRAC3 SCX encoder config/
  );
});

test("initDbaAt3 preserves current lookup and rounding behavior", () => {
  assert.deepEqual(initDbaAt3(44100, 0), createAt3DbaState());
  assert.deepEqual(initDbaAt3(44100, 132), {
    value: 132,
    scaledQ11OverRate: 6,
    iqtIndexPlus1: 1,
    scaledQ11CeilQ8: 1,
  });
});

test("isAtrac3ScxEncoderContext accepts authored SCX contexts only", () => {
  const context = createAtrac3ScxEncoderContext();

  assert.equal(isAtrac3ScxEncoderContext(context), true);
  assert.equal(
    isAtrac3ScxEncoderContext({
      frameBytes: context.frameBytes,
      pcmLenHistory: context.pcmLenHistory,
      state: {
        channelCount: 2,
        channelHistories: [context.state.channelHistories[0]],
        channelScratch: context.state.channelScratch,
      },
    }),
    false
  );
});
