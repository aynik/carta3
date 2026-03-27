import assert from "node:assert/strict";
import test from "node:test";

import {
  atxChannelCountForMode,
  atxChannelMaskForChannelCount,
  atxModeForChannelCount,
  findAtracEncodeProfile,
  listAtracEncodeProfiles,
  selectAtracEncodeProfile,
} from "../../src/encoders/profiles.js";
import {
  ATRAC3_DELAY_SAMPLES,
  ATRAC3PLUS_DELAY_SAMPLES,
  atracEncoderDelaySamples,
  computeAtracEncodeFactParam,
  resolveAtracEncodeFactPlan,
} from "../../src/encoders/fact.js";

function profileKey(profile) {
  return `${profile.codec}:${profile.sampleRate}:${profile.channels}:${profile.bitrateKbps}`;
}

function compareProfiles(a, b) {
  return (
    a.codec.localeCompare(b.codec) ||
    a.sampleRate - b.sampleRate ||
    a.channels - b.channels ||
    a.bitrateKbps - b.bitrateKbps
  );
}

function pickEncodeProfileFields(profile) {
  const picked = {
    codec: profile.codec,
    codecKind: profile.codecKind,
    bitrateKbps: profile.bitrateKbps,
    channels: profile.channels,
    sampleRate: profile.sampleRate,
    frameSamples: profile.frameSamples,
    frameBytes: profile.frameBytes,
    codecInfo: profile.codecInfo,
    encodeAlgorithm: profile.encodeAlgorithm,
    encodeVariant: profile.encodeVariant,
    mode: profile.mode,
    encoderDelaySamples: profile.encoderDelaySamples,
    factBaseDelaySamples: profile.factBaseDelaySamples,
    factValueDelaySamples: profile.factValueDelaySamples,
  };

  if (profile.atrac3Flag !== undefined) {
    picked.atrac3Flag = profile.atrac3Flag;
  }
  if (profile.channelMask !== undefined) {
    picked.channelMask = profile.channelMask;
  }
  if (profile.atracxCodecBytes !== undefined) {
    picked.atracxCodecBytes = profile.atracxCodecBytes;
  }

  return picked;
}

test("profile lookup helpers return the expected ATRAC3plus channel metadata", () => {
  assert.equal(atxModeForChannelCount(1), 1);
  assert.equal(atxModeForChannelCount(2), 2);
  assert.equal(atxModeForChannelCount(6), 5);
  assert.equal(atxModeForChannelCount(8), 7);
  assert.equal(atxModeForChannelCount(3), null);

  assert.equal(atxChannelCountForMode(1), 1);
  assert.equal(atxChannelCountForMode(2), 2);
  assert.equal(atxChannelCountForMode(5), 6);
  assert.equal(atxChannelCountForMode(7), 8);
  assert.equal(atxChannelCountForMode(4), null);

  assert.equal(atxChannelMaskForChannelCount(1), 0x4);
  assert.equal(atxChannelMaskForChannelCount(2), 0x3);
  assert.equal(atxChannelMaskForChannelCount(6), 0x3f);
  assert.equal(atxChannelMaskForChannelCount(8), 0x63f);
  assert.equal(atxChannelMaskForChannelCount(4), null);
});

