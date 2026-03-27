import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustScalefactorsAt5,
  computeSpcLevelSlotsAt5,
  pwcQuAt5,
} from "../../../src/atrac3plus/channel-block/spc-levels.js";
import { copyAt5RebitallocMirror } from "../../../src/atrac3plus/rebitalloc-layout.js";
import {
  AT5_IDSPCBANDS,
  AT5_ISPS,
  AT5_NSPS,
  AT5_X,
} from "../../../src/atrac3plus/tables/unpack.js";

function setBandScratch(channel, band, value) {
  const start = AT5_ISPS[band] >>> 0;
  const end = AT5_ISPS[band + 1] >>> 0;
  channel.scratchSpectra.fill(value, start, end);
}

function createSpcLevelFixture({ channelCount = 1, mode3BandMask = null } = {}) {
  const shared = { idsfCount: 26, mapCount: 4, channels: channelCount };
  const channels = Array.from({ length: channelCount }, () => ({
    shared,
    idsf: { values: new Uint32Array(32) },
    idwl: { values: new Uint32Array(32) },
    spclevIndex: new Uint32Array(8),
    scratchSpectra: new Int16Array(2048),
    curBuf: { records: [] },
    prevBuf: { records: [] },
  }));

  return {
    blocks: Array.from({ length: channelCount }, () => ({
      bandLevels: new Float32Array(32),
    })),
    channels,
    hdr: { mode3BandMask: mode3BandMask ?? new Uint32Array(32) },
    shared,
  };
}

function runScalefactorAdjustmentCase({ scratchValue, refValue, bandLevel = 1, shift = 1 }) {
  const band = 18;
  const isps = AT5_ISPS[band];
  const nsps = AT5_NSPS[band];
  const slot = AT5_IDSPCBANDS[AT5_X[band + 1]];
  const scratchSpectra = new Float32Array(isps + nsps + 32);
  const referenceSpectra = new Float32Array(isps + nsps + 32);
  scratchSpectra.fill(scratchValue, isps, isps + nsps);
  referenceSpectra.fill(refValue, isps, isps + nsps);

  const hdr = {
    bitsIdsf: 8,
    bitsTotal: 15,
    bitsTotalBase: 8,
    idsfModeWord: 1,
    mode3BandMask: new Uint32Array(26),
  };
  const channel = {
    shared: { idsfCount: 26, mapCount: 4, channels: 1 },
    idsf: { values: new Uint32Array(26), modeSelect: 1 },
    idwl: { values: new Uint32Array(26) },
    spclevIndex: new Uint32Array(8),
    scratchSpectra,
    curBuf: { records: [] },
    prevBuf: { records: [] },
  };
  channel.idsf.values[band] = 20;
  channel.idwl.values[band] = shift;
  channel.spclevIndex[slot] = 15;

  adjustScalefactorsAt5(
    [
      {
        bitallocHeader: hdr,
        bandLevels: Uint32Array.from({ length: 26 }, (_, index) =>
          index === band ? bandLevel : 0
        ),
      },
    ],
    [referenceSpectra],
    [channel],
    1,
    26,
    0x18
  );

  return { hdr, channel, band };
}

test("copyAt5RebitallocMirror copies only the active mirror payload", () => {
  const src = Uint8Array.from({ length: 0x100 }, (_, index) => index & 0xff);
  const channel = {};

  copyAt5RebitallocMirror(channel, { bytes: src }, 2);

  const dst = channel.rebitallocMirrorBytes;
  assert.ok(dst instanceof Uint8Array);
  assert.equal(dst.length, 0x8c);
  assert.deepEqual(Array.from(dst.slice(0, 0x14)), Array.from(src.slice(0, 0x14)));
  assert.ok(Array.from(dst.slice(0x14)).every((value) => value === 0));
});

test("computeSpcLevelSlotsAt5 clears disabled channels", () => {
  const channel = {
    spclevIndex: Uint32Array.from([1, 2, 3, 4]),
    idsf: { values: new Uint32Array(1) },
  };

  computeSpcLevelSlotsAt5([{}], [channel], {}, { idsfCount: 1, mapCount: 1 }, 1, 0, [0]);

  assert.deepEqual(Array.from(channel.spclevIndex), [0x0f, 0x0f, 0x0f, 0x0f]);
});

