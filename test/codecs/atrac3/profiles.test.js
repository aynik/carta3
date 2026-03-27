import assert from "node:assert/strict";
import test from "node:test";

import {
  ATRAC3_CHANNEL_MODE_MONO,
  ATRAC3_CHANNEL_MODE_STEREO,
  ATRAC3_TRANSPORT_DIRECT,
  ATRAC3_TRANSPORT_SWAPPED_TAIL,
  findAtrac3CodecProfile,
  findAtrac3DecoderLayouts,
  findAtrac3EncodeProfile,
  layerUsesAtrac3SwappedTailTransport,
  listAtrac3EncodeProfiles,
  resolveAtrac3DecoderChannelMode,
  resolveAtrac3DecoderLayout,
  resolveAtrac3LayerTransportMode,
  resolveAtrac3DirectWrapperSetup,
  selectAtrac3Algorithm0EncodeProfile,
  selectAtrac3ScxEncodeProfile,
} from "../../../src/atrac3/profiles.js";
import { findAtracEncodeProfile } from "../../../src/encoders/profiles.js";

test("ATRAC3 profiles preserve exposed encode variants for the public encoder surface", () => {
  assert.equal(findAtrac3EncodeProfile(66, 44100)?.encodeVariant, "atrac3-algorithm0");
  assert.equal(findAtrac3EncodeProfile(132, 44100)?.encodeVariant, "atrac3-scx");
  assert.equal(findAtrac3EncodeProfile(94, 44100), null);
  assert.equal(findAtrac3EncodeProfile(66, 48000), null);
});

test("ATRAC3 profiles preserve representative authored transport metadata", () => {
  assert.deepEqual(findAtrac3CodecProfile(2, 66), {
    codec: "atrac3",
    codecKind: 3,
    channels: 2,
    sampleRate: 44100,
    frameSamples: 1024,
    bitrateKbps: 66,
    frameBytes: 192,
    mode: 2,
    encodeAlgorithm: 0,
    encodeVariant: "atrac3-algorithm0",
    layers: [
      { param: 144, sfbLimit: 27, transportMode: ATRAC3_TRANSPORT_DIRECT },
      {
        param: 48,
        sfbLimit: 12,
        transportMode: ATRAC3_TRANSPORT_SWAPPED_TAIL,
        channelConversionSlotLimit: 1,
      },
    ],
    codecInfo: 139288,
    atrac3Flag: 1,
    encoderDelaySamples: 69,
    factBaseDelaySamples: 0,
    factValueDelaySamples: 0,
  });

  assert.deepEqual(findAtrac3CodecProfile(1, 132), {
    codec: "atrac3",
    codecKind: 3,
    channels: 2,
    sampleRate: 44100,
    frameSamples: 1024,
    bitrateKbps: 132,
    frameBytes: 384,
    mode: 1,
    encodeAlgorithm: 1,
    encodeVariant: "atrac3-scx",
    layers: [
      { param: 192, sfbLimit: 30, transportMode: ATRAC3_TRANSPORT_DIRECT },
      { param: 192, sfbLimit: 30, transportMode: ATRAC3_TRANSPORT_DIRECT },
    ],
    codecInfo: 8240,
    atrac3Flag: 0,
    encoderDelaySamples: 69,
    factBaseDelaySamples: 0,
    factValueDelaySamples: 0,
  });
});

test("ATRAC3 profile helpers own the public direct-encode restrictions", () => {
  const algo0Profile = findAtrac3EncodeProfile(66, 44100);
  const highBitrateAlgo0Profile = findAtrac3EncodeProfile(105, 44100);
  const scxProfile = findAtrac3EncodeProfile(132, 44100);

  assert.equal(selectAtrac3Algorithm0EncodeProfile(66, 2, 44100), algo0Profile);
  assert.equal(selectAtrac3Algorithm0EncodeProfile(66, 2, 44100, algo0Profile), algo0Profile);
  assert.equal(
    selectAtrac3Algorithm0EncodeProfile(105, 2, 44100, highBitrateAlgo0Profile),
    highBitrateAlgo0Profile
  );
  assert.equal(selectAtrac3ScxEncodeProfile(132, 2, 44100), scxProfile);
  assert.equal(selectAtrac3ScxEncodeProfile(132, 2, 44100, scxProfile), scxProfile);

  assert.throws(
    () => selectAtrac3Algorithm0EncodeProfile(132, 2, 44100, scxProfile),
    /ATRAC3 encoder \(algorithm 0\) currently supports only 66, 105 kbps 2ch @ 44100Hz/
  );
  assert.throws(
    () => selectAtrac3ScxEncodeProfile(66, 2, 44100, algo0Profile),
    /ATRAC3 SCX encoder currently supports only 132 kbps 2ch @ 44100Hz/
  );
});