test("shared ATRAC encode profile catalog resolves known ATRAC3 and ATRAC3plus entries", () => {
  assert.deepEqual(pickEncodeProfileFields(findAtracEncodeProfile(66, 2, 44100)), {
    codec: "atrac3",
    codecKind: 3,
    bitrateKbps: 66,
    channels: 2,
    sampleRate: 44100,
    frameSamples: 1024,
    frameBytes: 192,
    codecInfo: 139288,
    encodeAlgorithm: 0,
    encodeVariant: "atrac3-algorithm0",
    mode: 2,
    atrac3Flag: 1,
    encoderDelaySamples: ATRAC3_DELAY_SAMPLES,
    factBaseDelaySamples: 0,
    factValueDelaySamples: 0,
  });

  assert.deepEqual(pickEncodeProfileFields(findAtracEncodeProfile(96, 2, 44100)), {
    codec: "atrac3plus",
    codecKind: 5,
    bitrateKbps: 96,
    channels: 2,
    sampleRate: 44100,
    frameSamples: 2048,
    frameBytes: 560,
    codecInfo: 16787525,
    encodeAlgorithm: 1,
    encodeVariant: "atrac3plus",
    mode: 2,
    channelMask: 0x3,
    atracxCodecBytes: Uint8Array.of(0x28, 0x45),
    encoderDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factBaseDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factValueDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
  });

  assert.deepEqual(pickEncodeProfileFields(findAtracEncodeProfile(132, 2, 44100)), {
    codec: "atrac3",
    codecKind: 3,
    bitrateKbps: 132,
    channels: 2,
    sampleRate: 44100,
    frameSamples: 1024,
    frameBytes: 384,
    codecInfo: 8240,
    encodeAlgorithm: 1,
    encodeVariant: "atrac3-scx",
    mode: 1,
    atrac3Flag: 0,
    encoderDelaySamples: ATRAC3_DELAY_SAMPLES,
    factBaseDelaySamples: 0,
    factValueDelaySamples: 0,
  });

  assert.deepEqual(pickEncodeProfileFields(findAtracEncodeProfile(192, 6, 44100)), {
    codec: "atrac3plus",
    codecKind: 5,
    bitrateKbps: 192,
    channels: 6,
    sampleRate: 44100,
    frameSamples: 2048,
    frameBytes: 1120,
    codecInfo: 16790667,
    encodeAlgorithm: 1,
    encodeVariant: "atrac3plus",
    mode: 5,
    channelMask: 0x3f,
    atracxCodecBytes: Uint8Array.of(0x34, 0x8b),
    encoderDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factBaseDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factValueDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
  });

  assert.equal(findAtracEncodeProfile(66, 2, 32000), null);
});

test("shared ATRAC encode profile catalog returns caller-owned profile objects", () => {
  const atrac3 = findAtracEncodeProfile(66, 2, 44100);
  const atrac3Again = findAtracEncodeProfile(66, 2, 44100);
  assert.ok(atrac3);
  assert.ok(atrac3Again);
  assert.notEqual(atrac3, atrac3Again);

  atrac3.layers[0].param = 999;
  assert.notEqual(findAtracEncodeProfile(66, 2, 44100).layers[0].param, 999);

  const atx = findAtracEncodeProfile(96, 2, 44100);
  const atxAgain = findAtracEncodeProfile(96, 2, 44100);
  assert.ok(atx);
  assert.ok(atxAgain);
  assert.notEqual(atx, atxAgain);
  assert.ok(atx.atracxCodecBytes instanceof Uint8Array);

  atx.atracxCodecBytes[0] ^= 0xff;
  assert.notEqual(
    findAtracEncodeProfile(96, 2, 44100).atracxCodecBytes[0],
    atx.atracxCodecBytes[0]
  );
});

test("shared ATRAC encode profile catalog rejects channel mismatches", () => {
  assert.equal(findAtracEncodeProfile(66, 1, 44100), null);
  assert.equal(findAtracEncodeProfile(132, 6, 44100), null);
  assert.equal(findAtracEncodeProfile(96, 9, 44100), null);
});

test("shared ATRAC encode profile catalog stays unique and sorted", () => {
  const profiles = listAtracEncodeProfiles();
  const keys = profiles.map(profileKey);
  const transportKeys = profiles.map(
    ({ sampleRate, channels, bitrateKbps }) => `${sampleRate}:${channels}:${bitrateKbps}`
  );

  assert.equal(profiles.length, 44);
  assert.equal(new Set(keys).size, profiles.length);
  assert.equal(new Set(transportKeys).size, profiles.length);
  assert.deepEqual(profiles[0], findAtracEncodeProfile(66, 2, 44100));
  assert.deepEqual(profiles.at(-1), findAtracEncodeProfile(768, 8, 48000));

  for (let index = 1; index < profiles.length; index += 1) {
    assert.ok(compareProfiles(profiles[index - 1], profiles[index]) < 0);
  }
});

