import { AT5_TIME2FREQ_SCALE_HIGH, AT5_TIME2FREQ_SCALE_LOW } from "../tables/encode-init.js";
import { dftVAt5 } from "../dft.js";
import { at5SigprocIntensityBandView } from "../sigproc/aux.js";
import { AT5_T2F_BANDS_MAX } from "./constants.js";
import { K1, K1P5, K2, K20, K28, K4, K56, K8 } from "./fp.js";
import { blockShared } from "./runtime.js";

const TLEV_HIGH_SCALE_CORE_MODE = 0x12;
const TLEV_HIGH_CORE_MODE = 0x1a;
const TLEV_BYPASS_FLAG = 0x10;
const TLEV_REGULAR_BAND_LIMIT = 0x0b;
const TLEV_CC_BAND_LIMIT = 0x01;
const TLEV_MAG_SCRATCH_SIZE = 144;
const TLEV_DFT_SCRATCH_SIZE = 0x100;

const TLEV_LAYOUT_LOW = Object.freeze({
  bins: 0x40,
  stride: 1,
  lowMeanDivisor: K8,
  highEnergyDivisor: K56,
});

const TLEV_LAYOUT_HIGH = Object.freeze({
  bins: 0x20,
  stride: 2,
  lowMeanDivisor: K4,
  highEnergyDivisor: K28,
});

export function at5T2fThresholdTable(shared, coreMode) {
  const sharedCoreMode = (shared?.coreMode ?? coreMode) | 0;
  return sharedCoreMode > TLEV_HIGH_SCALE_CORE_MODE
    ? AT5_TIME2FREQ_SCALE_HIGH
    : AT5_TIME2FREQ_SCALE_LOW;
}

function isHighCoreTlevMode(coreMode) {
  return (coreMode | 0) > TLEV_HIGH_CORE_MODE;
}

function isBypassedTlev(shared) {
  return (((shared?.encodeFlags ?? 0) | 0) & TLEV_BYPASS_FLAG) !== 0;
}

function tlevBandLimit(allowTlev) {
  return allowTlev ? TLEV_REGULAR_BAND_LIMIT : TLEV_CC_BAND_LIMIT;
}

function shouldAnalyzeTlevBand(band, allowTlev, coreMode) {
  return band < tlevBandLimit(allowTlev) || isHighCoreTlevMode(coreMode);
}

function tlevBandLayout(band) {
  return band < 2 ? TLEV_LAYOUT_LOW : TLEV_LAYOUT_HIGH;
}

function ensureScratchBuffer(scratch, key, length) {
  let buffer = scratch?.[key] ?? null;
  if (!(buffer instanceof Float32Array) || buffer.length !== length) {
    buffer = new Float32Array(length);
    if (scratch && typeof scratch === "object") {
      scratch[key] = buffer;
    }
  }
  return buffer;
}

function resolveTlevScratch(scratch) {
  return {
    mag: ensureScratchBuffer(scratch, "mag", TLEV_MAG_SCRATCH_SIZE),
    dftScratch: ensureScratchBuffer(scratch, "dftScratch", TLEV_DFT_SCRATCH_SIZE),
  };
}

function resetBypassedTlevState(curBuf) {
  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    curBuf.records[band].tlevFlag = 0;
    curBuf.tlevFlagsCopy[band] = 0;
    curBuf.records[band].gainBase = K8;
  }
}

function analyzeTlevSpectrum(src, layout, mag, dftScratch) {
  mag.fill(0);
  if (src) {
    dftVAt5(src, layout.stride, layout.bins * 2, mag, 128, dftScratch);
  }

  let strongestBin = 0;
  let strongestMagnitude = 0;
  for (let i = 0; i < layout.bins; i += 1) {
    if (mag[i] > strongestMagnitude) {
      strongestMagnitude = mag[i];
      strongestBin = i;
    }
  }

  const lowBins = layout.bins >> 3;
  let lowEnergySum = 0;
  for (let i = 0; i < lowBins; i += 1) {
    lowEnergySum += mag[i];
  }

  let highEnergySum = 0;
  for (let i = lowBins; i < layout.bins; i += 1) {
    highEnergySum += mag[i];
  }

  const totalEnergy = lowEnergySum + highEnergySum;
  return {
    strongestBin,
    strongestMagnitude,
    lowEnergyMean: lowEnergySum / layout.lowMeanDivisor,
    highEnergySum,
    tlev: strongestMagnitude > 0 ? (layout.bins * strongestMagnitude) / totalEnergy : K1,
  };
}

function band0GainBase(metrics, layout) {
  const scaledHighEnergy = (metrics.highEnergySum / layout.highEnergyDivisor) * 16;
  if (metrics.lowEnergyMean <= scaledHighEnergy) {
    return K1;
  }

  if (metrics.strongestBin === 0) {
    return K8;
  }
  if (metrics.strongestBin === 1) {
    return K4;
  }
  if (metrics.strongestBin === 2) {
    return K2;
  }
  if (metrics.strongestBin === 3) {
    return K1P5;
  }
  return K1;
}

