import assert from "node:assert/strict";
import test from "node:test";

import {
  AT3_CHCONV_INITIAL_OPEN_MIX_CODE,
  AT3_CHCONV_MODE_BALANCED,
} from "../../../src/atrac3/channel-conversion-analysis.js";
import {
  createAtrac3Algorithm0RuntimeState,
  createAtrac3EncoderState,
  isAtrac3Algorithm0EncoderState,
} from "../../../src/atrac3/encode-runtime.js";
import { findAtrac3CodecProfile, findAtrac3EncodeProfile } from "../../../src/atrac3/profiles.js";

function summarizeRuntime(state) {
  return {
    bytesPerLayer: state.bytesPerLayer,
    basePrimaryShift: state.basePrimaryShift,
    primaryShiftTarget: state.primaryShiftTarget,
    secondaryUsesSwappedTailTransport: state.secondaryUsesSwappedTailTransport,
    usesDbaStereoRebalance: state.usesDbaStereoRebalance,
    channelConversionSlotLimit: state.channelConversion.slotLimit,
    layerReferencesPrimaryShift: state.layers.map((layer) => layer.referencesPrimaryShift),
    layerParams: state.layers.map((layer) => layer.param),
    layerShifts: state.layers.map((layer) => layer.shift),
    workSizes: state.layers.map((layer) => layer.workSize),
    sfbLimits: state.layers.map((layer) => layer.sfbLimit),
    procWordsLength: state.procWords.length,
    fftLength: state.scratch.fft.length,
    qmfCurveLength: state.scratch.qmfCurve.length,
  };
}

function summarizeLayer(layer) {
  return {
    referencesPrimaryShift: layer.referencesPrimaryShift,
    sfbLimit: layer.sfbLimit,
    shift: layer.shift,
    workSize: layer.workSize,
    param: layer.param,
    spectrumLength: layer.spectrum.length,
    workspace: {
      transformLength: layer.workspace.transform.length,
      qmfHistoryLength: layer.workspace.qmfHistory.length,
    },
    tones: {
      previousBlock0EntryCount: layer.tones.previousBlock0EntryCount,
      blocks: layer.tones.blocks.map((block) => ({
        startIndexLength: block.startIndex.length,
        gainIndexLength: block.gainIndex.length,
        scratchBitsLength: block.scratchBits.length,
        maxBits: block.maxBits,
        lastMax: block.lastMax,
        entryCount: block.entryCount,
      })),
    },
  };
}

function summarizeEncoderState(handle) {
  return {
    mode: handle.mode,
    bitrateKbps: handle.bitrateKbps,
    frameBytes: handle.frameBytes,
    state: {
      bytesPerLayer: handle.state.bytesPerLayer,
      basePrimaryShift: handle.state.basePrimaryShift,
      primaryShiftTarget: handle.state.primaryShiftTarget,
      secondaryUsesSwappedTailTransport: handle.state.secondaryUsesSwappedTailTransport,
      usesDbaStereoRebalance: handle.state.usesDbaStereoRebalance,
      layerReferencesPrimaryShift: handle.state.layers.map((layer) => layer.referencesPrimaryShift),
      channelConversion: {
        slotLimit: handle.state.channelConversion.slotLimit,
        mixCode: {
          current: handle.state.channelConversion.mixCode.current,
        },
        slots: handle.state.channelConversion.slots.map((slot) => ({
          modeHint: slot.modeHint,
          mode: slot.mode,
          mixLevel: slot.mixLevel,
          magnitudeSums: { ...slot.magnitudeSums },
        })),
      },
      procWordsLength: handle.state.procWords.length,
      scratch: {
        fftLength: handle.state.scratch.fft.length,
        qmfCurveLength: handle.state.scratch.qmfCurve.length,
      },
      layers: handle.state.layers.map(summarizeLayer),
    },
  };
}

