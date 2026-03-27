import assert from "node:assert/strict";
import test from "node:test";

import {
  AT3_MDDATA_FAIL_SINGLE_TONE,
  encodeMddataAt3,
  getAt3MddataFailSite,
} from "../../../../src/atrac3/scx/mddata.js";
import {
  extractMultitone,
  extractSingleTones,
  singleToneCheck,
} from "../../../../src/atrac3/scx/mddata-tones.js";
import { nbitsForPackdataAt3 } from "../../../../src/atrac3/scx/pack-bits.js";
import {
  getAt3GainControlCount,
  setAt3GainControlCount,
  setAt3GainControlEntry,
} from "../../../../src/atrac3/scx/gainc-layout.js";
import { createAtrac3ScxEncoderContext } from "../../../../src/atrac3/scx/context.js";

function createChannelBlock() {
  return createAtrac3ScxEncoderContext().state.channelHistories[0].current;
}

function createStrongSingleToneSpecs() {
  const specs = new Float32Array(1024);
  const values = [40, -20, 10, -5];
  values.forEach((value, offset) => {
    specs[280 + offset] = value;
  });
  return specs;
}

function createHighBandSingleToneSpecs() {
  const specs = new Float32Array(1024);
  const values = [40, -20, 10, -5];
  values.forEach((value, offset) => {
    specs[896 + offset] = value;
  });
  return specs;
}

function createBroadbandSpecs() {
  return Float32Array.from({ length: 1024 }, (_, index) => {
    return Math.sin(index / 7) * 12 + Math.cos(index / 29) * 4;
  });
}

function createSingleToneSpecs() {
  const specs = new Float32Array(1024);
  const tones = {
    57: [1.2, -0.6, 0.3, -0.1],
    70: [1.5, -0.8, 0.4, -0.2],
  };

  for (const [toneIndex, values] of Object.entries(tones)) {
    const base = Number(toneIndex) * 4;
    values.forEach((value, offset) => {
      specs[base + offset] = value;
    });
  }

  return specs;
}

function createMultitoneSpecs() {
  const specs = new Float32Array(1024);
  const tones = {
    0: [1.5, -0.8, 0.4, -0.2],
    1: [1.2, -0.6, 0.3, -0.1],
  };

  for (const [toneIndex, values] of Object.entries(tones)) {
    const base = Number(toneIndex) * 4;
    values.forEach((value, offset) => {
      specs[base + offset] = value;
    });
  }

  return specs;
}

test("singleToneCheck preserves current threshold behavior", () => {
  const tone2 = new Int32Array(256);
  tone2[70] = 40;
  assert.equal(singleToneCheck(tone2), 2);

  const tone1 = new Int32Array(256);
  tone1[70] = 30;
  assert.equal(singleToneCheck(tone1), 1);

  const tone0 = new Int32Array(256);
  tone0[70] = 20;
  assert.equal(singleToneCheck(tone0), 0);

  const blocked = new Int32Array(256);
  blocked[70] = 40;
  blocked[10] = 35;
  assert.equal(singleToneCheck(blocked), 0);
});

test("singleToneCheck preserves the mirrored neighbor exclusion window", () => {
  const ignoredNeighbor = new Int32Array(256);
  ignoredNeighbor[70] = 40;
  ignoredNeighbor[59] = 35;
  assert.equal(singleToneCheck(ignoredNeighbor), 2);

  const blockingNeighbor = new Int32Array(256);
  blockingNeighbor[70] = 40;
  blockingNeighbor[60] = 35;
  assert.equal(singleToneCheck(blockingNeighbor), 0);
});

test("singleToneCheck preserves the upper-half mirrored neighbor exclusion window", () => {
  const ignoredNeighbor = new Int32Array(256);
  ignoredNeighbor[100] = 40;
  ignoredNeighbor[157] = 35;
  assert.equal(singleToneCheck(ignoredNeighbor), 2);

  const blockingNeighbor = new Int32Array(256);
  blockingNeighbor[100] = 40;
  blockingNeighbor[158] = 35;
  assert.equal(singleToneCheck(blockingNeighbor), 0);
});

test("singleToneCheck preserves the minimum blocker threshold clamp", () => {
  const candidates = new Int32Array(256);
  candidates[70] = 22;
  candidates[10] = 8;

  assert.equal(singleToneCheck(candidates), 1);
});

