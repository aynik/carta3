import assert from "node:assert/strict";
import test from "node:test";

import {
  createAtrac3plusEncodeHandle,
  createAtrac3plusEncodeRuntime,
} from "../../../src/atrac3plus/encode.js";
import {
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_INTENSITY_DEFAULT,
  at5SigprocAnalyzeFrame,
} from "../../../src/atrac3plus/sigproc/index.js";
import { at5MapCountForBandCount } from "../../../src/atrac3plus/tables/unpack.js";

function createSigprocFixture({
  sampleRate = 44100,
  mode = 2,
  frameBytes = 560,
  inputChannels = 2,
  bitrateKbps = null,
} = {}) {
  const handle = createAtrac3plusEncodeHandle({
    sampleRate,
    mode,
    frameBytes,
    inputChannels,
    ...(bitrateKbps === null ? {} : { bitrateKbps }),
  });
  const runtime = createAtrac3plusEncodeRuntime(handle);
  const block = runtime.blocks[0];
  const inputPtrs = Array.from({ length: block.channelsInBlock }, () => new Float32Array(2048));
  return { block, inputPtrs };
}

function setGainPoints(record, points) {
  record.entries = points.length;
  for (let i = 0; i < points.length; i += 1) {
    const [location, level] = points[i];
    record.locations[i] = location;
    record.levels[i] = level;
  }
}

test("at5SigprocAnalyzeFrame shifts encode flags and syncs stereo shared layout", () => {
  const { block, inputPtrs } = createSigprocFixture();
  block.shared.encodeFlags = 0x01;

  const result = at5SigprocAnalyzeFrame({
    inputPtrs,
    timeStates: block.timeStates,
    shared: block.shared,
    aux: block.aux,
    blocks: block.channelEntries,
    channelCount: block.channelsInBlock,
    blockMode: block.blockMode,
    ispsIndex: block.ispsIndex,
    callIndex: 3,
  });

  const expectedBandCount = at5MapCountForBandCount(block.ispsIndex);

  assert.equal(result.channels, 2);
  assert.equal(result.bandCount, expectedBandCount);
  assert.equal(block.shared.encodeFlags, 0x02);
  assert.equal(block.shared.channels, 2);
  assert.equal(block.shared.idsfCount, block.ispsIndex);
  assert.equal(block.shared.codedBandLimit, block.ispsIndex);
  assert.equal(block.shared.mapSegmentCount, expectedBandCount);
  assert.equal(block.channelEntries[0].gainActiveCount, expectedBandCount);
  assert.equal(block.channelEntries[1].gainActiveCount, expectedBandCount);
});

test("at5SigprocAnalyzeFrame widens active encode-flag layouts and keeps mono intensity default", () => {
  const { block, inputPtrs } = createSigprocFixture({
    mode: 1,
    frameBytes: 280,
    inputChannels: 1,
    bitrateKbps: 48,
  });
  block.shared.encodeFlags = 0x20;

  const result = at5SigprocAnalyzeFrame({
    inputPtrs,
    timeStates: block.timeStates,
    shared: block.shared,
    aux: block.aux,
    blocks: block.channelEntries,
    channelCount: block.channelsInBlock,
    blockMode: block.blockMode,
    ispsIndex: 6,
    callIndex: 1,
  });

  const forcedIspsIndex = 0x20;
  const expectedBandCount = at5MapCountForBandCount(forcedIspsIndex);

  assert.equal(result.channels, 1);
  assert.equal(result.bandCount, expectedBandCount);
  assert.equal(block.aux.intensityBand[0], AT5_SIGPROC_INTENSITY_DEFAULT);
  assert.equal(block.shared.encodeFlags, 0x40);
  assert.equal(block.shared.idsfCount, forcedIspsIndex);
  assert.equal(block.shared.codedBandLimit, forcedIspsIndex);
  assert.equal(block.shared.mapSegmentCount, expectedBandCount);
  assert.equal(block.channelEntries[0].gainActiveCount, expectedBandCount);
});

test("at5SigprocAnalyzeFrame carries the previous stereo correlation flags into shared.swapMap", () => {
  const { block, inputPtrs } = createSigprocFixture();
  const previousFlagRow = AT5_SIGPROC_BANDS_MAX;
  block.aux.corrFlagsHist[previousFlagRow] = 1;
  block.aux.corrFlagsHist[previousFlagRow + 2] = 1;

  at5SigprocAnalyzeFrame({
    inputPtrs,
    timeStates: block.timeStates,
    shared: block.shared,
    aux: block.aux,
    blocks: block.channelEntries,
    channelCount: block.channelsInBlock,
    blockMode: block.blockMode,
    ispsIndex: block.ispsIndex,
  });

  assert.ok(block.shared.swapMap instanceof Uint32Array);
  assert.equal(block.shared.swapMap[0], 1);
  assert.equal(block.shared.swapMap[1], 0);
  assert.equal(block.shared.swapMap[2], 1);
});

