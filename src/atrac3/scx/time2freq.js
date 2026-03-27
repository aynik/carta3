import { CodecError } from "../../common/errors.js";
import { AT3_MDCT_256_SCALE, AT3_QMF_COEFFS } from "../encode-tables.js";
import { gaincontrolAt3, gaincWindow } from "./gainc.js";
import { hasAt3GainControl } from "./gainc-layout.js";

const AT3_TIME2FREQ_QMF_STATE_OFFSETS_F32 = [0x5000 >> 2, 0x50b8 >> 2, 0x5170 >> 2];
const AT3_TIME2FREQ_QMF_STATE_F32 = 46;
const AT3_QMF_DELAY_SAMPLES = 46;
const AT3_QMF_TAPS = 48;
const AT3_QMF_INPUT_SAMPLES = 1024;
const AT3_QMF_BAND_SAMPLES = 512;
const AT3_MDCT_WINDOW_SAMPLES = 512;
const AT3_MDCT_BLOCK_SAMPLES = AT3_MDCT_WINDOW_SAMPLES >> 1;
const AT3_MDCT_FFT_BINS = AT3_MDCT_BLOCK_SAMPLES >> 1;

function runQmf(input, lowBand, highBand, sampleCount, state, scratch) {
  const buf = scratch;

  buf.set(state.subarray(0, AT3_QMF_DELAY_SAMPLES), 0);
  buf.set(input.subarray(0, sampleCount), AT3_QMF_DELAY_SAMPLES);
  state.set(input.subarray(sampleCount - AT3_QMF_DELAY_SAMPLES, sampleCount), 0);

  const outputCount = sampleCount >> 1;
  for (let i = 0; i < outputCount; i += 1) {
    const xOffset = i * 2;
    let sum0 = 0.0;
    let sum1 = 0.0;

    for (let tap = AT3_QMF_TAPS - 1; tap >= 0; tap -= 4) {
      sum0 += buf[xOffset + tap] * AT3_QMF_COEFFS[tap];
      sum0 += buf[xOffset + tap - 2] * AT3_QMF_COEFFS[tap - 2];
      sum1 += buf[xOffset + tap - 1] * AT3_QMF_COEFFS[tap - 1];
      sum1 += buf[xOffset + tap - 3] * AT3_QMF_COEFFS[tap - 3];
    }

    lowBand[i] = sum0 + sum1;
    highBand[i] = sum0 - sum1;
  }
}

function splitTime2freqBands(input, views) {
  const { splitOutputs, qmfStates, qmfScratch, qmfLowBand, qmfHighBand } = views;

  runQmf(input, qmfLowBand, qmfHighBand, AT3_QMF_INPUT_SAMPLES, qmfStates[0], qmfScratch);
  runQmf(
    qmfLowBand,
    splitOutputs[0],
    splitOutputs[1],
    AT3_QMF_BAND_SAMPLES,
    qmfStates[1],
    qmfScratch
  );
  runQmf(
    qmfHighBand,
    splitOutputs[3],
    splitOutputs[2],
    AT3_QMF_BAND_SAMPLES,
    qmfStates[2],
    qmfScratch
  );
}

const AT3_MDCT_OUTPUT_REVERSE_FLAGS = new Uint32Array([0, 1, 0, 1]);
const AT3_MDCT_PREWINDOW_SEGMENTS = [
  [0, 64, 384, 383, -1, -1],
  [64, 128, 0, 255, 1, -1],
  [192, 64, 256, 511, 1, 1],
];

let gMdctTables = null;
const gForwardTransformScratchByBuffer = new WeakMap();

function getForwardTransformScratch(historyBuffer) {
  if (!(historyBuffer instanceof Float32Array)) {
    return null;
  }

  const key = historyBuffer.buffer;
  let scratch = gForwardTransformScratchByBuffer.get(key);
  if (!scratch) {
    scratch = {
      window: new Float32Array(AT3_MDCT_WINDOW_SAMPLES),
      mdctSrc: new Float32Array(AT3_MDCT_WINDOW_SAMPLES),
      preWindowed: new Float32Array(AT3_MDCT_BLOCK_SAMPLES),
      fftRe: new Float32Array(AT3_MDCT_FFT_BINS),
      fftIm: new Float32Array(AT3_MDCT_FFT_BINS),
    };
    gForwardTransformScratchByBuffer.set(key, scratch);
  }
  return scratch;
}