test("singleToneCheck preserves current input validation", () => {
  assert.throws(() => singleToneCheck(new Int32Array(255)), /at least 256 entries/);
});

test("encodeMddataAt3 preserves the current empty-spectrum fallback", () => {
  const ch = createChannelBlock();
  ch.specGroupCount = 0;
  ch.componentGroupCount = 0;

  const transformed = new Float32Array(1024);
  const specs = new Float32Array(1024);
  const bits = encodeMddataAt3(transformed, specs, ch);

  assert.equal(bits, 25);
  assert.equal(bits, nbitsForPackdataAt3(ch));
  assert.equal(ch.specGroupCount, 1);
  assert.equal(ch.componentGroupCount, 1);
  assert.equal(ch.mddataEntryIndex, 0);
  assert.equal(getAt3GainControlCount(ch.gaincParams[0]), 0);
  assert.equal(getAt3MddataFailSite(ch), 0);
});

test("encodeMddataAt3 preserves the current single-tone branch bookkeeping", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 0;
  ch.specGroupCount = 0x1a;
  ch.componentGroupCount = 2;

  const transformed = createStrongSingleToneSpecs();
  const specs = Float32Array.from(transformed);
  const bits = encodeMddataAt3(transformed, specs, ch);

  assert.equal(bits, 594);
  assert.equal(ch.specGroupCount, 19);
  assert.equal(ch.componentGroupCount, 2);
  assert.equal(ch.toneCount, 10);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(getAt3MddataFailSite(ch), 58);
});

test("encodeMddataAt3 preserves the current high-band single-tone layout switch", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 0;
  ch.specGroupCount = 0x1a;
  ch.componentGroupCount = 2;

  const transformed = createHighBandSingleToneSpecs();
  const specs = Float32Array.from(transformed);
  const bits = encodeMddataAt3(transformed, specs, ch);

  assert.equal(bits, 737);
  assert.equal(ch.specGroupCount, 32);
  assert.equal(ch.componentGroupCount, 4);
  assert.equal(ch.toneCount, 5);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(getAt3MddataFailSite(ch), 0);
});

test("encodeMddataAt3 preserves the current multi-band refinement profile", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 0;
  ch.specGroupCount = 0x1a;
  ch.componentGroupCount = 2;

  const transformed = createBroadbandSpecs();
  const specs = Float32Array.from(transformed);
  const bits = encodeMddataAt3(transformed, specs, ch);

  assert.equal(bits, 1536);
  assert.equal(bits, nbitsForPackdataAt3(ch));
  assert.equal(ch.specGroupCount, 26);
  assert.equal(ch.componentGroupCount, 2);
  assert.equal(ch.componentMode, 1);
  assert.equal(ch.specTableIndex, 0);
  assert.equal(ch.toneCount, 0);
  assert.equal(ch.mddataEntryIndex, 0);
  assert.deepEqual(
    Array.from(ch.idwl.slice(0, ch.specGroupCount)),
    [7, 4, 4, 4, 2, 1, 1, 1, 3, 3, 1, 3, 3, 2, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]
  );
  assert.deepEqual(Array.from(ch.idwl.slice(ch.specGroupCount, ch.specGroupCount + 3)), [0, 0, 0]);
  assert.deepEqual(
    Array.from(ch.quidsf.slice(0, ch.specGroupCount)),
    [
      27, 27, 26, 25, 26, 23, 26, 26, 27, 27, 25, 27, 27, 27, 25, 27, 27, 27, 26, 27, 26, 27, 26,
      27, 27, 26,
    ]
  );
  assert.equal(getAt3MddataFailSite(ch), 0);
});

