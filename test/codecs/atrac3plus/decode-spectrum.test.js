import assert from "node:assert/strict";
import test from "node:test";

import { createAt5RegularBlockState } from "../../../src/atrac3plus/bitstream/block-state.js";
import { reconstructBlockSpectra } from "../../../src/atrac3plus/decode-spectrum.js";
import { createAt5GaincBlock } from "../../../src/atrac3plus/dsp.js";
import { AT5_IFQF, AT5_SFTBL } from "../../../src/atrac3plus/tables/decode.js";
import { AT5_ISPS } from "../../../src/atrac3plus/tables/unpack.js";

const ATX_SUBBAND_BLOCKS = 16;
const ATX_SPECTRUM_SAMPLES = 2048;

function createRuntimeChannel() {
  return {
    prevGainBlocks: Array.from({ length: ATX_SUBBAND_BLOCKS }, () => createAt5GaincBlock()),
    currGainBlocks: Array.from({ length: ATX_SUBBAND_BLOCKS }, () => createAt5GaincBlock()),
  };
}

function createRuntimeBlock(channelCount) {
  return {
    spectra: [new Float32Array(ATX_SPECTRUM_SAMPLES), new Float32Array(ATX_SPECTRUM_SAMPLES)],
    channels: Array.from({ length: channelCount }, () => createRuntimeChannel()),
  };
}

test("reconstructBlockSpectra lets stereo channel 1 inherit uncoded band payloads", () => {
  const regularBlock = createAt5RegularBlockState(2);
  const { shared, channels } = regularBlock;
  const [left, right] = channels;

  shared.idsfCount = 1;
  shared.mapCount = 0;
  shared.mapSegmentCount = 1;

  left.idwl.values[0] = 3;
  right.idwl.values[0] = 0;
  left.idsf.values[0] = 4;
  right.idsf.values[0] = 4;

  const bandStart = AT5_ISPS[0] | 0;
  const bandEnd = AT5_ISPS[1] | 0;
  const copiedBand = Int16Array.from({ length: bandEnd - bandStart }, (_, index) => index + 1);
  left.scratchSpectra.set(copiedBand, bandStart);

  const runtimeBlock = createRuntimeBlock(2);
  const mdctBlockCount = reconstructBlockSpectra({ regularBlock }, runtimeBlock);

  assert.equal(mdctBlockCount, 1);
  assert.deepEqual(
    Array.from(right.scratchSpectra.slice(bandStart, bandStart + 6)),
    Array.from(copiedBand.slice(0, 6))
  );

  const scale = AT5_SFTBL[4] * AT5_IFQF[3];
  assert.deepEqual(
    Array.from(runtimeBlock.spectra[1].slice(bandStart, bandStart + 6)),
    Array.from(Float32Array.from(copiedBand.slice(0, 6), (value) => value * scale))
  );
});
