import assert from "node:assert/strict";
import test from "node:test";

import {
  findAtrac3plusEncodeProfile,
  selectAtrac3plusEncodeProfile,
} from "../../../src/atrac3plus/profiles.js";

test("ATRAC3plus profile helpers select authored rows and reject mismatches", () => {
  const stereo96 = findAtrac3plusEncodeProfile(96, 2, 44100);

  assert.equal(selectAtrac3plusEncodeProfile(96, 2, 44100), stereo96);
  assert.equal(selectAtrac3plusEncodeProfile(96, 2, 44100, stereo96), stereo96);

  assert.throws(
    () => selectAtrac3plusEncodeProfile(132, 2, 44100),
    /ATRAC3plus profile mismatch: bitrate=132 channels=2 sampleRate=44100/
  );
  assert.throws(
    () => selectAtrac3plusEncodeProfile(96, 1, 44100, stereo96),
    /ATRAC3plus profile mismatch: bitrate=96 channels=1 sampleRate=44100/
  );
});