test("computeSpcLevelSlotsAt5 seeds the active slot window before IDSF-driven analysis", () => {
  const channel = {
    spclevIndex: new Uint32Array(8),
    idwl: { values: new Uint32Array(32) },
  };

  computeSpcLevelSlotsAt5([{}], [channel], {}, { idsfCount: 26, mapCount: 4 }, 1, 0, [1]);

  assert.deepEqual(Array.from(channel.spclevIndex), [0x0f, 6, 6, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f]);
});

test("computeSpcLevelSlotsAt5 finalizes missing-source bands back to disabled slots", () => {
  const fixture = createSpcLevelFixture();
  const [channel] = fixture.channels;

  channel.idwl.values[8] = 5;
  channel.idsf.values[8] = 20;
  channel.scratchSpectra = null;
  fixture.blocks[0].bandLevels[8] = 1;

  computeSpcLevelSlotsAt5(fixture.blocks, fixture.channels, fixture.hdr, fixture.shared, 1, 0, [1]);

  assert.deepEqual(
    Array.from(channel.spclevIndex),
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f]
  );
});

test("computeSpcLevelSlotsAt5 ignores active bands with zero SPC slot weight", () => {
  const fixture = createSpcLevelFixture();
  const [channel] = fixture.channels;

  channel.idwl.values[8] = 5;
  channel.idsf.values[8] = 0;
  channel.curBuf.records[1] = { entries: 1, levels: Uint8Array.of(0) };
  fixture.blocks[0].bandLevels[8] = 1;
  setBandScratch(channel, 8, 1);

  computeSpcLevelSlotsAt5(fixture.blocks, fixture.channels, fixture.hdr, fixture.shared, 1, 0, [1]);

  assert.deepEqual(
    Array.from(channel.spclevIndex),
    [0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f]
  );
});

test("computeSpcLevelSlotsAt5 assigns slot levels for active quantized bands", () => {
  const fixture = createSpcLevelFixture();
  const [channel] = fixture.channels;

  channel.idwl.values[8] = 5;
  channel.idsf.values[8] = 20;
  channel.curBuf.records[1] = { entries: 1, levels: Uint8Array.of(0) };
  fixture.blocks[0].bandLevels[8] = 1;
  setBandScratch(channel, 8, 1);

  computeSpcLevelSlotsAt5(fixture.blocks, fixture.channels, fixture.hdr, fixture.shared, 1, 0, [1]);

  assert.deepEqual(Array.from(channel.spclevIndex), [0x0f, 4, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f]);
});

test("computeSpcLevelSlotsAt5 reuses channel 0 energy for masked stereo bands", () => {
  const masked = createSpcLevelFixture({
    channelCount: 2,
    mode3BandMask: Uint32Array.from({ length: 32 }, (_, band) => (band === 8 ? 1 : 0)),
  });
  const unmasked = createSpcLevelFixture({ channelCount: 2 });

  for (const fixture of [masked, unmasked]) {
    const [left, right] = fixture.channels;
    left.idwl.values[8] = 5;
    left.idsf.values[8] = 20;
    right.idsf.values[8] = 20;
    left.curBuf.records[1] = { entries: 1, levels: Uint8Array.of(0) };
    fixture.blocks[0].bandLevels[8] = 1;
    setBandScratch(left, 8, 1);
  }

  computeSpcLevelSlotsAt5(
    unmasked.blocks,
    unmasked.channels,
    unmasked.hdr,
    unmasked.shared,
    2,
    0,
    [1, 1]
  );
  computeSpcLevelSlotsAt5(masked.blocks, masked.channels, masked.hdr, masked.shared, 2, 0, [1, 1]);

  assert.equal(unmasked.channels[1].spclevIndex[1], 0x0f);
  assert.equal(masked.channels[0].spclevIndex[1], 4);
  assert.equal(masked.channels[1].spclevIndex[1], 4);
});

test("pwcQuAt5 reads stereo swap flags directly from shared presence tables", () => {
  const band = 8;
  const x = AT5_X[band + 1] | 0;
  const slot = AT5_IDSPCBANDS[x] | 0;
  const shared = {
    channels: 2,
    stereoSwapPresence: { flags: new Uint32Array(16) },
  };
  const channels = [
    {
      shared,
      spclevIndex: Uint32Array.of(15, 15, 15, 15, 15, 15, 15, 15),
      curBuf: { records: [] },
      prevBuf: { records: [] },
    },
    {
      shared,
      spclevIndex: Uint32Array.of(15, 15, 15, 15, 15, 15, 15, 15),
      curBuf: { records: [] },
      prevBuf: { records: [] },
    },
  ];
  channels[1].spclevIndex[slot] = 0;

  const withoutSwap = new Float32Array(AT5_NSPS[band]);
  pwcQuAt5(channels, 0, 0, band, 1, withoutSwap, new Float32Array(AT5_NSPS[band]), { value: -1 });
  assert.ok(withoutSwap.every((value) => value === 0));

  shared.stereoSwapPresence.flags[x] = 1;
  const withSwap = new Float32Array(AT5_NSPS[band]);
  pwcQuAt5(channels, 0, 0, band, 1, withSwap, new Float32Array(AT5_NSPS[band]), { value: -1 });
  assert.ok(withSwap.some((value) => value !== 0));
});