test("createAtrac3Algorithm0RuntimeState preserves linked and direct transport layouts", () => {
  const lowBitrateProfile = findAtrac3EncodeProfile(66, 44100);
  const highBitrateProfile = findAtrac3EncodeProfile(105, 44100);

  assert.ok(lowBitrateProfile);
  assert.ok(highBitrateProfile);
  assert.deepEqual(summarizeRuntime(createAtrac3Algorithm0RuntimeState(lowBitrateProfile)), {
    bytesPerLayer: 96,
    basePrimaryShift: 1133,
    primaryShiftTarget: 1477,
    secondaryUsesSwappedTailTransport: true,
    usesDbaStereoRebalance: true,
    channelConversionSlotLimit: 1,
    layerReferencesPrimaryShift: [false, true],
    layerParams: [144, 48],
    layerShifts: [1133, 357],
    workSizes: [12403, 2756],
    sfbLimits: [27, 12],
    procWordsLength: 6613,
    fftLength: 1024,
    qmfCurveLength: 23,
  });
  assert.deepEqual(summarizeRuntime(createAtrac3Algorithm0RuntimeState(highBitrateProfile)), {
    bytesPerLayer: 152,
    basePrimaryShift: 1197,
    primaryShiftTarget: 2373,
    secondaryUsesSwappedTailTransport: false,
    usesDbaStereoRebalance: false,
    channelConversionSlotLimit: -1,
    layerReferencesPrimaryShift: [false, false],
    layerParams: [152, 152],
    layerShifts: [1197, 1197],
    workSizes: [13781, 13781],
    sfbLimits: [28, 28],
    procWordsLength: 6613,
    fftLength: 1024,
    qmfCurveLength: 23,
  });
});

test("createAtrac3Algorithm0RuntimeState allocates one independent layer workspace pair", () => {
  const profile = findAtrac3EncodeProfile(66, 44100);

  assert.ok(profile);
  const state = createAtrac3Algorithm0RuntimeState(profile);

  assert.equal(state.primaryLayer, state.layers[0]);
  assert.equal(state.secondaryLayer, state.layers[1]);
  assert.notEqual(state.primaryLayer, state.secondaryLayer);
  assert.notEqual(state.primaryLayer.workspace, state.secondaryLayer.workspace);
  assert.notEqual(state.primaryLayer.workspace.transform, state.secondaryLayer.workspace.transform);
  assert.notEqual(
    state.primaryLayer.workspace.qmfHistory,
    state.secondaryLayer.workspace.qmfHistory
  );
  assert.notEqual(state.primaryLayer.tones.blocks, state.secondaryLayer.tones.blocks);
  assert.notEqual(state.primaryLayer.tones.blocks[0], state.secondaryLayer.tones.blocks[0]);
});

test("createAtrac3Algorithm0RuntimeState derives transport policy from the secondary profile", () => {
  const lowBitrateProfile = findAtrac3EncodeProfile(66, 44100);
  const mediumBitrateProfile = findAtrac3CodecProfile(2, 94);
  const highBitrateProfile = findAtrac3EncodeProfile(105, 44100);

  assert.ok(lowBitrateProfile);
  assert.ok(mediumBitrateProfile);
  assert.ok(highBitrateProfile);

  assert.deepEqual(
    [lowBitrateProfile, mediumBitrateProfile, highBitrateProfile].map((profile) => {
      const state = createAtrac3Algorithm0RuntimeState(profile);
      return {
        bitrateKbps: profile.bitrateKbps,
        secondaryUsesSwappedTailTransport: state.secondaryUsesSwappedTailTransport,
        channelConversionSlotLimit: state.channelConversion.slotLimit,
        usesDbaStereoRebalance: state.usesDbaStereoRebalance,
      };
    }),
    [
      {
        bitrateKbps: 66,
        secondaryUsesSwappedTailTransport: true,
        channelConversionSlotLimit: 1,
        usesDbaStereoRebalance: true,
      },
      {
        bitrateKbps: 94,
        secondaryUsesSwappedTailTransport: true,
        channelConversionSlotLimit: 2,
        usesDbaStereoRebalance: false,
      },
      {
        bitrateKbps: 105,
        secondaryUsesSwappedTailTransport: false,
        channelConversionSlotLimit: -1,
        usesDbaStereoRebalance: false,
      },
    ]
  );
});

