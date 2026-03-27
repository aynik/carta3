import { AT5_Y } from "./tables/decode.js";
import { AT5_ISPS } from "./tables/unpack.js";

const ATX_STEREO_MAP_SAMPLES = 128;

export function isStereoMapSwapped(shared, mapIndex) {
  return (shared?.stereoSwapPresence?.flags?.[mapIndex] | 0) !== 0;
}

function isStereoMapFlipped(shared, mapIndex) {
  return (shared?.stereoFlipPresence?.flags?.[mapIndex] | 0) !== 0;
}

export function resolveStereoMapSourceChannelIndex(channelCount, shared, channelIndex, mapIndex) {
  if ((channelCount | 0) !== 2 || !isStereoMapSwapped(shared, mapIndex)) {
    return channelIndex | 0;
  }

  return 1 - (channelIndex | 0);
}

function swapStereoMapSamples(leftSpectra, rightSpectra, mapIndex) {
  const mapOffset = (mapIndex | 0) * ATX_STEREO_MAP_SAMPLES;
  for (let sampleOffset = 0; sampleOffset < ATX_STEREO_MAP_SAMPLES; sampleOffset += 1) {
    const sampleIndex = mapOffset + sampleOffset;
    const leftSample = leftSpectra[sampleIndex];
    leftSpectra[sampleIndex] = rightSpectra[sampleIndex];
    rightSpectra[sampleIndex] = leftSample;
  }
}

function flipRightStereoMapPhase(rightSpectra, mapIndex) {
  const firstBand = AT5_Y[mapIndex] | 0;
  const bandLimit = AT5_Y[(mapIndex | 0) + 1] | 0;

  for (let band = firstBand; band < bandLimit; band += 1) {
    const start = AT5_ISPS[band] | 0;
    const end = AT5_ISPS[band + 1] | 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      rightSpectra[sampleIndex] = -rightSpectra[sampleIndex];
    }
  }
}

export function applyStereoMapTransforms(leftSpectra, rightSpectra, shared, mapCount) {
  for (let mapIndex = 0; mapIndex < (mapCount | 0); mapIndex += 1) {
    if (isStereoMapSwapped(shared, mapIndex)) {
      swapStereoMapSamples(leftSpectra, rightSpectra, mapIndex);
    }
    if (isStereoMapFlipped(shared, mapIndex)) {
      flipRightStereoMapPhase(rightSpectra, mapIndex);
    }
  }
}