test("ATRAC3 direct-wrapper selectors keep the fixed stereo 44.1 kHz request boundary", () => {
  const algo0Profile = findAtrac3EncodeProfile(66, 44100);
  const scxProfile = findAtrac3EncodeProfile(132, 44100);

  assert.ok(algo0Profile);
  assert.ok(scxProfile);

  assert.throws(
    () => selectAtrac3Algorithm0EncodeProfile(66, 1, 44100, algo0Profile),
    /ATRAC3 encoder \(algorithm 0\) currently supports only 66, 105 kbps 2ch @ 44100Hz/
  );
  assert.throws(
    () => selectAtrac3ScxEncodeProfile(132, 2, 48000, scxProfile),
    /ATRAC3 SCX encoder currently supports only 132 kbps 2ch @ 44100Hz/
  );
});

test("ATRAC3 direct-wrapper setup keeps shared catalog fallback separate from wrapper acceptance", () => {
  const algo0Profile = findAtrac3EncodeProfile(66, 44100);
  const scxProfile = findAtrac3EncodeProfile(132, 44100);

  assert.ok(algo0Profile);
  assert.ok(scxProfile);

  assert.deepEqual(resolveAtrac3DirectWrapperSetup(66, 2, 44100, algo0Profile), {
    resolvedProfile: algo0Profile,
    wrapperProfile: algo0Profile,
  });
  assert.deepEqual(resolveAtrac3DirectWrapperSetup(66, 1, 44100), {
    resolvedProfile: algo0Profile,
    wrapperProfile: null,
  });
  assert.deepEqual(resolveAtrac3DirectWrapperSetup(132, 2, 48000, scxProfile), {
    resolvedProfile: scxProfile,
    wrapperProfile: null,
  });
});

test("ATRAC3 direct-wrapper setup rejects preselected profiles from other codecs", () => {
  const atrac3plusProfile = findAtracEncodeProfile(96, 2, 44100);

  assert.ok(atrac3plusProfile);
  assert.deepEqual(resolveAtrac3DirectWrapperSetup(96, 2, 44100, atrac3plusProfile), {
    resolvedProfile: atrac3plusProfile,
    wrapperProfile: null,
  });
});

test("ATRAC3 profiles keep decoder entries broader than the public encoder surface", () => {
  assert.equal(findAtrac3EncodeProfile(66, 44100)?.encodeVariant, "atrac3-algorithm0");
  assert.equal(findAtrac3EncodeProfile(132, 44100)?.encodeVariant, "atrac3-scx");
  assert.equal(findAtrac3CodecProfile(1, 33), null);
  assert.equal(findAtrac3DecoderLayouts(33, 96)?.stereo.modeIndex, 0);
  assert.equal(findAtrac3CodecProfile(2, 94)?.encodeVariant, null);
  assert.equal(findAtrac3EncodeProfile(94, 44100), null);
  assert.equal(findAtrac3EncodeProfile(66, 48000), null);
  assert.deepEqual(
    listAtrac3EncodeProfiles().map(({ bitrateKbps, mode, encodeVariant }) => ({
      bitrateKbps,
      mode,
      encodeVariant,
    })),
    [
      { bitrateKbps: 66, mode: 2, encodeVariant: "atrac3-algorithm0" },
      { bitrateKbps: 105, mode: 1, encodeVariant: "atrac3-algorithm0" },
      { bitrateKbps: 132, mode: 1, encodeVariant: "atrac3-scx" },
    ]
  );
});

test("ATRAC3 profiles preserve bitrate-first and frame-size-fallback decoder layout lookup", () => {
  assert.deepEqual(findAtrac3DecoderLayouts(66, 384), {
    bitrateKbps: 66,
    frameBytes: 192,
    mono: {
      modeIndex: 10,
      bitrateKbps: 66,
      frameBytes: 192,
      streamChannels: 1,
      primaryTransportMode: "direct",
      secondaryTransportMode: "direct",
      stepBytes: 96,
    },
    stereo: {
      modeIndex: 2,
      bitrateKbps: 66,
      frameBytes: 192,
      streamChannels: 2,
      primaryTransportMode: "direct",
      secondaryTransportMode: "swapped-tail",
      stepBytes: 192,
    },
  });

  assert.deepEqual(findAtrac3DecoderLayouts(999, 192), {
    bitrateKbps: 66,
    frameBytes: 192,
    mono: {
      modeIndex: 10,
      bitrateKbps: 66,
      frameBytes: 192,
      streamChannels: 1,
      primaryTransportMode: "direct",
      secondaryTransportMode: "direct",
      stepBytes: 96,
    },
    stereo: {
      modeIndex: 2,
      bitrateKbps: 66,
      frameBytes: 192,
      streamChannels: 2,
      primaryTransportMode: "direct",
      secondaryTransportMode: "swapped-tail",
      stepBytes: 192,
    },
  });
  assert.equal(findAtrac3DecoderLayouts(999, 999), null);
});