test("createAtrac3EncoderState preserves current algorithm-0 stereo layouts", () => {
  const lowBitrate = summarizeEncoderState(createAtrac3EncoderState(2, 66));
  const highBitrate = summarizeEncoderState(createAtrac3EncoderState(1, 105));

  assert.deepEqual(lowBitrate, {
    mode: 2,
    bitrateKbps: 66,
    frameBytes: 192,
    state: {
      bytesPerLayer: 96,
      basePrimaryShift: 1133,
      primaryShiftTarget: 1477,
      secondaryUsesSwappedTailTransport: true,
      usesDbaStereoRebalance: true,
      layerReferencesPrimaryShift: [false, true],
      channelConversion: {
        slotLimit: 1,
        mixCode: {
          current: AT3_CHCONV_INITIAL_OPEN_MIX_CODE,
        },
        slots: [
          {
            modeHint: 0,
            mode: AT3_CHCONV_MODE_BALANCED,
            mixLevel: 1,
            magnitudeSums: { primary: 0, secondary: 0 },
          },
          {
            modeHint: 0,
            mode: AT3_CHCONV_MODE_BALANCED,
            mixLevel: 1,
            magnitudeSums: { primary: 0, secondary: 0 },
          },
          {
            modeHint: 0,
            mode: AT3_CHCONV_MODE_BALANCED,
            mixLevel: 1,
            magnitudeSums: { primary: 0, secondary: 0 },
          },
          {
            modeHint: 0,
            mode: AT3_CHCONV_MODE_BALANCED,
            mixLevel: 1,
            magnitudeSums: { primary: 0, secondary: 0 },
          },
        ],
      },
      procWordsLength: 6613,
      scratch: {
        fftLength: 1024,
        qmfCurveLength: 23,
      },
      layers: [
        {
          referencesPrimaryShift: false,
          sfbLimit: 27,
          shift: 1133,
          workSize: 12403,
          param: 144,
          spectrumLength: 1024,
          workspace: {
            transformLength: 1536,
            qmfHistoryLength: 138,
          },
          tones: {
            previousBlock0EntryCount: 0,
            blocks: [
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
            ],
          },
        },
        {
          referencesPrimaryShift: true,
          sfbLimit: 12,
          shift: 357,
          workSize: 2756,
          param: 48,
          spectrumLength: 1024,
          workspace: {
            transformLength: 1536,
            qmfHistoryLength: 138,
          },
          tones: {
            previousBlock0EntryCount: 0,
            blocks: [
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
            ],
          },
        },
      ],
    },
  });

  assert.deepEqual(highBitrate, {
    mode: 1,
    bitrateKbps: 105,
    frameBytes: 304,
    state: {
      bytesPerLayer: 152,
      basePrimaryShift: 1197,
      primaryShiftTarget: 2373,
      secondaryUsesSwappedTailTransport: false,
      usesDbaStereoRebalance: false,
      layerReferencesPrimaryShift: [false, false],
      channelConversion: {
        slotLimit: -1,
        mixCode: {
          current: 0,
        },
        slots: [
          { modeHint: 0, mode: 0, mixLevel: 0, magnitudeSums: { primary: 0, secondary: 0 } },
          { modeHint: 0, mode: 0, mixLevel: 0, magnitudeSums: { primary: 0, secondary: 0 } },
          { modeHint: 0, mode: 0, mixLevel: 0, magnitudeSums: { primary: 0, secondary: 0 } },
          { modeHint: 0, mode: 0, mixLevel: 0, magnitudeSums: { primary: 0, secondary: 0 } },
        ],
      },
      procWordsLength: 6613,
      scratch: {
        fftLength: 1024,
        qmfCurveLength: 23,
      },
      layers: [
        {
          referencesPrimaryShift: false,
          sfbLimit: 28,
          shift: 1197,
          workSize: 13781,
          param: 152,
          spectrumLength: 1024,
          workspace: {
            transformLength: 1536,
            qmfHistoryLength: 138,
          },
          tones: {
            previousBlock0EntryCount: 0,
            blocks: [
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
            ],
          },
        },
        {
          referencesPrimaryShift: false,
          sfbLimit: 28,
          shift: 1197,
          workSize: 13781,
          param: 152,
          spectrumLength: 1024,
          workspace: {
            transformLength: 1536,
            qmfHistoryLength: 138,
          },
          tones: {
            previousBlock0EntryCount: 0,
            blocks: [
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
              {
                startIndexLength: 8,
                gainIndexLength: 8,
                scratchBitsLength: 32,
                maxBits: 0,
                lastMax: 0,
                entryCount: 0,
              },
            ],
          },
        },
      ],
    },
  });
});

test("createAtrac3EncoderState accepts a resolved ATRAC3 profile", () => {
  const profile = findAtrac3EncodeProfile(66, 44100);

  assert.ok(profile);
  assert.deepEqual(
    summarizeEncoderState(createAtrac3EncoderState(profile)),
    summarizeEncoderState(createAtrac3EncoderState(2, 66))
  );
});