test("at5SigprocAnalyzeFrame gates the ghwave stage behind disableGh", () => {
  const enabledFixture = createSigprocFixture();
  const disabledFixture = createSigprocFixture();

  at5SigprocAnalyzeFrame({
    inputPtrs: enabledFixture.inputPtrs,
    timeStates: enabledFixture.block.timeStates,
    shared: enabledFixture.block.shared,
    aux: enabledFixture.block.aux,
    blocks: enabledFixture.block.channelEntries,
    channelCount: enabledFixture.block.channelsInBlock,
    blockMode: enabledFixture.block.blockMode,
    ispsIndex: enabledFixture.block.ispsIndex,
  });
  at5SigprocAnalyzeFrame({
    inputPtrs: disabledFixture.inputPtrs,
    timeStates: disabledFixture.block.timeStates,
    shared: disabledFixture.block.shared,
    aux: disabledFixture.block.aux,
    blocks: disabledFixture.block.channelEntries,
    channelCount: disabledFixture.block.channelsInBlock,
    blockMode: disabledFixture.block.blockMode,
    ispsIndex: disabledFixture.block.ispsIndex,
    disableGh: true,
  });

  assert.ok(enabledFixture.block.channelEntries[0].sharedAux?.scratch?.ghwave);
  assert.ok(enabledFixture.block.channelEntries[0].sharedAux?.scratch?.ghwave?.generalWork);
  assert.equal(disabledFixture.block.channelEntries[0].sharedAux?.scratch?.ghwave, undefined);
});

test("at5SigprocAnalyzeFrame runs mono lowmode repair and maxima when the mode is eligible", () => {
  const { block, inputPtrs } = createSigprocFixture({
    mode: 1,
    frameBytes: 280,
    inputChannels: 1,
    bitrateKbps: 48,
  });
  const nextCur = block.channelEntries[0].prevBuf;

  setGainPoints(nextCur.records[0], [[8, 7]]);
  setGainPoints(nextCur.records[1], [
    [4, 10],
    [7, 7],
  ]);
  setGainPoints(nextCur.records[2], [[4, 8]]);
  setGainPoints(nextCur.records[3], [[5, 8]]);
  block.aux.corrMetric0Hist.set([12, 24, 36, 48], 16);

  const result = at5SigprocAnalyzeFrame({
    inputPtrs,
    timeStates: block.timeStates,
    shared: block.shared,
    aux: block.aux,
    blocks: block.channelEntries,
    quantizedSpectraByChannel: block.quantizedSpectraByChannel,
    bitallocSpectraByChannel: block.bitallocSpectraByChannel,
    runTime2freq: true,
    encodeMode: 0,
    coreMode: 0x0f,
    channelCount: block.channelsInBlock,
    blockMode: block.blockMode,
    ispsIndex: 18,
  });

  const cur = block.channelEntries[0].curBuf;

  assert.equal(result.bandCount, 4);
  assert.equal(result.time2freq.corrAvg, 30);
  assert.equal(result.time2freq.corrByBand[2], 36);
  assert.ok(result.time2freq.maxima);
  assert.equal(cur.records[0].entries, 2);
  assert.deepEqual(Array.from(cur.records[0].locations.slice(0, 2)), [4, 8]);
  assert.deepEqual(Array.from(cur.records[0].levels.slice(0, 2)), [8, 7]);
});

test("at5SigprocAnalyzeFrame skips lowmode repair and maxima in encoder2 mode", () => {
  const { block, inputPtrs } = createSigprocFixture({
    mode: 1,
    frameBytes: 280,
    inputChannels: 1,
    bitrateKbps: 48,
  });
  const nextCur = block.channelEntries[0].prevBuf;

  setGainPoints(nextCur.records[0], [[8, 7]]);
  setGainPoints(nextCur.records[1], [
    [4, 10],
    [7, 7],
  ]);
  setGainPoints(nextCur.records[2], [[4, 8]]);
  setGainPoints(nextCur.records[3], [[5, 8]]);
  block.aux.corrMetric0Hist.set([12, 24, 36, 48], 16);

  const result = at5SigprocAnalyzeFrame({
    inputPtrs,
    timeStates: block.timeStates,
    shared: block.shared,
    aux: block.aux,
    blocks: block.channelEntries,
    quantizedSpectraByChannel: block.quantizedSpectraByChannel,
    bitallocSpectraByChannel: block.bitallocSpectraByChannel,
    runTime2freq: true,
    encodeMode: 2,
    coreMode: 0x0f,
    channelCount: block.channelsInBlock,
    blockMode: block.blockMode,
    ispsIndex: 18,
  });

  const cur = block.channelEntries[0].curBuf;

  assert.equal(result.bandCount, 4);
  assert.equal(result.time2freq.maxima, null);
  assert.equal(result.time2freq.corrAvg, 30);
  assert.equal(cur.records[0].entries, 1);
  assert.equal(cur.records[0].locations[0], 8);
  assert.equal(cur.records[0].levels[0], 7);
});