function bitrevU32(value, bits) {
  let v = value >>> 0;
  let out = 0;
  for (let i = 0; i < bits; i += 1) {
    out = ((out << 1) | (v & 1)) >>> 0;
    v >>>= 1;
  }
  return out >>> 0;
}

const AT3_MDCT_HALF_PI_COS = 6.123031769111886e-17;

function createMdctTables() {
  const tables = {
    prerotCos: new Float32Array(AT3_MDCT_FFT_BINS),
    prerotSin: new Float32Array(AT3_MDCT_FFT_BINS),
    postrotA: new Float32Array(AT3_MDCT_FFT_BINS),
    postrotB: new Float32Array(AT3_MDCT_FFT_BINS),
    postrotC: new Float32Array(AT3_MDCT_FFT_BINS),
    postrotD: new Float32Array(AT3_MDCT_FFT_BINS),
    twiddleCos: new Float32Array(AT3_MDCT_FFT_BINS >> 1),
    twiddleSin: new Float32Array(AT3_MDCT_FFT_BINS >> 1),
    bitrev: new Uint32Array(AT3_MDCT_FFT_BINS),
    window512: new Float32Array(AT3_MDCT_WINDOW_SAMPLES),
    scale256: AT3_MDCT_256_SCALE[0],
  };

  const prerotAngleScale = Math.PI / tables.prerotCos.length;
  for (let i = 0; i < tables.prerotCos.length; i += 1) {
    const angle = i * prerotAngleScale;
    tables.prerotCos[i] = Math.cos(angle);
    tables.prerotSin[i] = -Math.sin(angle);
  }
  tables.prerotCos[tables.prerotCos.length >> 1] = AT3_MDCT_HALF_PI_COS;

  const twiddleAngleScale = Math.PI / tables.twiddleCos.length;
  for (let i = 0; i < tables.twiddleCos.length; i += 1) {
    const angle = i * twiddleAngleScale;
    tables.twiddleCos[i] = Math.cos(angle);
    tables.twiddleSin[i] = -Math.sin(angle);
  }
  tables.twiddleCos[tables.twiddleCos.length >> 1] = AT3_MDCT_HALF_PI_COS;

  for (let i = 0; i < tables.bitrev.length; i += 1) {
    tables.bitrev[i] = bitrevU32(i, 7);
  }

  for (let i = 0; i < tables.window512.length; i += 1) {
    const angle = ((2 * i + 1) * Math.PI) / 1024.0;
    const s = Math.sin(angle);
    tables.window512[i] = s * s;
  }

  for (let i = 0; i < tables.postrotA.length; i += 1) {
    const angleBase = ((2 * i + 1) * Math.PI) / 1024.0;
    const angle5x = ((10 * i + 5) * Math.PI) / 1024.0;
    const cosBase = Math.cos(angleBase);
    const sinBase = Math.sin(angleBase);
    const cos5x = Math.cos(angle5x);
    const sin5x = Math.sin(angle5x);

    tables.postrotA[i] = 0.5 * (cosBase - sin5x);
    tables.postrotB[i] = 0.5 * (cosBase + sin5x);
    tables.postrotC[i] = 0.5 * (cos5x + sinBase);
    tables.postrotD[i] = 0.5 * (cos5x - sinBase);
  }

  return tables;
}

function getMdctTables() {
  if (gMdctTables === null) {
    gMdctTables = createMdctTables();
  }
  return gMdctTables;
}

function runMdctFftStage(fftRe, fftIm, step, len, twiddleCos, twiddleSin) {
  const half = len >> 1;

  for (let base = 0; base < fftRe.length; base += len) {
    let twiddleIndex = 0;

    for (let offset = 0; offset < half; offset += 1) {
      const leftIndex = base + offset;
      const rightIndex = leftIndex + half;
      const twiddleRe = twiddleCos[twiddleIndex];
      const twiddleIm = twiddleSin[twiddleIndex];
      const leftRe = fftRe[leftIndex];
      const leftIm = fftIm[leftIndex];
      const rightRe = fftRe[rightIndex];
      const rightIm = fftIm[rightIndex];
      const rotatedRe = rightRe * twiddleRe - rightIm * twiddleIm;
      const rotatedIm = rightIm * twiddleRe + rightRe * twiddleIm;

      fftRe[rightIndex] = leftRe - rotatedRe;
      fftIm[rightIndex] = leftIm - rotatedIm;
      fftRe[leftIndex] = leftRe + rotatedRe;
      fftIm[leftIndex] = leftIm + rotatedIm;
      twiddleIndex += step;
    }
  }
}