test("createAtrac3EncoderState keeps raw codec-profile requests distinct from wrapper selection", () => {
  const codecProfile = findAtrac3CodecProfile(1, 132);
  const wrapperProfile = findAtrac3EncodeProfile(132, 44100);

  assert.ok(codecProfile);
  assert.ok(wrapperProfile);
  assert.equal(wrapperProfile.encodeVariant, "atrac3-scx");
  assert.deepEqual(
    summarizeEncoderState(createAtrac3EncoderState(codecProfile)),
    summarizeEncoderState(createAtrac3EncoderState(1, 132))
  );
});

test("createAtrac3EncoderState exposes the authored primary and secondary layer pair", () => {
  const handle = createAtrac3EncoderState(2, 66);

  assert.equal("layerCount" in handle.state, false);
  assert.equal(handle.state.primaryLayer, handle.state.layers[0]);
  assert.equal(handle.state.secondaryLayer, handle.state.layers[1]);
  assert.equal(handle.state.secondaryUsesSwappedTailTransport, true);
  assert.equal(handle.state.usesDbaStereoRebalance, true);
  assert.equal(handle.state.basePrimaryShift, handle.state.primaryLayer.shift);
  assert.equal(handle.state.primaryShiftTarget, 1477);
});

test("createAtrac3EncoderState preserves the supported algorithm-0 profile catalogue", () => {
  const expectedProfiles = [
    {
      mode: 2,
      bitrateKbps: 66,
      frameBytes: 192,
      bytesPerLayer: 96,
      basePrimaryShift: 1133,
      primaryShiftTarget: 1477,
      secondaryUsesSwappedTailTransport: true,
      usesDbaStereoRebalance: true,
      layerReferencesPrimaryShift: [false, true],
      channelConversionSlotLimit: 1,
      layerParams: [144, 48],
      layerShifts: [1133, 357],
      workSizes: [12403, 2756],
      sfbLimits: [27, 12],
    },
    {
      mode: 2,
      bitrateKbps: 94,
      frameBytes: 272,
      bytesPerLayer: 136,
      basePrimaryShift: 1469,
      primaryShiftTarget: 2117,
      secondaryUsesSwappedTailTransport: true,
      usesDbaStereoRebalance: false,
      layerReferencesPrimaryShift: [false, true],
      channelConversionSlotLimit: 2,
      layerParams: [186, 86],
      layerShifts: [1469, 661],
      workSizes: [13781, 7579],
      sfbLimits: [28, 21],
    },
    {
      mode: 1,
      bitrateKbps: 105,
      frameBytes: 304,
      bytesPerLayer: 152,
      basePrimaryShift: 1197,
      primaryShiftTarget: 2373,
      secondaryUsesSwappedTailTransport: false,
      usesDbaStereoRebalance: false,
      layerReferencesPrimaryShift: [false, false],
      channelConversionSlotLimit: -1,
      layerParams: [152, 152],
      layerShifts: [1197, 1197],
      workSizes: [13781, 13781],
      sfbLimits: [28, 28],
    },
    {
      mode: 1,
      bitrateKbps: 132,
      frameBytes: 384,
      bytesPerLayer: 192,
      basePrimaryShift: 1517,
      primaryShiftTarget: 3013,
      secondaryUsesSwappedTailTransport: false,
      usesDbaStereoRebalance: false,
      layerReferencesPrimaryShift: [false, false],
      channelConversionSlotLimit: -1,
      layerParams: [192, 192],
      layerShifts: [1517, 1517],
      workSizes: [16537, 16537],
      sfbLimits: [30, 30],
    },
    {
      mode: 1,
      bitrateKbps: 146,
      frameBytes: 424,
      bytesPerLayer: 212,
      basePrimaryShift: 1677,
      primaryShiftTarget: 3333,
      secondaryUsesSwappedTailTransport: false,
      usesDbaStereoRebalance: false,
      layerReferencesPrimaryShift: [false, false],
      channelConversionSlotLimit: -1,
      layerParams: [212, 212],
      layerShifts: [1677, 1677],
      workSizes: [16537, 16537],
      sfbLimits: [30, 30],
    },
    {
      mode: 1,
      bitrateKbps: 176,
      frameBytes: 512,
      bytesPerLayer: 256,
      basePrimaryShift: 2029,
      primaryShiftTarget: 4037,
      secondaryUsesSwappedTailTransport: false,
      usesDbaStereoRebalance: false,
      layerReferencesPrimaryShift: [false, false],
      channelConversionSlotLimit: -1,
      layerParams: [256, 256],
      layerShifts: [2029, 2029],
      workSizes: [19293, 19293],
      sfbLimits: [31, 31],
    },
  ];

  const actualProfiles = expectedProfiles.map(({ mode, bitrateKbps }) => {
    const handle = createAtrac3EncoderState(mode, bitrateKbps);
    return {
      mode: handle.mode,
      bitrateKbps: handle.bitrateKbps,
      frameBytes: handle.frameBytes,
      bytesPerLayer: handle.state.bytesPerLayer,
      basePrimaryShift: handle.state.basePrimaryShift,
      primaryShiftTarget: handle.state.primaryShiftTarget,
      secondaryUsesSwappedTailTransport: handle.state.secondaryUsesSwappedTailTransport,
      usesDbaStereoRebalance: handle.state.usesDbaStereoRebalance,
      layerReferencesPrimaryShift: handle.state.layers.map((layer) => layer.referencesPrimaryShift),
      channelConversionSlotLimit: handle.state.channelConversion.slotLimit,
      layerParams: handle.state.layers.map((layer) => layer.param),
      layerShifts: handle.state.layers.map((layer) => layer.shift),
      workSizes: handle.state.layers.map((layer) => layer.workSize),
      sfbLimits: handle.state.layers.map((layer) => layer.sfbLimit),
    };
  });

  assert.deepEqual(actualProfiles, expectedProfiles);
});