test("profile selection validates an explicit requested codec against the resolved route", () => {
  assert.equal(selectAtracEncodeProfile(66, 2, 44100, "atrac3").codec, "atrac3");
  assert.equal(selectAtracEncodeProfile(96, 2, 44100, "atrac3plus").codec, "atrac3plus");
  assert.throws(() => selectAtracEncodeProfile(66, 2, 32000), /unsupported ATRAC encode profile/);
  assert.throws(
    () => selectAtracEncodeProfile(66, 2, 44100, "atrac3plus"),
    /requested codec=atrac3plus does not match selected profile codec=atrac3/
  );
  assert.throws(
    () => selectAtracEncodeProfile(132, 6, 44100, "atrac3plus"),
    /unsupported ATRAC encode profile/
  );
});

test("rounding and encoder delay helpers preserve ATRAC fact math", () => {
  assert.equal(atracEncoderDelaySamples("atrac3"), ATRAC3_DELAY_SAMPLES);
  assert.equal(atracEncoderDelaySamples("atrac3plus"), ATRAC3PLUS_DELAY_SAMPLES);
  assert.equal(atracEncoderDelaySamples({ codec: "atrac3plus" }), ATRAC3PLUS_DELAY_SAMPLES);
  assert.equal(
    atracEncoderDelaySamples({ codec: "atrac3plus", encoderDelaySamples: ATRAC3_DELAY_SAMPLES }),
    ATRAC3_DELAY_SAMPLES
  );
  assert.throws(() => atracEncoderDelaySamples("pcm"), /unsupported ATRAC codec/);

  assert.equal(computeAtracEncodeFactParam(-1, 2048, 184, 184), 2232);
  assert.equal(computeAtracEncodeFactParam(100, 2048, 184, 184), 3811);
});

test("encode fact plan resolves codec-specific delay metadata from the profile catalog", () => {
  assert.deepEqual(resolveAtracEncodeFactPlan(selectAtracEncodeProfile(66, 2, 44100), 20), {
    encoderDelaySamples: ATRAC3_DELAY_SAMPLES,
    factBaseDelaySamples: 0,
    factValueDelaySamples: 0,
    factParam: computeAtracEncodeFactParam(20, 1024, 0, 69),
    alignedSampleCount: computeAtracEncodeFactParam(20, 1024, 0, 69),
  });

  assert.deepEqual(resolveAtracEncodeFactPlan(selectAtracEncodeProfile(96, 2, 44100), 20), {
    encoderDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factBaseDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factValueDelaySamples: ATRAC3PLUS_DELAY_SAMPLES,
    factParam: computeAtracEncodeFactParam(20, 2048, 184, 184),
    alignedSampleCount: computeAtracEncodeFactParam(20, 2048, 184, 184) - ATRAC3PLUS_DELAY_SAMPLES,
  });
});

test("encode fact plan requires delay metadata from the authored encode profile", () => {
  assert.throws(
    () => resolveAtracEncodeFactPlan({ codec: "atrac3" }, 20),
    /missing frameSamples on ATRAC encode profile/
  );
  assert.throws(
    () => resolveAtracEncodeFactPlan({ codec: "atrac3", frameSamples: 1024 }, 20),
    /missing encoderDelaySamples on ATRAC encode profile/
  );
  assert.throws(
    () =>
      resolveAtracEncodeFactPlan(
        {
          codec: "atrac3",
          frameSamples: 1024,
          encoderDelaySamples: ATRAC3_DELAY_SAMPLES,
        },
        20
      ),
    /missing factBaseDelaySamples on ATRAC encode profile/
  );
  assert.throws(
    () =>
      resolveAtracEncodeFactPlan(
        {
          codec: "atrac3",
          frameSamples: 1024,
          encoderDelaySamples: ATRAC3_DELAY_SAMPLES,
          factBaseDelaySamples: 0,
        },
        20
      ),
    /missing factValueDelaySamples on ATRAC encode profile/
  );
});