test("encodeMddataAt3 preserves the current previous-attack broadband refinement profile", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 0;
  ch.specGroupCount = 0x1a;
  ch.componentGroupCount = 2;

  const prevChannel = createChannelBlock();
  prevChannel.componentGroupCount = 2;
  setAt3GainControlCount(prevChannel.gaincParams[0], 1);
  setAt3GainControlEntry(prevChannel.gaincParams[0], 0, 0, 0);

  const transformed = createBroadbandSpecs();
  const specs = Float32Array.from(transformed);
  const bits = encodeMddataAt3(transformed, specs, ch, prevChannel);

  assert.equal(bits, 1536);
  assert.equal(bits, nbitsForPackdataAt3(ch));
  assert.equal(ch.specGroupCount, 26);
  assert.equal(ch.componentGroupCount, 2);
  assert.equal(ch.componentMode, 1);
  assert.equal(ch.specTableIndex, 0);
  assert.equal(ch.toneCount, 0);
  assert.equal(ch.mddataEntryIndex, 0);
  assert.deepEqual(
    Array.from(ch.idwl.slice(0, ch.specGroupCount)),
    [7, 3, 3, 3, 2, 1, 2, 2, 3, 3, 1, 3, 3, 3, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]
  );
  assert.deepEqual(
    Array.from(ch.quidsf.slice(0, ch.specGroupCount)),
    [
      27, 27, 26, 25, 26, 23, 26, 26, 27, 27, 25, 27, 27, 27, 25, 27, 27, 27, 26, 27, 26, 27, 26,
      27, 27, 26,
    ]
  );
  assert.equal(getAt3MddataFailSite(ch), 0);
});

test("encodeMddataAt3 preserves the current in-frame attack broadband refinement profile", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 0;
  ch.specGroupCount = 0x1a;
  ch.componentGroupCount = 2;
  setAt3GainControlCount(ch.gaincParams[0], 1);
  setAt3GainControlEntry(ch.gaincParams[0], 0, 0, 0);

  const transformed = createBroadbandSpecs();
  const specs = Float32Array.from(transformed);
  const bits = encodeMddataAt3(transformed, specs, ch);

  assert.equal(bits, 1535);
  assert.equal(bits, nbitsForPackdataAt3(ch));
  assert.equal(ch.specGroupCount, 26);
  assert.equal(ch.componentGroupCount, 2);
  assert.equal(ch.componentMode, 1);
  assert.equal(ch.specTableIndex, 0);
  assert.equal(ch.toneCount, 0);
  assert.equal(ch.mddataEntryIndex, 0);
  assert.deepEqual(
    Array.from(ch.idwl.slice(0, ch.specGroupCount)),
    [7, 3, 2, 2, 2, 1, 2, 2, 3, 3, 1, 3, 3, 3, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]
  );
  assert.deepEqual(
    Array.from(ch.quidsf.slice(0, ch.specGroupCount)),
    [
      27, 27, 26, 25, 26, 23, 26, 26, 27, 27, 25, 27, 27, 27, 25, 27, 27, 27, 26, 27, 26, 27, 26,
      27, 27, 26,
    ]
  );
  assert.equal(getAt3MddataFailSite(ch), 0);
});

test("encodeMddataAt3 preserves current single-tone failure propagation", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 0;
  ch.specGroupCount = 0x1a;
  ch.componentGroupCount = 2;
  ch.globalState = null;

  const transformed = createStrongSingleToneSpecs();
  const specs = Float32Array.from(transformed);

  assert.equal(encodeMddataAt3(transformed, specs, ch), -32768);
  assert.equal(ch.specGroupCount, 0x1a);
  assert.equal(ch.componentGroupCount, 2);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(getAt3MddataFailSite(ch), AT3_MDDATA_FAIL_SINGLE_TONE);
});

test("encodeMddataAt3 preserves high-band single-tone failure layout mutation", () => {
  const ch = createChannelBlock();
  ch.scratchFlag = 0;
  ch.specGroupCount = 0x1a;
  ch.componentGroupCount = 2;
  ch.globalState = null;

  const transformed = createHighBandSingleToneSpecs();
  const specs = Float32Array.from(transformed);

  assert.equal(encodeMddataAt3(transformed, specs, ch), -32768);
  assert.equal(ch.specGroupCount, 32);
  assert.equal(ch.componentGroupCount, 4);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(getAt3MddataFailSite(ch), AT3_MDDATA_FAIL_SINGLE_TONE);
});

