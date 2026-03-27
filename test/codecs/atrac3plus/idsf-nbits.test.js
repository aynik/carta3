import assert from "node:assert/strict";
import test from "node:test";

import { calcNbitsForIdsfChAt5 } from "../../../src/atrac3plus/bitstream/idsf-internal.js";

function createChannel(values, { channelIndex = 0, baseValues = null } = {}) {
  const shared = {
    idsfCount: values.length,
    bandCount: Math.ceil(values.length / 3),
  };
  const channel = {
    channelIndex,
    shared,
    idsf: {
      values: Uint32Array.from(values),
    },
  };

  if (baseValues) {
    channel.block0 = {
      idsf: {
        values: Uint32Array.from(baseValues),
      },
    };
  }

  return channel;
}

test("calcNbitsForIdsfChAt5 chooses primary mode 1 and records width/lead parameters", () => {
  const channel = createChannel([11, 39, 36, 30, 37, 37, 29, 35]);

  const bits = calcNbitsForIdsfChAt5(channel);

  assert.equal(bits, 46);
  assert.equal(channel.idsfModeSelect, 1);
  assert.deepEqual(
    {
      modeSelect: channel.idsf.modeSelect,
      mode: channel.idsf.mode,
      mode2: channel.idsf.mode2,
      lead: channel.idsf.lead,
      width: channel.idsf.width,
      base: channel.idsf.base,
      cbIndex: channel.idsf.cbIndex,
      baseValue: channel.idsf.baseValue,
    },
    {
      modeSelect: 1,
      mode: 0,
      mode2: 2,
      lead: 2,
      width: 3,
      base: 31,
      cbIndex: 17,
      baseValue: 29,
    }
  );
});

test("calcNbitsForIdsfChAt5 chooses primary mode 2 shape coding and refreshes scratch blocks", () => {
  const channel = createChannel([20, 20, 20, 23, 24, 20]);

  const bits = calcNbitsForIdsfChAt5(channel);

  assert.equal(bits, 26);
  assert.equal(channel.idsfModeSelect, 2);
  assert.deepEqual(
    {
      modeSelect: channel.idsf.modeSelect,
      mode: channel.idsf.mode,
      mode2: channel.idsf.mode2,
      lead: channel.idsf.lead,
      width: channel.idsf.width,
      base: channel.idsf.base,
      cbIndex: channel.idsf.cbIndex,
      baseValue: channel.idsf.baseValue,
    },
    {
      modeSelect: 2,
      mode: 2,
      mode2: 3,
      lead: 0,
      width: 3,
      base: 20,
      cbIndex: 0,
      baseValue: 20,
    }
  );
  assert.deepEqual(
    channel.idsf.mode2Values.map((values) => Array.from(values.slice(0, 6))),
    [
      [20, 20, 20, 23, 24, 20],
      [20, 20, 19, 22, 22, 18],
      [20, 20, 20, 22, 23, 19],
    ]
  );
  assert.deepEqual(Array.from(channel.idsf.sgSymbols.slice(0, 6)), [0, 0, 0, 0, 1, -3]);
});

test("calcNbitsForIdsfChAt5 chooses primary mode 3 chained deltas when cheaper", () => {
  const channel = createChannel([39, 36, 34, 31, 39, 37, 32, 18]);

  const bits = calcNbitsForIdsfChAt5(channel);

  assert.equal(bits, 44);
  assert.equal(channel.idsfModeSelect, 3);
  assert.deepEqual(
    {
      modeSelect: channel.idsf.modeSelect,
      mode: channel.idsf.mode,
      mode2: channel.idsf.mode2,
      lead: channel.idsf.lead,
      width: channel.idsf.width,
      base: channel.idsf.base,
      cbIndex: channel.idsf.cbIndex,
      baseValue: channel.idsf.baseValue,
    },
    {
      modeSelect: 3,
      mode: 0,
      mode2: 1,
      lead: 0,
      width: 5,
      base: 18,
      cbIndex: 61,
      baseValue: 36,
    }
  );
});

test("calcNbitsForIdsfChAt5 chooses direct stereo-delta coding when only the lead band changes", () => {
  const channel = createChannel([21, 20, 20, 20, 20, 20], {
    channelIndex: 1,
    baseValues: [20, 20, 20, 20, 20, 20],
  });

  const bits = calcNbitsForIdsfChAt5(channel);

  assert.equal(bits, 10);
  assert.equal(channel.idsfModeSelect, 1);
  assert.deepEqual(
    {
      modeSelect: channel.idsf.modeSelect,
      mode: channel.idsf.mode,
      mode2: channel.idsf.mode2,
    },
    {
      modeSelect: 1,
      mode: 2,
      mode2: 0,
    }
  );
});

test("calcNbitsForIdsfChAt5 chooses chained stereo deltas when the per-band base difference is smoother", () => {
  const channel = createChannel([21, 21, 21, 20, 20, 20], {
    channelIndex: 1,
    baseValues: [20, 20, 20, 20, 20, 20],
  });

  const bits = calcNbitsForIdsfChAt5(channel);

  assert.equal(bits, 12);
  assert.equal(channel.idsfModeSelect, 2);
  assert.deepEqual(
    {
      modeSelect: channel.idsf.modeSelect,
      mode: channel.idsf.mode,
      mode2: channel.idsf.mode2,
    },
    {
      modeSelect: 2,
      mode: 2,
      mode2: 0,
    }
  );
});

test("calcNbitsForIdsfChAt5 chooses copy mode for identical stereo scalefactors", () => {
  const channel = createChannel([20, 20, 20, 20, 20, 20], {
    channelIndex: 1,
    baseValues: [20, 20, 20, 20, 20, 20],
  });

  const bits = calcNbitsForIdsfChAt5(channel);

  assert.equal(bits, 0);
  assert.equal(channel.idsfModeSelect, 3);
  assert.deepEqual(
    {
      modeSelect: channel.idsf.modeSelect,
      mode: channel.idsf.mode,
      mode2: channel.idsf.mode2,
    },
    {
      modeSelect: 3,
      mode: 0,
      mode2: 0,
    }
  );
});