function fillMdctPrewindow(preWindowed, src, window512) {
  for (const [
    dstOffset,
    count,
    fwdBase,
    revBase,
    fwdSign,
    revSign,
  ] of AT3_MDCT_PREWINDOW_SEGMENTS) {
    for (let i = 0; i < count; i += 1) {
      const fwd = fwdBase + i * 2;
      const rev = revBase - i * 2;
      preWindowed[dstOffset + i] =
        fwdSign * window512[fwd] * src[fwd] + revSign * window512[rev] * src[rev];
    }
  }
}

function runMdctBlock(
  preWindowed,
  fftRe,
  fftIm,
  src,
  dst,
  dstOffset,
  scale,
  reverseOutput,
  tables
) {
  fillMdctPrewindow(preWindowed, src, tables.window512);

  for (let i = 0; i < 128; i += 1) {
    const a = preWindowed[i * 2];
    const b = preWindowed[i * 2 + 1];
    const cosv = tables.prerotCos[i];
    const sinv = tables.prerotSin[i];
    fftRe[i] = a * cosv - b * sinv;
    fftIm[i] = a * sinv + b * cosv;
  }

  for (let i = 0; i < 128; i += 1) {
    const j = tables.bitrev[i] | 0;
    if (j <= i) {
      continue;
    }

    const tmpRe = fftRe[j];
    fftRe[j] = fftRe[i];
    fftRe[i] = tmpRe;

    const tmpIm = fftIm[j];
    fftIm[j] = fftIm[i];
    fftIm[i] = tmpIm;
  }

  for (let step = 64, len = 2; step > 0; step >>= 1, len <<= 1) {
    runMdctFftStage(fftRe, fftIm, step, len, tables.twiddleCos, tables.twiddleSin);
  }

  const fftLast = fftRe.length - 1;
  const dstHead = dstOffset;
  const dstTail = dstOffset + preWindowed.length - 1;
  for (let i = 0; i < fftRe.length; i += 1) {
    const rev = fftLast - i;
    const x = fftRe[i];
    const y = fftRe[rev];
    const u = fftIm[i];
    const v = fftIm[rev];

    const t2 = tables.postrotA[i];
    const t3 = tables.postrotB[i];
    const t4 = tables.postrotC[i];
    const t5 = tables.postrotD[i];

    const forwardValue = scale * (x * t2 + y * t3 + u * t4 + v * t5);
    const reverseValue = scale * (x * t4 - y * t5 - u * t2 + v * t3);
    const left = reverseOutput ? dstTail - i : dstHead + i;
    const right = reverseOutput ? dstHead + i : dstTail - i;

    dst[left] = forwardValue;
    dst[right] = reverseValue;
  }
}

