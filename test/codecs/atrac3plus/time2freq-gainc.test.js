import assert from "node:assert/strict";
import test from "node:test";

import { createAt5EncodeBufBlock } from "../../../src/atrac3plus/time2freq/buf.js";
import { AT5_T2F_BANDS_MAX } from "../../../src/atrac3plus/time2freq/constants.js";
import { at5T2fGaincSetup } from "../../../src/atrac3plus/time2freq/gainc.js";

function createBlock(shared = {}, blockState = {}) {
  return {
    header: {
      shared,
      blockState,
    },
  };
}

function createAnalysisRows(channelCount) {
  return Array.from({ length: channelCount * AT5_T2F_BANDS_MAX }, (_, index) => ({ index }));
}

test("at5T2fGaincSetup walks bands in descending order and reuses close stereo minAll history in regular mode", () => {
  const prevBufs = [createAt5EncodeBufBlock(), createAt5EncodeBufBlock()];
  const curBufs = [createAt5EncodeBufBlock(), createAt5EncodeBufBlock()];
  const analysisPtrs = createAnalysisRows(2);
  const calls = [];
  const corrByBand = new Float32Array(AT5_T2F_BANDS_MAX).fill(31);

  prevBufs[0].records[5].minAll = 10;
  prevBufs[1].records[5].minAll = 9;

  at5T2fGaincSetup(
    [createBlock({ encodeFlagCc: 0 })],
    analysisPtrs,
    prevBufs,
    curBufs,
    2,
    16,
    0x12,
    corrByBand,
    31,
    (blocks, analysis, band, channel) => {
      calls.push({
        band,
        channel,
        analysis,
      });
    }
  );

  assert.equal(prevBufs[1].records[5].minAll, 10);
  assert.equal(calls.length, AT5_T2F_BANDS_MAX * 2);
  assert.deepEqual(calls[0], {
    band: 15,
    channel: 0,
    analysis: analysisPtrs[15],
  });
  assert.deepEqual(calls[1], {
    band: 15,
    channel: 1,
    analysis: analysisPtrs[31],
  });
  assert.deepEqual(calls.at(-1), {
    band: 0,
    channel: 1,
    analysis: analysisPtrs[16],
  });
});

test("at5T2fGaincSetup clears stale attackFirst markers after regular-mode setup", () => {
  const curBuf = createAt5EncodeBufBlock();

  curBuf.records[0].attackPoints = 0;
  curBuf.records[0].attackFirst = 8;
  curBuf.records[1].attackPoints = 2;
  curBuf.records[1].attackFirst = 9;

  at5T2fGaincSetup(
    [createBlock({ encodeFlagCc: 0 })],
    undefined,
    [createAt5EncodeBufBlock()],
    [curBuf],
    1,
    16,
    0x12
  );

  assert.equal(curBuf.records[0].attackFirst, 0);
  assert.equal(curBuf.records[1].attackFirst, 9);
});

test("at5T2fGaincSetup delegates CC-mode analysis and resets the current gain records", () => {
  const curBuf = createAt5EncodeBufBlock();
  const analysisPtrs = createAnalysisRows(1);
  let detectArgs = null;
  let regularCalls = 0;

  curBuf.records[0].entries = 1;
  curBuf.records[0].locations[0] = 4;
  curBuf.records[0].locations[1] = 7;
  curBuf.records[0].levels[0] = 9;
  curBuf.records[0].levels[1] = 8;
  curBuf.records[0].minAll = 6;
  curBuf.records[0].ampScaledMax = 7;
  curBuf.records[0].attackSeedLimit = 8;
  curBuf.records[0].derivMaxAll = 9;
  curBuf.records[0].derivSeedLimit = 10;
  curBuf.records[0].ampSlotMaxSum = 11;
  curBuf.records[0].derivSlotMaxSum = 12;
  curBuf.records[0].attackPoints = 0;
  curBuf.records[0].attackFirst = 13;

  curBuf.records[1].attackPoints = 1;
  curBuf.records[1].attackFirst = 14;

  at5T2fGaincSetup(
    [createBlock({ encodeFlagCc: 1 })],
    analysisPtrs,
    [createAt5EncodeBufBlock()],
    [curBuf],
    1,
    16,
    0x18,
    null,
    undefined,
    () => {
      regularCalls += 1;
    },
    (blocks, analysisRows, prevRows, curRows, channelCount, bandCount, coreMode) => {
      detectArgs = {
        blocks,
        analysisPtrs: analysisRows,
        prevBufs: prevRows,
        curBufs: curRows,
        channelCount,
        bandCount,
        coreMode,
      };
    }
  );

  assert.equal(regularCalls, 0);
  assert.ok(detectArgs);
  assert.equal(detectArgs.analysisPtrs, analysisPtrs);
  assert.equal(detectArgs.curBufs[0], curBuf);
  assert.equal(detectArgs.coreMode, 0x18);

  assert.equal(curBuf.records[0].minAll, 0);
  assert.equal(curBuf.records[0].ampScaledMax, 0);
  assert.equal(curBuf.records[0].attackSeedLimit, 0);
  assert.equal(curBuf.records[0].derivMaxAll, 0);
  assert.equal(curBuf.records[0].derivSeedLimit, 0);
  assert.equal(curBuf.records[0].ampSlotMaxSum, 0);
  assert.equal(curBuf.records[0].derivSlotMaxSum, 0);
  assert.equal(curBuf.records[0].locations[0], 4);
  assert.equal(curBuf.records[0].levels[0], 9);
  assert.equal(curBuf.records[0].locations[1], 0);
  assert.equal(curBuf.records[0].levels[1], 0);
  assert.equal(curBuf.records[0].attackFirst, 0);
  assert.equal(curBuf.records[1].attackFirst, 14);
});

test("at5T2fGaincSetup skips the gain-control pass entirely for mode-4 blocks", () => {
  const prevBufs = [createAt5EncodeBufBlock()];
  const curBufs = [createAt5EncodeBufBlock()];
  let setCalls = 0;
  let detectCalls = 0;

  curBufs[0].records[0].attackFirst = 6;

  at5T2fGaincSetup(
    [createBlock({ encodeFlagCc: 0 }, { isMode4Block: 1 })],
    undefined,
    prevBufs,
    curBufs,
    1,
    16,
    0x12,
    null,
    undefined,
    () => {
      setCalls += 1;
    },
    () => {
      detectCalls += 1;
    }
  );

  assert.equal(setCalls, 0);
  assert.equal(detectCalls, 0);
  assert.equal(curBufs[0].records[0].attackFirst, 6);
});