test("ATRAC3 profiles preserve decoder layout resolution and channel-mode precedence", () => {
  assert.deepEqual(resolveAtrac3DecoderLayout({ bitrateKbps: 66, frameBytes: 384 }), {
    modeIndex: 2,
    bitrateKbps: 66,
    frameBytes: 192,
    streamChannels: 2,
    primaryTransportMode: "direct",
    secondaryTransportMode: "swapped-tail",
    stepBytes: 192,
  });

  assert.deepEqual(
    resolveAtrac3DecoderLayout({ atrac3Flag: 0, bitrateKbps: 999, frameBytes: 192 }),
    {
      modeIndex: 10,
      bitrateKbps: 66,
      frameBytes: 192,
      streamChannels: 1,
      primaryTransportMode: "direct",
      secondaryTransportMode: "direct",
      stepBytes: 96,
    }
  );

  assert.equal(
    resolveAtrac3DecoderChannelMode({
      atrac3Flag: 0,
      channels: 2,
      bitrateKbps: 66,
      frameBytes: 192,
    }),
    ATRAC3_CHANNEL_MODE_MONO
  );
  assert.equal(
    resolveAtrac3DecoderChannelMode({
      channels: 2,
      bitrateKbps: 94,
      frameBytes: 272,
    }),
    ATRAC3_CHANNEL_MODE_STEREO
  );
  assert.equal(
    resolveAtrac3DecoderChannelMode({
      channels: 9,
      bitrateKbps: 66,
      frameBytes: 512,
    }),
    ATRAC3_CHANNEL_MODE_STEREO
  );
  assert.equal(
    resolveAtrac3DecoderChannelMode({
      channels: 9,
      bitrateKbps: 94,
      frameBytes: 272,
    }),
    ATRAC3_CHANNEL_MODE_MONO
  );
});

test("ATRAC3 profiles keep channel-mode and layout resolution as adjacent direct steps", () => {
  const bitrateFirstConfig = { bitrateKbps: 66, frameBytes: 384 };
  assert.equal(resolveAtrac3DecoderChannelMode(bitrateFirstConfig), ATRAC3_CHANNEL_MODE_STEREO);
  assert.deepEqual(resolveAtrac3DecoderLayout(bitrateFirstConfig), {
    modeIndex: 2,
    bitrateKbps: 66,
    frameBytes: 192,
    streamChannels: 2,
    primaryTransportMode: "direct",
    secondaryTransportMode: "swapped-tail",
    stepBytes: 192,
  });

  const monoFallbackConfig = { atrac3Flag: 0, bitrateKbps: 999, frameBytes: 192 };
  assert.equal(resolveAtrac3DecoderChannelMode(monoFallbackConfig), ATRAC3_CHANNEL_MODE_MONO);
  assert.deepEqual(resolveAtrac3DecoderLayout(monoFallbackConfig), {
    modeIndex: 10,
    bitrateKbps: 66,
    frameBytes: 192,
    streamChannels: 1,
    primaryTransportMode: "direct",
    secondaryTransportMode: "direct",
    stepBytes: 96,
  });

  const unsupportedConfig = { bitrateKbps: 999, frameBytes: 999 };
  assert.equal(resolveAtrac3DecoderChannelMode(unsupportedConfig), ATRAC3_CHANNEL_MODE_MONO);
  assert.equal(resolveAtrac3DecoderLayout(unsupportedConfig), null);
});

test("ATRAC3 profiles keep decoder stereo reopening distinct from encode-layer transport", () => {
  for (const [bitrateKbps, frameBytes] of [
    [105, 304],
    [132, 384],
    [146, 424],
    [176, 512],
  ]) {
    const codecProfile = findAtrac3CodecProfile(1, bitrateKbps);
    const decoderLayout = findAtrac3DecoderLayouts(bitrateKbps, frameBytes)?.stereo;

    assert.deepEqual(
      codecProfile?.layers.map(({ transportMode }) => transportMode),
      [ATRAC3_TRANSPORT_DIRECT, ATRAC3_TRANSPORT_DIRECT]
    );
    assert.equal(decoderLayout?.primaryTransportMode, ATRAC3_TRANSPORT_DIRECT);
    assert.equal(decoderLayout?.secondaryTransportMode, ATRAC3_TRANSPORT_SWAPPED_TAIL);
    assert.equal(
      resolveAtrac3DecoderLayout({ atrac3Flag: 1, bitrateKbps, frameBytes })
        ?.secondaryTransportMode,
      ATRAC3_TRANSPORT_SWAPPED_TAIL
    );
  }
});

test("ATRAC3 profile helpers preserve shared layer transport resolution", () => {
  assert.equal(
    resolveAtrac3LayerTransportMode({ transportMode: ATRAC3_TRANSPORT_DIRECT }),
    ATRAC3_TRANSPORT_DIRECT
  );
  assert.equal(
    resolveAtrac3LayerTransportMode({ referencesPrimaryShift: true }),
    ATRAC3_TRANSPORT_SWAPPED_TAIL
  );
  assert.equal(layerUsesAtrac3SwappedTailTransport({ referencesPrimaryShift: true }), true);
  assert.equal(
    layerUsesAtrac3SwappedTailTransport({ transportMode: ATRAC3_TRANSPORT_DIRECT }),
    false
  );
  assert.throws(
    () => resolveAtrac3LayerTransportMode({ transportMode: "mystery" }),
    /invalid ATRAC3 layer transportMode/
  );
});