test("adjustScalefactorsAt5 recomputes IDSF bit totals for flat mode", () => {
  const hdr = {
    bitsIdsf: 8,
    bitsTotal: 150,
    bitsTotalBase: 100,
    idsfModeWord: 0,
    mode3BandMask: new Uint32Array(1),
  };
  const channel = {
    shared: { idsfCount: 3, mapCount: 0 },
    idsf: { values: Uint32Array.from([1, 2, 3]), modeSelect: 7 },
    idwl: { values: new Uint32Array(1) },
    scratchSpectra: new Float32Array(128),
  };

  adjustScalefactorsAt5([{ bitallocHeader: hdr }], [new Float32Array(128)], [channel], 1, 1, 0);

  assert.equal(channel.idsfModeSelect, 0);
  assert.equal(channel.idsf.modeSelect, 0);
  assert.equal(hdr.bitsIdsf, 20);
  assert.equal(hdr.bitsTotalBase, 112);
  assert.equal(hdr.bitsTotal, 162);
});

test("adjustScalefactorsAt5 clears IDSF totals when channel 0 exposes no active IDSF bands", () => {
  const hdr = {
    bitsIdsf: 8,
    bitsTotal: 150,
    bitsTotalBase: 100,
    idsfModeWord: 1,
    mode3BandMask: new Uint32Array(1),
  };
  const channel = {
    shared: { idsfCount: 0, mapCount: 0 },
    idsf: { values: new Uint32Array(1), modeSelect: 7 },
    idwl: { values: new Uint32Array(1) },
    scratchSpectra: new Float32Array(128),
  };

  adjustScalefactorsAt5([{ bitallocHeader: hdr }], [new Float32Array(128)], [channel], 1, 1, 0);

  assert.equal(hdr.bitsIdsf, 0);
  assert.equal(hdr.bitsTotalBase, 92);
  assert.equal(hdr.bitsTotal, 142);
});

test("adjustScalefactorsAt5 raises band 18 scalefactor toward stronger reference energy", () => {
  const { hdr, channel, band } = runScalefactorAdjustmentCase({
    scratchValue: 5,
    refValue: 20,
  });

  assert.equal(channel.idsf.values[band], 25);
  assert.equal(hdr.bitsIdsf, 27);
  assert.equal(hdr.bitsTotalBase, 27);
  assert.equal(hdr.bitsTotal, 34);
});

test("adjustScalefactorsAt5 lowers band 18 scalefactor toward weaker reference energy", () => {
  const { hdr, channel, band } = runScalefactorAdjustmentCase({
    scratchValue: 40,
    refValue: 5,
  });

  assert.equal(channel.idsf.values[band], 12);
  assert.equal(hdr.bitsIdsf, 27);
  assert.equal(hdr.bitsTotalBase, 27);
  assert.equal(hdr.bitsTotal, 34);
});

test("adjustScalefactorsAt5 preserves separate overshoot and ratio back-offs", () => {
  const { hdr, channel, band } = runScalefactorAdjustmentCase({
    scratchValue: 1,
    refValue: 1,
    bandLevel: 4,
  });

  assert.equal(channel.idsf.values[band], 20);
  assert.equal(hdr.bitsIdsf, 27);
  assert.equal(hdr.bitsTotalBase, 27);
  assert.equal(hdr.bitsTotal, 34);
});