test("extractSingleTones preserves current tone-pool updates and extraction order", () => {
  const ch = createChannelBlock();
  const specs = createSingleToneSpecs();
  const scfofIds = new Int32Array(256);

  assert.equal(extractSingleTones(200, 1, 0, 70, 4, 256, specs, scfofIds, ch), 106);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(ch.toneCount, 2);
  assert.deepEqual(Array.from(ch.mddataEntries[0].groupFlags.slice(0, 4)), [1, 1, 0, 0]);
  assert.deepEqual(
    Array.from(ch.mddataEntries[0].listCounts.slice(0, 8)),
    [0, 0, 0, 1, 1, 0, 0, 0]
  );
  assert.equal(ch.mddataEntries[0].lists[4][0], 0);
  assert.equal(ch.mddataEntries[0].lists[3][0], 1);
  assert.deepEqual(
    {
      start: ch.tonePool[0].start,
      scaleFactorIndex: ch.tonePool[0].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[0].coefficients),
    },
    {
      start: 280,
      scaleFactorIndex: 17,
      coefficients: [30, -16, 8, -4, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(
    {
      start: ch.tonePool[1].start,
      scaleFactorIndex: ch.tonePool[1].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[1].coefficients),
    },
    {
      start: 228,
      scaleFactorIndex: 16,
      coefficients: [30, -15, 8, -3, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(
    Array.from(specs.slice(228, 232)),
    [0.0000752153864596039, -0.00003760769322980195, -0.019979942589998245, 0.019992481917142868]
  );
  assert.deepEqual(
    Array.from(specs.slice(280, 284)),
    [-0.01181050669401884, 0.006298925261944532, -0.003149462630972266, 0.001574731315486133]
  );
});

test("extractSingleTones preserves the current over-budget stop behavior", () => {
  const ch = createChannelBlock();
  const specs = createSingleToneSpecs();
  const scfofIds = new Int32Array(256);

  assert.equal(extractSingleTones(40, 2, 0, 70, 4, 256, specs, scfofIds, ch), 32);
  assert.equal(ch.mddataEntryIndex, 2);
  assert.equal(ch.toneCount, 0);
  assert.deepEqual(Array.from(ch.mddataEntries[0].groupFlags.slice(0, 4)), [0, 1, 0, 0]);
  assert.deepEqual(
    Array.from(ch.mddataEntries[0].listCounts.slice(0, 8)),
    [0, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(Array.from(ch.mddataEntries[1].groupFlags.slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(
    {
      start: ch.tonePool[0].start,
      scaleFactorIndex: ch.tonePool[0].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[0].coefficients),
    },
    {
      start: 280,
      scaleFactorIndex: 17,
      coefficients: [30, -16, 8, -4, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(
    Array.from(specs.slice(280, 284)),
    [1.5, -0.800000011920929, 0.4000000059604645, -0.20000000298023224]
  );
});

test("extractSingleTones preserves the current in-entry mirrored scan after budget stop", () => {
  const ch = createChannelBlock();
  const specs = createSingleToneSpecs();
  const scfofIds = new Int32Array(256);

  assert.equal(extractSingleTones(50, 2, 0, 70, 4, 256, specs, scfofIds, ch), 44);
  assert.equal(ch.mddataEntryIndex, 2);
  assert.equal(ch.toneCount, 0);
  assert.deepEqual(Array.from(ch.mddataEntries[0].groupFlags.slice(0, 4)), [1, 1, 0, 0]);
  assert.deepEqual(
    Array.from(ch.mddataEntries[0].listCounts.slice(0, 8)),
    [0, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    {
      start: ch.tonePool[0].start,
      scaleFactorIndex: ch.tonePool[0].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[0].coefficients),
    },
    {
      start: 228,
      scaleFactorIndex: 16,
      coefficients: [30, -15, 8, -3, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(
    Array.from(specs.slice(228, 232)),
    [1.2000000476837158, -0.6000000238418579, 0.30000001192092896, -0.10000000149011612]
  );
  assert.deepEqual(
    Array.from(specs.slice(280, 284)),
    [1.5, -0.800000011920929, 0.4000000059604645, -0.20000000298023224]
  );
});

test("extractSingleTones preserves the current invalid-context slot staging", () => {
  const ch = createChannelBlock();
  ch.globalState = null;
  const specs = createSingleToneSpecs();
  const scfofIds = new Int32Array(256);

  assert.equal(extractSingleTones(200, 1, 0, 70, 4, 256, specs, scfofIds, ch), -32768);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(ch.toneCount, 0);
  assert.deepEqual(Array.from(ch.mddataEntries[0].groupFlags.slice(0, 4)), [0, 1, 0, 0]);
  assert.deepEqual(
    Array.from(ch.mddataEntries[0].listCounts.slice(0, 8)),
    [0, 0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(
    {
      start: ch.tonePool[0].start,
      scaleFactorIndex: ch.tonePool[0].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[0].coefficients),
    },
    {
      start: 280,
      scaleFactorIndex: 17,
      coefficients: [0, 0, 0, 0, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(
    Array.from(specs.slice(280, 284)),
    [1.5, -0.800000011920929, 0.4000000059604645, -0.20000000298023224]
  );
});

test("extractSingleTones preserves current edge-group target filtering", () => {
  const firstGroupChannel = createChannelBlock();
  const firstGroupSpecs = new Float32Array(1024);
  [1.5, -0.8, 0.4, -0.2].forEach((value, offset) => {
    firstGroupSpecs[offset] = value;
  });

  assert.equal(
    extractSingleTones(
      200,
      1,
      0,
      0,
      4,
      256,
      firstGroupSpecs,
      new Int32Array(256),
      firstGroupChannel
    ),
    58
  );
  assert.deepEqual(
    Array.from(firstGroupChannel.mddataEntries[0].groupFlags.slice(0, 4)),
    [1, 0, 0, 0]
  );
  assert.equal(firstGroupChannel.toneCount, 1);

  const lastGroupChannel = createChannelBlock();
  const lastGroupSpecs = new Float32Array(1024);
  const lastBase = 255 * 4;
  [1.5, -0.8, 0.4, -0.2].forEach((value, offset) => {
    lastGroupSpecs[lastBase + offset] = value;
  });

  assert.equal(
    extractSingleTones(
      200,
      1,
      0,
      255,
      4,
      256,
      lastGroupSpecs,
      new Int32Array(256),
      lastGroupChannel
    ),
    58
  );
  assert.deepEqual(
    Array.from(lastGroupChannel.mddataEntries[0].groupFlags.slice(0, 4)),
    [0, 0, 0, 1]
  );
  assert.equal(lastGroupChannel.toneCount, 1);
});

test("extractSingleTones preserves current invalid-channel contract", () => {
  assert.throws(
    () => extractSingleTones(10, 1, 0, 0, 1, 1, new Float32Array(4), new Int32Array(1), null),
    /channel must be an object/
  );
});

test("extractMultitone preserves the current single-pass success path", () => {
  const ch = createChannelBlock();
  const specs = createMultitoneSpecs();
  const tonesAIds = Int32Array.from([40, 38, 0, 0]);
  const tonesBIds = Int32Array.from([40, 38, 0, 0]);

  assert.equal(extractMultitone(200, 4, 5, 0, tonesAIds, tonesBIds, specs, ch), 95);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(ch.toneCount, 2);
  assert.deepEqual(Array.from(ch.mddataEntries[0].groupFlags.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(ch.mddataEntries[0].listCounts.slice(0, 4)), [2, 0, 0, 0]);
  assert.deepEqual(Array.from(ch.mddataEntries[0].lists[0].slice(0, 4)), [0, 1, 0, 0]);
  assert.deepEqual(
    {
      start: ch.tonePool[0].start,
      scaleFactorIndex: ch.tonePool[0].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[0].coefficients),
    },
    {
      start: 0,
      scaleFactorIndex: 17,
      coefficients: [30, -16, 8, -4, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(
    {
      start: ch.tonePool[1].start,
      scaleFactorIndex: ch.tonePool[1].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[1].coefficients),
    },
    {
      start: 4,
      scaleFactorIndex: 16,
      coefficients: [30, -15, 8, -3, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(Array.from(tonesAIds), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(tonesBIds), [0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(specs.slice(0, 8)),
    [
      -0.01181050669401884, 0.006298925261944532, -0.003149462630972266, 0.001574731315486133,
      0.0000752153864596039, -0.00003760769322980195, -0.019979942589998245, 0.019992481917142868,
    ]
  );
});

test("extractMultitone preserves the current no-candidate fast path", () => {
  const ch = createChannelBlock();
  const specs = createMultitoneSpecs();
  const tonesAIds = Int32Array.from([32, 31, 0, 0]);
  const tonesBIds = Int32Array.from([32, 31, 0, 0]);

  assert.equal(extractMultitone(200, 4, 5, 0, tonesAIds, tonesBIds, specs, ch), 0);
  assert.equal(ch.mddataEntryIndex, 0);
  assert.equal(ch.toneCount, 0);
  assert.deepEqual(Array.from(tonesAIds), [32, 31, 0, 0]);
  assert.deepEqual(Array.from(tonesBIds), [32, 31, 0, 0]);
});

test("extractMultitone preserves the current tone-pool capacity gate", () => {
  const oneSlotLeftChannel = createChannelBlock();
  oneSlotLeftChannel.toneCount = 63;
  const oneSlotLeftA = Int32Array.from([40, 38, 0, 0]);
  const oneSlotLeftB = Int32Array.from([40, 38, 0, 0]);

  assert.equal(
    extractMultitone(
      200,
      4,
      5,
      0,
      oneSlotLeftA,
      oneSlotLeftB,
      createMultitoneSpecs(),
      oneSlotLeftChannel
    ),
    59
  );
  assert.equal(oneSlotLeftChannel.mddataEntryIndex, 1);
  assert.equal(oneSlotLeftChannel.toneCount, 64);
  assert.deepEqual(
    Array.from(oneSlotLeftChannel.mddataEntries[0].listCounts.slice(0, 4)),
    [1, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(oneSlotLeftChannel.mddataEntries[0].lists[0].slice(0, 4)),
    [63, 0, 0, 0]
  );
  assert.deepEqual(Array.from(oneSlotLeftA), [0, 38, 0, 0]);
  assert.deepEqual(Array.from(oneSlotLeftB), [0, 38, 0, 0]);

  const fullPoolChannel = createChannelBlock();
  fullPoolChannel.toneCount = 64;
  const fullPoolA = Int32Array.from([40, 38, 0, 0]);
  const fullPoolB = Int32Array.from([40, 38, 0, 0]);

  assert.equal(
    extractMultitone(200, 4, 5, 0, fullPoolA, fullPoolB, createMultitoneSpecs(), fullPoolChannel),
    0
  );
  assert.equal(fullPoolChannel.mddataEntryIndex, 0);
  assert.equal(fullPoolChannel.toneCount, 64);
  assert.deepEqual(Array.from(fullPoolA), [40, 38, 0, 0]);
  assert.deepEqual(Array.from(fullPoolB), [40, 38, 0, 0]);
});

test("extractMultitone preserves current preflight candidate selection near tone-pool saturation", () => {
  const ch = createChannelBlock();
  ch.toneCount = 62;
  const specs = createMultitoneSpecs();
  const tonesAIds = Int32Array.from([40, 38, 0, 0]);
  const tonesBIds = Int32Array.from([40, 38, 0, 0]);

  assert.equal(extractMultitone(200, 4, 5, 0, tonesAIds, tonesBIds, specs, ch), 95);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(ch.toneCount, 64);
  assert.deepEqual(Array.from(ch.mddataEntries[0].listCounts.slice(0, 4)), [2, 0, 0, 0]);
  assert.deepEqual(Array.from(ch.mddataEntries[0].lists[0].slice(0, 4)), [62, 63, 0, 0]);
  assert.deepEqual(Array.from(tonesAIds), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(tonesBIds), [0, 0, 0, 0]);
  assert.deepEqual(
    {
      start: ch.tonePool[62].start,
      scaleFactorIndex: ch.tonePool[62].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[62].coefficients),
    },
    {
      start: 0,
      scaleFactorIndex: 17,
      coefficients: [30, -16, 8, -4, 0, 0, 0, 0],
    }
  );
  assert.deepEqual(
    {
      start: ch.tonePool[63].start,
      scaleFactorIndex: ch.tonePool[63].scaleFactorIndex,
      coefficients: Array.from(ch.tonePool[63].coefficients),
    },
    {
      start: 4,
      scaleFactorIndex: 16,
      coefficients: [30, -15, 8, -3, 0, 0, 0, 0],
    }
  );
});

test("extractMultitone preserves the current per-entry tone-list rollover", () => {
  const ch = createChannelBlock();
  const specs = new Float32Array(1024);
  for (let toneIndex = 0; toneIndex < 8; toneIndex += 1) {
    const base = toneIndex * 4;
    specs[base] = 1.5;
    specs[base + 1] = -0.8;
    specs[base + 2] = 0.4;
    specs[base + 3] = -0.2;
  }

  const tonesAIds = Int32Array.from({ length: 8 }, () => 40);
  const tonesBIds = Int32Array.from({ length: 8 }, () => 40);

  assert.equal(extractMultitone(1000, 8, 5, 0, tonesAIds, tonesBIds, specs, ch), 334);
  assert.equal(ch.mddataEntryIndex, 2);
  assert.equal(ch.toneCount, 8);
  assert.deepEqual(Array.from(ch.mddataEntries[0].listCounts.slice(0, 4)), [7, 0, 0, 0]);
  assert.deepEqual(Array.from(ch.mddataEntries[1].listCounts.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(ch.mddataEntries[0].lists[0].slice(0, 7)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(ch.mddataEntries[1].lists[0].slice(0, 4)), [7, 0, 0, 0]);
  assert.deepEqual(Array.from(tonesAIds), new Array(8).fill(0));
  assert.deepEqual(Array.from(tonesBIds), new Array(8).fill(0));
});

test("extractMultitone preserves the current budget-stop behavior", () => {
  const entryStopChannel = createChannelBlock();
  const entryStopSpecs = createMultitoneSpecs();
  const entryStopA = Int32Array.from([40, 38, 0, 0]);
  const entryStopB = Int32Array.from([40, 38, 0, 0]);

  assert.equal(
    extractMultitone(10, 4, 5, 0, entryStopA, entryStopB, entryStopSpecs, entryStopChannel),
    0
  );
  assert.equal(entryStopChannel.mddataEntryIndex, 0);
  assert.equal(entryStopChannel.toneCount, 0);
  assert.deepEqual(
    Array.from(entryStopChannel.mddataEntries[0].groupFlags.slice(0, 4)),
    [0, 0, 0, 0]
  );

  const groupStopChannel = createChannelBlock();
  const groupStopSpecs = createMultitoneSpecs();
  const groupStopA = Int32Array.from([40, 38, 0, 0]);
  const groupStopB = Int32Array.from([40, 38, 0, 0]);

  assert.equal(
    extractMultitone(30, 4, 5, 0, groupStopA, groupStopB, groupStopSpecs, groupStopChannel),
    23
  );
  assert.equal(groupStopChannel.mddataEntryIndex, 1);
  assert.equal(groupStopChannel.toneCount, 0);
  assert.deepEqual(
    Array.from(groupStopChannel.mddataEntries[0].groupFlags.slice(0, 4)),
    [1, 0, 0, 0]
  );
  assert.deepEqual(
    Array.from(groupStopChannel.mddataEntries[0].listCounts.slice(0, 4)),
    [0, 0, 0, 0]
  );
});

test("extractMultitone preserves the current in-pass tone-stop behavior", () => {
  const ch = createChannelBlock();
  const specs = createMultitoneSpecs();
  const tonesAIds = Int32Array.from([40, 38, 0, 0]);
  const tonesBIds = Int32Array.from([40, 38, 0, 0]);

  assert.equal(extractMultitone(60, 4, 5, 0, tonesAIds, tonesBIds, specs, ch), 59);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(ch.toneCount, 1);
  assert.deepEqual(Array.from(ch.mddataEntries[0].groupFlags.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(ch.mddataEntries[0].listCounts.slice(0, 4)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(ch.mddataEntries[0].lists[0].slice(0, 4)), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(tonesAIds), [0, 38, 0, 0]);
  assert.deepEqual(Array.from(tonesBIds), [0, 38, 0, 0]);
});

test("extractMultitone preserves the current invalid-context error return", () => {
  const ch = createChannelBlock();
  ch.globalState = null;

  assert.equal(
    extractMultitone(
      200,
      1,
      5,
      0,
      Int32Array.from([40]),
      Int32Array.from([40]),
      createMultitoneSpecs(),
      ch
    ),
    -32768
  );
});

test("extractMultitone preserves the explicit toneCtx override", () => {
  const ch = createChannelBlock();
  const toneCtx = ch.globalState;
  ch.globalState = null;

  const specs = createMultitoneSpecs();
  const tonesAIds = Int32Array.from([40, 38, 0, 0]);
  const tonesBIds = Int32Array.from([40, 38, 0, 0]);

  assert.equal(extractMultitone(200, 4, 5, 0, tonesAIds, tonesBIds, specs, ch, toneCtx), 95);
  assert.equal(ch.mddataEntryIndex, 1);
  assert.equal(ch.toneCount, 2);
  assert.deepEqual(Array.from(tonesAIds), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(tonesBIds), [0, 0, 0, 0]);
});

test("extractMultitone preserves current invalid-channel contract", () => {
  assert.throws(
    () =>
      extractMultitone(
        10,
        1,
        0,
        0,
        Int32Array.from([1]),
        Int32Array.from([1]),
        new Float32Array(4),
        null
      ),
    /channel must be an object/
  );
});
