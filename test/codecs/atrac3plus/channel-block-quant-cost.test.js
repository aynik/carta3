import assert from "node:assert/strict";
import test from "node:test";

import { quantNontoneNspecsAt5 } from "../../../src/atrac3plus/channel-block/quant-cost.js";
import {
  createBitallocHeader,
  createChannelBlock,
} from "../../../src/atrac3plus/channel-block/construction.js";

function createQuantCostFixture(tblIndex = 0) {
  const block = createChannelBlock();
  const hdr = createBitallocHeader(1);
  hdr.tblIndex = tblIndex;
  block.bitallocHeader = hdr;
  return { block, workByCtx: block.hcspecWorkByCtx };
}

const SPEC_FIXTURE = Float32Array.from({ length: 16 }, (_, i) => ((i % 7) - 3) * 0.75);

test("quantNontoneNspecsAt5 preserves ctx-specific cost tables across grouped modes", () => {
  const expectedByCtx = [
    {
      1: [0, 0, 0, 1, 0, 0, 0, 0],
      2: [14, 14, 12, 14, 0, 0, 0, 0],
      3: [58, 51, 49, 57, 0, 0, 0, 0],
      4: [26, 32, 27, 34, 0, 0, 0, 0],
      5: [69, 70, 36, 73, 0, 0, 0, 0],
      6: [95, 44, 93, 96, 0, 0, 0, 0],
      7: [100, 100, 98, 100, 0, 0, 0, 0],
    },
    {
      1: [0, 1, 0, 1, 0, 0, 0, 0],
      2: [14, 14, 15, 14, 0, 0, 0, 0],
      3: [64, 63, 51, 52, 0, 0, 0, 0],
      4: [27, 30, 26, 32, 0, 0, 0, 0],
      5: [70, 69, 74, 77, 0, 0, 0, 0],
      6: [95, 96, 101, 44, 0, 0, 0, 0],
      7: [102, 100, 104, 112, 0, 0, 0, 0],
    },
  ];

  for (const [ctxId, expectedByMode] of expectedByCtx.entries()) {
    const { block, workByCtx } = createQuantCostFixture();
    for (const [mode, expected] of Object.entries(expectedByMode)) {
      const work = workByCtx[ctxId];
      work.costsByBand.fill(0);

      quantNontoneNspecsAt5(ctxId, 0, Number(mode), 0, 1, 16, SPEC_FIXTURE, work, block);

      assert.deepEqual(
        Array.from(work.costsByBand.slice(0, 8)),
        expected,
        `ctx=${ctxId} mode=${mode}`
      );
    }
  }
});