test("createAtrac3EncoderState preserves linked and direct secondary transport setup", () => {
  const lowBitrate = createAtrac3EncoderState(2, 66);
  const highBitrate = createAtrac3EncoderState(1, 105);

  assert.equal(lowBitrate.state.layers[1].referencesPrimaryShift, true);
  assert.equal(lowBitrate.state.secondaryUsesSwappedTailTransport, true);
  assert.equal(lowBitrate.state.usesDbaStereoRebalance, true);
  assert.equal(lowBitrate.state.basePrimaryShift, 1133);
  assert.equal(lowBitrate.state.primaryShiftTarget, 1477);
  assert.equal(lowBitrate.state.channelConversion.slotLimit, 1);

  assert.equal(highBitrate.state.layers[1].referencesPrimaryShift, false);
  assert.equal(highBitrate.state.secondaryUsesSwappedTailTransport, false);
  assert.equal(highBitrate.state.usesDbaStereoRebalance, false);
  assert.equal(highBitrate.state.basePrimaryShift, 1197);
  assert.equal(highBitrate.state.primaryShiftTarget, 2373);
  assert.equal(highBitrate.state.channelConversion.slotLimit, -1);
});

test("createAtrac3EncoderState preserves current unsupported-profile errors", () => {
  assert.throws(
    () => createAtrac3EncoderState(2, 132),
    /unsupported ATRAC3 encoder mode=2 bitrate=132/
  );
  assert.throws(
    () => createAtrac3EncoderState({ mode: 2, bitrateKbps: 66 }),
    /invalid ATRAC3 encoder profile/
  );
  assert.throws(
    () =>
      createAtrac3EncoderState({
        codec: "atrac3",
        layers: [{}, {}],
      }),
    /invalid ATRAC3 encoder profile/
  );
});

test("isAtrac3Algorithm0EncoderState accepts authored encoder states only", () => {
  const encoderState = createAtrac3EncoderState(2, 66).state;

  assert.equal(isAtrac3Algorithm0EncoderState(encoderState), true);
  assert.equal(
    isAtrac3Algorithm0EncoderState({
      ...encoderState,
      channelConversion: null,
    }),
    false
  );
  const primaryLayer = {};
  const secondaryLayer = {};
  assert.equal(
    isAtrac3Algorithm0EncoderState({
      ...encoderState,
      primaryLayer,
      secondaryLayer,
      layers: [primaryLayer, secondaryLayer],
    }),
    false
  );
  assert.equal(
    isAtrac3Algorithm0EncoderState({
      bytesPerLayer: encoderState.bytesPerLayer,
      primaryLayer: encoderState.primaryLayer,
      secondaryLayer: encoderState.secondaryLayer,
      layers: [encoderState.primaryLayer],
      procWords: encoderState.procWords,
      scratch: encoderState.scratch,
    }),
    false
  );
  assert.equal(
    isAtrac3Algorithm0EncoderState({
      ...encoderState,
      layers: [encoderState.primaryLayer, encoderState.secondaryLayer, encoderState.primaryLayer],
    }),
    false
  );
});
