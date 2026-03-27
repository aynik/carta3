import { copyGainRecordToGaincBlock } from "./dsp.js";
import { sharedHasZeroSpectra, sharedMapSegmentCount } from "./shared-fields.js";
import { AT5_IDSPCBANDS, AT5_ISPS } from "./tables/unpack.js";
import {
  AT5_IFQF,
  AT5_SFTBL,
  AT5_SPCLEV,
  AT5_Y,
  ATX_DECODE_BAND_LIMIT_BY_IDX,
} from "./tables/decode.js";
import {
  addSpcNoiseBand,
  computeSpcBandNoiseScale,
  computeSpcNoiseBaseScale,
  resolveSpcSourceChannelIndex,
} from "./spc.js";
import { applyStereoMapTransforms } from "./stereo-maps.js";

const ATX_SUBBAND_BLOCKS = 16;

/**
 * ATRAC3plus spectral-domain reconstruction before the time-domain synthesis stages.
 */
function buildQuantShifts(channels, channelRuntimes) {
  const scratch = channelRuntimes?.quantShifts ?? null;
  const quantShifts = Array.isArray(scratch) && scratch.length >= channels.length ? scratch : [];

  for (const [channelIndex, channel] of channels.entries()) {
    const channelRuntime = channelRuntimes[channelIndex];
    const records = channel.gain.records;
    const presenceFlags = channel.channelPresence.flags;

    for (let blockIndex = 0; blockIndex < ATX_SUBBAND_BLOCKS; blockIndex += 1) {
      copyGainRecordToGaincBlock(records[blockIndex], channelRuntime.currGainBlocks[blockIndex]);
      channelRuntime.currGainBlocks[blockIndex].windowFlag = presenceFlags[blockIndex] | 0;
    }

    const source = channel.idwl.values;
    let shifts = quantShifts[channelIndex];
    if (!(shifts instanceof Int32Array) || shifts.length !== source.length) {
      shifts = new Int32Array(source.length);
      quantShifts[channelIndex] = shifts;
    }
    shifts.set(source);
  }

  channelRuntimes.quantShifts = quantShifts;
  return quantShifts;
}

function inheritStereoBandPayloads(channels, quantShifts, bandCount) {
  const [left, right] = channels;

  for (let band = 0; band < bandCount; band += 1) {
    if (
      (quantShifts[1][band] | 0) !== 0 ||
      (quantShifts[0][band] | 0) <= 0 ||
      (right.idct.values[band] | 0) !== 0
    ) {
      continue;
    }

    const start = AT5_ISPS[band] | 0;
    const end = AT5_ISPS[band + 1] | 0;
    right.scratchSpectra.set(left.scratchSpectra.subarray(start, end), start);
    quantShifts[1][band] = quantShifts[0][band];
  }
}

function rebuildQuantizedSpectra(spectra, channels, quantShifts, bandCount) {
  let seedSum = 0;

  for (const [channelIndex, channel] of channels.entries()) {
    const idsf = channel.idsf.values;
    const quantizedSpectra = channel.scratchSpectra;
    const outSpectra = spectra[channelIndex];
    outSpectra.fill(0);

    for (let band = 0; band < bandCount; band += 1) {
      seedSum = (seedSum + (idsf[band] | 0)) & 0xffff;

      const shift = quantShifts[channelIndex][band] | 0;
      if (shift <= 0) {
        continue;
      }

      const start = AT5_ISPS[band] | 0;
      const end = AT5_ISPS[band + 1] | 0;
      const scale = AT5_SFTBL[idsf[band] | 0] * AT5_IFQF[shift];
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        outSpectra[sampleIndex] = quantizedSpectra[sampleIndex] * scale;
      }
    }
  }

  return seedSum;
}

function addSpcNoiseToMap(
  spectra,
  channels,
  channelIndex,
  mapIndex,
  seed,
  shared,
  channelRuntimes,
  quantShifts
) {
  const sourceChannelIndex = resolveSpcSourceChannelIndex(
    channels.length,
    shared,
    channelIndex,
    mapIndex
  );
  const sourceChannel = channels[sourceChannelIndex];
  const sourceRuntime = channelRuntimes[sourceChannelIndex];

  const bandId = AT5_IDSPCBANDS[mapIndex] | 0;
  const spclev = AT5_SPCLEV[sourceChannel.spclevIndex[bandId] | 0];
  if (!(spclev > 0)) {
    return;
  }

  const baseScale = computeSpcNoiseBaseScale(
    sourceRuntime.currGainBlocks[mapIndex],
    sourceRuntime.prevGainBlocks[mapIndex],
    spclev
  );
  const targetChannel = channels[channelIndex];
  const targetQuantShifts = quantShifts[channelIndex];

  const startBand = ATX_DECODE_BAND_LIMIT_BY_IDX[mapIndex] | 0;
  const endBand = AT5_Y[mapIndex + 1] | 0;
  for (let band = startBand; band < endBand; band += 1) {
    const shift = targetQuantShifts[band] | 0;
    if (shift <= 0) {
      continue;
    }

    const bandScale = computeSpcBandNoiseScale(
      baseScale,
      targetChannel.idsf.values[band] | 0,
      shift
    );
    addSpcNoiseBand(spectra, AT5_ISPS[band] | 0, AT5_ISPS[band + 1] | 0, bandScale, seed);
  }
}

function applySpcNoiseMaps(
  spectra,
  channels,
  shared,
  channelRuntimes,
  quantShifts,
  mapCount,
  seedSum
) {
  let spcSeed = seedSum & 0x3fc;

  for (let mapIndex = 0; mapIndex < mapCount; mapIndex += 1) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      addSpcNoiseToMap(
        spectra[channelIndex],
        channels,
        channelIndex,
        mapIndex,
        spcSeed,
        shared,
        channelRuntimes,
        quantShifts
      );
    }
    spcSeed = (spcSeed + 0x80) & 0xffff;
  }
}

export function reconstructBlockSpectra(block, blockRuntime) {
  const regular = block.regularBlock;
  const { shared, channels } = regular;
  const channelCount = shared.channels | 0;
  const bandCount = shared.idsfCount | 0;
  const mapCount = shared.mapCount | 0;
  const { channels: channelRuntimes, spectra } = blockRuntime;

  const quantShifts = buildQuantShifts(channels, channelRuntimes);
  if (channelCount === 2) {
    inheritStereoBandPayloads(channels, quantShifts, bandCount);
  }

  const seedSum = rebuildQuantizedSpectra(spectra, channels, quantShifts, bandCount);
  applySpcNoiseMaps(spectra, channels, shared, channelRuntimes, quantShifts, mapCount, seedSum);

  if (channelCount === 2) {
    applyStereoMapTransforms(spectra[0], spectra[1], shared, mapCount);
  }
  if (sharedHasZeroSpectra(shared)) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      spectra[channelIndex].fill(0);
    }
  }

  return sharedMapSegmentCount(shared);
}
