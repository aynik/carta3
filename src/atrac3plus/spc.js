import { AT5_IFQF, AT5_LNGAIN, AT5_RNDTBL, AT5_SFTBL } from "./tables/decode.js";
export { resolveStereoMapSourceChannelIndex as resolveSpcSourceChannelIndex } from "./stereo-maps.js";

const ATX_PWC_RANDOM_SCALE = 1 / 32768;

function gainSegmentCount(record) {
  const count = record?.segmentCount | 0;
  if (count <= 0) {
    return 0;
  }
  return count > 7 ? 7 : count;
}

function gainSegmentIndex(record, index) {
  return record?.segmentGainSel?.[index] | 0;
}

export function computeSpcNoiseBaseScale(currentGainBlock, previousGainBlock, spclev) {
  let baseGain = 0;
  const currentCount = gainSegmentCount(currentGainBlock);
  if (currentCount > 0) {
    const currentIndex = gainSegmentIndex(currentGainBlock, 0);
    baseGain = -(AT5_LNGAIN[currentIndex] | 0);
  }

  let bestGain = 0;
  const previousCount = gainSegmentCount(previousGainBlock);
  for (let segment = 0; segment < previousCount; segment += 1) {
    const previousIndex = gainSegmentIndex(previousGainBlock, segment);
    const previousGain = -(AT5_LNGAIN[previousIndex] | 0);
    const combinedGain = previousGain + baseGain;
    if (combinedGain > bestGain) {
      bestGain = combinedGain;
    }
  }

  for (let segment = 0; segment < currentCount; segment += 1) {
    const currentIndex = gainSegmentIndex(currentGainBlock, segment);
    const currentGain = -(AT5_LNGAIN[currentIndex] | 0);
    if (currentGain > bestGain) {
      bestGain = currentGain;
    }
  }

  return spclev / (1 << (bestGain & 31));
}

export function computeSpcBandNoiseScale(baseScale, idsfValue, quantShift) {
  const shift = quantShift | 0;
  return (baseScale * AT5_SFTBL[idsfValue | 0] * AT5_IFQF[shift]) / (1 << (shift & 31));
}

export function addSpcNoiseBand(spectra, start, end, scale, seed) {
  const bandStart = start | 0;
  const bandEnd = end | 0;
  const baseSeed = seed | 0;

  for (let sampleIndex = bandStart; sampleIndex < bandEnd; sampleIndex += 1) {
    const offset = sampleIndex - bandStart;
    const tableIndex = (baseSeed + offset) & 0x3ff;
    const noise = (AT5_RNDTBL[tableIndex] | 0) * ATX_PWC_RANDOM_SCALE;
    spectra[sampleIndex] += scale * noise;
  }
}