function analyzeTlevBand(record, src, band, threshold, allowTlev, coreMode, mag, dftScratch) {
  record.gainBase = K1;

  if (!shouldAnalyzeTlevBand(band, allowTlev, coreMode)) {
    record.tlev = K1;
    record.tlevFlag = 0;
    return;
  }

  const layout = tlevBandLayout(band);
  const metrics = analyzeTlevSpectrum(src, layout, mag, dftScratch);

  record.tlev = metrics.tlev;
  if (band === 0) {
    record.gainBase = band0GainBase(metrics, layout);
  }
  record.tlevFlag = allowTlev && threshold > metrics.tlev ? 1 : 0;
}

function countTlevFlags(curBuf) {
  let flagCount = 0;
  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    flagCount += (curBuf.records[band]?.tlevFlag ?? 0) !== 0 ? 1 : 0;
  }
  return flagCount;
}

function highCoreFlagPadding(flagCount) {
  if (flagCount <= 3) {
    return 0;
  }
  if (flagCount < 8) {
    return 1;
  }
  if (flagCount < 0x0c) {
    return 2;
  }
  return 3;
}

function expandHighCoreTlevFlags(curBuf, tlevThresholds) {
  const padding = highCoreFlagPadding(countTlevFlags(curBuf));
  if (padding === 0) {
    return;
  }

  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    if (tlevThresholds[band] + padding > (curBuf.records[band]?.tlev ?? K1)) {
      curBuf.records[band].tlevFlag = 1;
    }
  }
}

function syncTlevFlagCopies(curBuf) {
  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    curBuf.tlevFlagsCopy[band] = (curBuf.records[band]?.tlevFlag ?? 0) >>> 0;
  }
}

export function at5T2fComputeTlevForChannel(
  curBuf,
  analysisPtrs,
  analysisBase,
  shared,
  coreMode,
  tlevThresholds = at5T2fThresholdTable(shared, coreMode),
  scratch = null
) {
  if (!curBuf || !shared || !analysisPtrs || !tlevThresholds) {
    return;
  }

  if (isBypassedTlev(shared)) {
    resetBypassedTlevState(curBuf);
    return;
  }

  const allowTlev = ((shared.encodeFlagCc ?? 0) | 0) === 0;
  const analysisBaseIndex = analysisBase | 0;
  const { mag, dftScratch } = resolveTlevScratch(scratch);

  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    analyzeTlevBand(
      curBuf.records[band],
      analysisPtrs[analysisBaseIndex + band] ?? null,
      band,
      tlevThresholds[band],
      allowTlev,
      coreMode,
      mag,
      dftScratch
    );
  }

  if (isHighCoreTlevMode(coreMode)) {
    expandHighCoreTlevFlags(curBuf, tlevThresholds);
  }

  syncTlevFlagCopies(curBuf);
}

function copyStereoTlevFlag(src, dst, band) {
  dst.tlevFlagsCopy[band] = src.tlevFlagsCopy[band];
  dst.records[band].tlevFlag = src.records[band]?.tlevFlag ?? 0;
}

function alignStereoTlevBand(cur0, cur1, corrByBand, band) {
  const leftFlag = cur0.records[band]?.tlevFlag ?? 0;
  const rightFlag = cur1.records[band]?.tlevFlag ?? 0;
  if (leftFlag === rightFlag) {
    return;
  }

  const leftTlev = cur0.records[band]?.tlev ?? K1;
  const rightTlev = cur1.records[band]?.tlev ?? K1;
  const source = leftTlev <= rightTlev ? cur1 : cur0;
  const target = source === cur0 ? cur1 : cur0;
  const tlevGap = (source.records[band]?.tlev ?? K1) - (target.records[band]?.tlev ?? K1);

  if (tlevGap < K1 || corrByBand[band] > K20) {
    copyStereoTlevFlag(source, target, band);
  }
}

function syncIntensitySwapMapTlevFlags(cur0, cur1, swapMap, startBand) {
  for (let band = startBand; band < AT5_T2F_BANDS_MAX; band += 1) {
    if ((swapMap[band] | 0) === 0) {
      copyStereoTlevFlag(cur0, cur1, band);
    } else {
      copyStereoTlevFlag(cur1, cur0, band);
    }
  }
}

export function at5T2fAlignTlevFlagsStereo(blocks, cur0, cur1, corrByBand, bandLimit) {
  if (!blocks || !blocks[0] || !cur0 || !cur1 || !corrByBand) {
    return;
  }

  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    alignStereoTlevBand(cur0, cur1, corrByBand, band);
  }

  const shared = blockShared(blocks[0]);
  if (!shared || bandLimit <= 0) {
    return;
  }

  const swapMap = shared.swapMap ?? null;
  const intensityBand = at5SigprocIntensityBandView(blocks[0]);
  const startBand = intensityBand ? intensityBand[0] >>> 0 : 0;
  if (!swapMap || startBand >= AT5_T2F_BANDS_MAX) {
    return;
  }

  syncIntensitySwapMapTlevFlags(cur0, cur1, swapMap, startBand);
}