export function forwardTransformAt3(
  historyBlocks,
  out,
  previousGainParamsList,
  currentGainParamsList,
  count,
  historyBuffer
) {
  const tables = getMdctTables();
  if (count <= 0) {
    return 0;
  }

  const scratch = getForwardTransformScratch(historyBuffer);
  const window = scratch?.window ?? new Float32Array(AT3_MDCT_WINDOW_SAMPLES);
  const mdctSrc = scratch?.mdctSrc ?? new Float32Array(AT3_MDCT_WINDOW_SAMPLES);
  const preWindowed = scratch?.preWindowed ?? new Float32Array(AT3_MDCT_BLOCK_SAMPLES);
  const fftRe = scratch?.fftRe ?? new Float32Array(AT3_MDCT_FFT_BINS);
  const fftIm = scratch?.fftIm ?? new Float32Array(AT3_MDCT_FFT_BINS);

  for (let block = 0; block < count; block += 1) {
    const blockOffset = block * AT3_MDCT_BLOCK_SAMPLES;
    const historyBlock = historyBlocks[block];
    const historyInput = historyBuffer.subarray(blockOffset, blockOffset + AT3_MDCT_BLOCK_SAMPLES);
    const previousGainParams = previousGainParamsList[block];
    const currentGainParams = currentGainParamsList[block];
    const useWindow = hasAt3GainControl(previousGainParams) || hasAt3GainControl(currentGainParams);

    if (
      useWindow &&
      gaincWindow(AT3_MDCT_WINDOW_SAMPLES, previousGainParams, currentGainParams, window) === -1
    ) {
      return -1;
    }

    for (let i = 0; i < AT3_MDCT_BLOCK_SAMPLES; i += 1) {
      mdctSrc[i] = useWindow ? historyInput[i] / window[i] : historyInput[i];
      mdctSrc[AT3_MDCT_BLOCK_SAMPLES + i] = useWindow
        ? historyBlock[i] / window[AT3_MDCT_BLOCK_SAMPLES + i]
        : historyBlock[i];
    }

    runMdctBlock(
      preWindowed,
      fftRe,
      fftIm,
      mdctSrc,
      out,
      blockOffset,
      tables.scale256,
      (AT3_MDCT_OUTPUT_REVERSE_FLAGS[block] | 0) === 1,
      tables
    );
  }

  for (let block = 0; block < count; block += 1) {
    historyBuffer.set(historyBlocks[block], block * AT3_MDCT_BLOCK_SAMPLES);
  }
  return 0;
}

const AT3_TIME2FREQ_TABLE_BYTES = 0x5228;
const AT3_TIME2FREQ_TABLE_F32 = AT3_TIME2FREQ_TABLE_BYTES >> 2;
const AT3_TIME2FREQ_BANDS = 4;
const AT3_TIME2FREQ_BAND_STRIDE_F32 = 3072 >> 2;
const AT3_TIME2FREQ_BAND_PART_F32 = 1024 >> 2;
const AT3_TIME2FREQ_SHIFT_F32 = 2048 >> 2;
const AT3_TIME2FREQ_TRANSFORM_BUF_OFFSET_F32 = 0x3000 >> 2;
const AT3_TIME2FREQ_NO_GAIN_BUF_OFFSET_F32 = 0x4000 >> 2;
const AT3_FRAME_SAMPLES = 1024;
const gTime2freqViews = new WeakMap();

function getTime2freqViews(table) {
  let views = gTime2freqViews.get(table);
  if (views) {
    return views;
  }

  const bands = Array.from({ length: AT3_TIME2FREQ_BANDS }, (_, band) =>
    table.subarray(band * AT3_TIME2FREQ_BAND_STRIDE_F32, (band + 1) * AT3_TIME2FREQ_BAND_STRIDE_F32)
  );
  views = {
    bands,
    mdctBlocks: bands.map((band) =>
      band.subarray(AT3_TIME2FREQ_BAND_PART_F32, AT3_TIME2FREQ_SHIFT_F32)
    ),
    splitOutputs: bands.map((band) => band.subarray(AT3_TIME2FREQ_SHIFT_F32)),
    qmfStates: AT3_TIME2FREQ_QMF_STATE_OFFSETS_F32.map((offset) =>
      table.subarray(offset, offset + AT3_TIME2FREQ_QMF_STATE_F32)
    ),
    qmfScratch: new Float32Array(AT3_QMF_DELAY_SAMPLES + AT3_QMF_INPUT_SAMPLES),
    qmfLowBand: new Float32Array(AT3_QMF_BAND_SAMPLES),
    qmfHighBand: new Float32Array(AT3_QMF_BAND_SAMPLES),
    transformBuffer: table.subarray(
      AT3_TIME2FREQ_TRANSFORM_BUF_OFFSET_F32,
      AT3_TIME2FREQ_TRANSFORM_BUF_OFFSET_F32 + AT3_FRAME_SAMPLES
    ),
    noGainScratch: table.subarray(
      AT3_TIME2FREQ_NO_GAIN_BUF_OFFSET_F32,
      AT3_TIME2FREQ_NO_GAIN_BUF_OFFSET_F32 + AT3_FRAME_SAMPLES
    ),
  };
  gTime2freqViews.set(table, views);
  return views;
}

