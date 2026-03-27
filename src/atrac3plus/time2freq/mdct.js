import { AT5_REV, AT5_WIND0, AT5_WIND1, AT5_WIND2, AT5_WIND3 } from "../tables/decode.js";
import { winormalMdct128ExAt5 } from "../dsp.js";
import { AT5_T2F_BANDS_MAX } from "./constants.js";
import { recordEntries } from "./record.js";
import { applyGainWindowToTimeSamples, ensureTime2freqGainWindowScratch } from "./runtime.js";

const AT5_T2F_TIME_SAMPLES = 256;
const AT5_T2F_MDCT_SAMPLES = 128;
const AT5_T2F_ENCODE_MODE_ENCODER2 = 2;

function analysisPtr(analysisPtrs, channel, band) {
  return analysisPtrs?.[channel * AT5_T2F_BANDS_MAX + band] ?? null;
}

function hasGainWindowActivity(prevRecord, curRecord) {
  return recordEntries(prevRecord) !== 0 || recordEntries(curRecord) !== 0;
}

function specBandView(spec, band) {
  const start = band * AT5_T2F_MDCT_SAMPLES;
  return spec.subarray(start, start + AT5_T2F_MDCT_SAMPLES);
}

export function at5T2fSelectWindow(prevRecord, curRecord) {
  const prevFlag = prevRecord?.tlevFlag ? 1 : 0;
  const curFlag = curRecord?.tlevFlag ? 1 : 0;

  if (prevFlag === 0) {
    return curFlag === 0 ? AT5_WIND0 : AT5_WIND1;
  }
  return curFlag === 0 ? AT5_WIND2 : AT5_WIND3;
}

export function at5T2fMdctOutputs(
  prevBufs,
  curBufs,
  analysisPtrs,
  quantizedSpectraByChannel,
  bitallocSpectraByChannel,
  channelCount,
  bandCount,
  encodeMode,
  scratch = null
) {
  if (
    !prevBufs ||
    !curBufs ||
    !analysisPtrs ||
    !quantizedSpectraByChannel ||
    !bitallocSpectraByChannel
  ) {
    return;
  }

  const mdctScratch = ensureTime2freqGainWindowScratch(scratch);
  const { time } = mdctScratch;
  const secondaryBandLimit =
    encodeMode === AT5_T2F_ENCODE_MODE_ENCODER2 ? Math.min(bandCount, 4) : bandCount;

  for (let ch = 0; ch < channelCount; ch += 1) {
    const quantizedSpectrum = quantizedSpectraByChannel[ch];
    const bitallocSpectrum = bitallocSpectraByChannel[ch];
    if (!quantizedSpectrum || !bitallocSpectrum) {
      continue;
    }

    for (let band = 0; band < bandCount; band += 1) {
      const prevRec = prevBufs[ch]?.records?.[band];
      const curRec = curBufs[ch]?.records?.[band];

      const src = analysisPtr(analysisPtrs, ch, band);
      if (!src) {
        continue;
      }

      time.set(src.subarray(0, AT5_T2F_TIME_SAMPLES), 0);

      if (hasGainWindowActivity(prevRec, curRec)) {
        applyGainWindowToTimeSamples(time, prevRec, curRec, mdctScratch);
      }

      const win = at5T2fSelectWindow(prevRec, curRec);
      winormalMdct128ExAt5(time, specBandView(quantizedSpectrum, band), win, AT5_REV[band] | 0);
    }

    for (let band = 0; band < secondaryBandLimit; band += 1) {
      const prevRec = prevBufs[ch]?.records?.[band];
      const curRec = curBufs[ch]?.records?.[band];

      if (!hasGainWindowActivity(prevRec, curRec)) {
        specBandView(bitallocSpectrum, band).set(specBandView(quantizedSpectrum, band));
        continue;
      }

      const src = analysisPtr(analysisPtrs, ch, band);
      if (!src) {
        continue;
      }

      time.set(src.subarray(0, AT5_T2F_TIME_SAMPLES), 0);

      const win = at5T2fSelectWindow(prevRec, curRec);
      winormalMdct128ExAt5(time, specBandView(bitallocSpectrum, band), win, AT5_REV[band] | 0);
    }

    if (encodeMode === AT5_T2F_ENCODE_MODE_ENCODER2 && bandCount > 4) {
      const copyStart = 4 * AT5_T2F_MDCT_SAMPLES;
      const copyEnd = bandCount * AT5_T2F_MDCT_SAMPLES;
      bitallocSpectrum.set(quantizedSpectrum.subarray(copyStart, copyEnd), copyStart);
    }
  }
}