test("adjustScalefactorsAt5 reuses channel 0 scratch for masked stereo bands", () => {
  const band = 18;
  const isps = AT5_ISPS[band];
  const nsps = AT5_NSPS[band];

  function createStereoCase(masked) {
    const shared = { idsfCount: 26, mapCount: 4, channels: 2 };
    const hdr = {
      bitsIdsf: 8,
      bitsTotal: 15,
      bitsTotalBase: 8,
      idsfModeWord: 1,
      mode3BandMask: Uint32Array.from({ length: 26 }, (_, index) =>
        masked && index === band ? 1 : 0
      ),
    };
    const channels = Array.from({ length: 2 }, () => ({
      shared,
      idsf: { values: new Uint32Array(26), modeSelect: 1 },
      idwl: { values: new Uint32Array(26) },
      spclevIndex: new Uint32Array(8),
      scratchSpectra: new Float32Array(isps + nsps + 32),
      curBuf: { records: [] },
      prevBuf: { records: [] },
    }));
    const blocks = [
      {
        bitallocHeader: hdr,
        bandLevels: Uint32Array.from({ length: 26 }, (_, index) => (index === band ? 1 : 0)),
      },
      { bandLevels: new Uint32Array(26) },
    ];
    const references = [new Float32Array(isps + nsps + 32), new Float32Array(isps + nsps + 32)];

    channels[0].idwl.values[band] = 1;
    channels[0].idsf.values[band] = 20;
    channels[1].idsf.values[band] = 20;
    channels[0].scratchSpectra.fill(5, isps, isps + nsps);
    references[1].fill(20, isps, isps + nsps);

    adjustScalefactorsAt5(blocks, references, channels, 2, 26, 0x18);

    return channels[1].idsf.values[band];
  }

  assert.equal(createStereoCase(false), 20);
  assert.equal(createStereoCase(true), 25);
});

test("adjustScalefactorsAt5 skips masked stereo retunes when the shared source scratch is missing", () => {
  const band = 18;
  const isps = AT5_ISPS[band];
  const nsps = AT5_NSPS[band];
  const shared = { idsfCount: 26, mapCount: 4, channels: 2 };
  const hdr = {
    bitsIdsf: 8,
    bitsTotal: 15,
    bitsTotalBase: 8,
    idsfModeWord: 1,
    mode3BandMask: Uint32Array.from({ length: 26 }, (_, index) => (index === band ? 1 : 0)),
  };
  const blocks = [
    {
      bitallocHeader: hdr,
      bandLevels: Uint32Array.from({ length: 26 }, (_, index) => (index === band ? 1 : 0)),
    },
    { bandLevels: new Uint32Array(26) },
  ];
  const references = [new Float32Array(isps + nsps + 32), new Float32Array(isps + nsps + 32)];
  references[1].fill(20, isps, isps + nsps);

  function createChannels(includeSharedScratch) {
    return Array.from({ length: 2 }, () => ({
      shared,
      idsf: { values: new Uint32Array(26), modeSelect: 1 },
      idwl: { values: new Uint32Array(26) },
      spclevIndex: new Uint32Array(8),
      curBuf: { records: [] },
      prevBuf: { records: [] },
      ...(includeSharedScratch ? { scratchSpectra: new Float32Array(isps + nsps + 32) } : {}),
    }));
  }

  const warmedChannels = createChannels(true);
  warmedChannels[0].idwl.values[band] = 1;
  warmedChannels[0].idsf.values[band] = 20;
  warmedChannels[1].idsf.values[band] = 20;
  warmedChannels[0].scratchSpectra.fill(5, isps, isps + nsps);

  adjustScalefactorsAt5(blocks, references, warmedChannels, 2, 26, 0x18);
  assert.equal(warmedChannels[1].idsf.values[band], 25);

  const missingScratchChannels = createChannels(false);
  missingScratchChannels[0].idwl.values[band] = 1;
  missingScratchChannels[0].idsf.values[band] = 20;
  missingScratchChannels[1].idsf.values[band] = 20;

  adjustScalefactorsAt5(blocks, references, missingScratchChannels, 2, 26, 0x18);
  assert.equal(missingScratchChannels[0].idsf.values[band], 20);
  assert.equal(missingScratchChannels[1].idsf.values[band], 20);
});

test("adjustScalefactorsAt5 preserves the high-level ratio guard on overpowered bands", () => {
  const lowBandLevel = runScalefactorAdjustmentCase({
    scratchValue: 5,
    refValue: 2,
    bandLevel: 2,
    shift: 3,
  });
  const highBandLevel = runScalefactorAdjustmentCase({
    scratchValue: 5,
    refValue: 2,
    bandLevel: 4,
    shift: 3,
  });

  assert.equal(lowBandLevel.channel.idsf.values[lowBandLevel.band], 21);
  assert.equal(highBandLevel.channel.idsf.values[highBandLevel.band], 20);
});