export function createAt3Time2freqTable() {
  return new Float32Array(AT3_TIME2FREQ_TABLE_F32);
}

export function getAt3Time2freqMdctBlocks(table) {
  return getTime2freqViews(table).mdctBlocks;
}

export function getAt3Time2freqNoGainScratch(table) {
  return getTime2freqViews(table).noGainScratch;
}

export function channelNeedsForwardTransformAt3(channel) {
  const prev = channel.prevState;
  return channel.gaincParams.some(
    (params, index) => hasAt3GainControl(params) || hasAt3GainControl(prev.gaincParams[index])
  )
    ? 1
    : 0;
}

function ensurePcmChannels(channels, count, label) {
  if (!Array.isArray(channels) || channels.length < count) {
    throw new CodecError(`${label} must be an array with at least ${count} channels`);
  }
  for (let i = 0; i < count; i += 1) {
    const ch = channels[i];
    if (!(ch instanceof Float32Array) || ch.length < AT3_FRAME_SAMPLES) {
      throw new CodecError(
        `${label}[${i}] must be a Float32Array with at least ${AT3_FRAME_SAMPLES} samples`
      );
    }
  }
}

function ensureTime2freqScratchChannels(scratchChannels, count) {
  if (!Array.isArray(scratchChannels) || scratchChannels.length < count) {
    throw new CodecError(`scratchChannels must provide at least ${count} channel scratch buffers`);
  }

  for (let ch = 0; ch < count; ch += 1) {
    const scratch = scratchChannels[ch];
    if (!(scratch?.spectra instanceof Float32Array) || scratch.spectra.length < AT3_FRAME_SAMPLES) {
      throw new CodecError(
        `scratchChannels[${ch}].spectra must be a Float32Array with at least ${AT3_FRAME_SAMPLES} samples`
      );
    }
    if (
      !(scratch?.time2freq instanceof Float32Array) ||
      scratch.time2freq.length < AT3_TIME2FREQ_TABLE_F32
    ) {
      throw new CodecError(
        `scratchChannels[${ch}].time2freq must be a Float32Array with at least ${AT3_TIME2FREQ_TABLE_F32} entries`
      );
    }
  }
}

export function time2freqAt3(srcList, scratchChannels, channelHistories, count, mode) {
  ensurePcmChannels(srcList, count, "srcList");
  ensureTime2freqScratchChannels(scratchChannels, count);
  if (!Array.isArray(channelHistories) || channelHistories.length < count) {
    throw new CodecError(`channelHistories must provide at least ${count} channel histories`);
  }

  const channelViews = new Array(count);
  for (let ch = 0; ch < count; ch += 1) {
    const scratch = scratchChannels[ch];
    const views = getTime2freqViews(scratch.time2freq);
    for (const bandView of views.bands) {
      bandView.copyWithin(
        0,
        AT3_TIME2FREQ_BAND_PART_F32,
        AT3_TIME2FREQ_BAND_PART_F32 + AT3_TIME2FREQ_SHIFT_F32
      );
      bandView.fill(0, AT3_TIME2FREQ_SHIFT_F32);
    }
    splitTime2freqBands(srcList[ch], views);
    channelViews[ch] = {
      current: channelHistories[ch]?.current ?? null,
      spectra: scratch.spectra,
      views,
    };
  }

  if (count === 2 && mode === 2) {
    return -1;
  }

  for (let ch = 0; ch < count; ch += 1) {
    const scratch = scratchChannels[ch];
    const { current: channel, spectra, views } = channelViews[ch];
    if (!channel) {
      throw new CodecError(`channelHistories[${ch}] must provide a current channel state`);
    }
    const prevGaincParams = channel.prevState.gaincParams;
    const gaincParams = channel.gaincParams;
    const { bands, mdctBlocks, transformBuffer } = views;

    if (gaincontrolAt3(bands, prevGaincParams, gaincParams, scratch) === -1) {
      return -1;
    }

    if (
      forwardTransformAt3(
        mdctBlocks,
        spectra,
        prevGaincParams,
        gaincParams,
        AT3_TIME2FREQ_BANDS,
        transformBuffer
      ) === -1
    ) {
      return -1;
    }
  }

  return 0;
}
