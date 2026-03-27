import {
  AT5_COEF_C,
  AT5_COEF_S,
  AT5_GAINC_WINDOW,
  AT5_GHA_AMP,
  AT5_INVMIX_SEQ_SCALE,
  AT5_LNGAIN,
  AT5_MATRIX,
  AT5_MDCT_128_SCALE,
  AT5_MIX_SEQ_SCALE,
  AT5_REV,
  AT5_SFTBL_GHA,
  AT5_SIN,
  AT5_SYNTH_WIN_EDGE_0,
  AT5_SYNTH_WIN_EDGE_1,
  AT5_SYNTH_WIN_EDGE_2,
  AT5_SYNTH_WIN_EDGE_3,
  AT5_SYNTH_WIN_FILL,
  AT5_WIND0,
  AT5_WIND1,
  AT5_WIND2,
  AT5_WIND3,
} from "./tables/decode.js";

function roundedCount(count) {
  return (count | 0) & ~3;
}

function assertNonNegativeI32(value, label) {
  if ((value | 0) !== value || value < 0) {
    throw new RangeError(`invalid ${label}`);
  }
}

export function addSeqAt5(a, b, out, count) {
  assertNonNegativeI32(count, "count");
  const total = count | 0;
  const n = roundedCount(total);
  for (let i = 0; i < n; i += 1) {
    out[i] = a[i] + b[i];
  }
  for (let i = n; i < total; i += 1) {
    out[i] = a[i] + b[i];
  }
}

export function subSeqAt5(a, b, out, count) {
  assertNonNegativeI32(count, "count");
  const total = count | 0;
  const n = roundedCount(total);
  for (let i = 0; i < n; i += 1) {
    out[i] = a[i] - b[i];
  }
  for (let i = n; i < total; i += 1) {
    out[i] = a[i] - b[i];
  }
}

export function mixSeqAt5(a, b, out, count) {
  assertNonNegativeI32(count, "count");
  const total = count | 0;
  const n = roundedCount(total);
  const scale = AT5_MIX_SEQ_SCALE;
  for (let i = 0; i < n; i += 1) {
    out[i] = (a[i] + b[i]) * scale;
  }
  for (let i = n; i < total; i += 1) {
    out[i] = (a[i] + b[i]) * scale;
  }
}

export function invmixSeqAt5(a, b, out, count) {
  assertNonNegativeI32(count, "count");
  const total = count | 0;
  const n = roundedCount(total);
  const scale = AT5_INVMIX_SEQ_SCALE;
  for (let i = 0; i < n; i += 1) {
    out[i] = (a[i] - b[i]) * scale;
  }
  for (let i = n; i < total; i += 1) {
    out[i] = (a[i] - b[i]) * scale;
  }
}

const AT5_SPECTRUM_SAMPLES = 0x80;
const AT5_TIME_SAMPLES = 0x100;
const AT5_OVERLAP_SAMPLES = 0x80;
const AT5_SUBBAND_BLOCKS = 0x10;

const AT5_GAIN_STEP_COUNT = 0x40;
const AT5_GAIN_STEP_STRIDE = 4;
const AT5_MDCT_FFT_SAMPLES = 128;
const gMdctFftScratch = new Float32Array(AT5_MDCT_FFT_SAMPLES);
const gBackwardTransformScratchByBuffer = new WeakMap();

function getBackwardTransformScratch(overlap) {
  if (!(overlap instanceof Float32Array)) {
    return null;
  }

  const key = overlap.buffer;
  let scratch = gBackwardTransformScratchByBuffer.get(key);
  if (!scratch) {
    scratch = {
      fft: new Float32Array(AT5_SPECTRUM_SAMPLES),
      time: new Float32Array(AT5_TIME_SAMPLES),
      scale: new Float32Array(AT5_TIME_SAMPLES),
      gainSteps: new Int32Array(AT5_GAIN_STEP_COUNT),
    };
    gBackwardTransformScratchByBuffer.set(key, scratch);
  }
  return scratch;
}

function at5Pow2Scale(gain) {
  const g = gain | 0;
  if (g === 0) {
    return 1;
  }
  if (g > 0) {
    return 1 / (1 << (g & 31));
  }
  return 1 << (-g & 31);
}

function mdctWindowForGaincFlags(flagA, flagB) {
  if ((flagA | 0) === 0 && (flagB | 0) === 0) {
    return AT5_WIND0;
  }
  if ((flagA | 0) === 0) {
    return AT5_WIND1;
  }
  if ((flagB | 0) === 0) {
    return AT5_WIND2;
  }
  return AT5_WIND3;
}

function gaincDecodeStepsSet(dst, block, endBias) {
  let cursor = 0;
  const count = block.segmentCount | 0;
  if (count <= 0) {
    return;
  }

  for (let seg = 0; seg < count; seg += 1) {
    const sel = block.segmentGainSel[seg] | 0;
    const gain = AT5_LNGAIN[sel] | 0;
    const end = (block.segmentEnd[seg] | 0) + (endBias | 0);

    if (cursor > end) {
      continue;
    }
    while (cursor <= end) {
      dst[cursor] = gain;
      cursor += 1;
    }
  }
}

function gaincDecodeStepsAdd(dst, block, endBias) {
  let cursor = 0;
  const count = block.segmentCount | 0;
  if (count <= 0) {
    return;
  }

  for (let seg = 0; seg < count; seg += 1) {
    const sel = block.segmentGainSel[seg] | 0;
    const gain = AT5_LNGAIN[sel] | 0;
    const end = (block.segmentEnd[seg] | 0) + (endBias | 0);

    if (cursor > end) {
      continue;
    }
    while (cursor <= end) {
      dst[cursor] += gain;
      cursor += 1;
    }
  }
}

function gaincBuildScale(gainSteps, scaleOut) {
  let prevGain = 0;
  let outPos = AT5_TIME_SAMPLES - 1;
  let firstChange = AT5_TIME_SAMPLES;

  for (let step = AT5_GAIN_STEP_COUNT - 1; step >= 0; step -= 1) {
    const gain = gainSteps[step] | 0;
    if (gain === prevGain) {
      const v = at5Pow2Scale(gain);
      scaleOut[outPos] = v;
      scaleOut[outPos - 1] = v;
      scaleOut[outPos - 2] = v;
      scaleOut[outPos - 3] = v;
    } else {
      if (firstChange === AT5_TIME_SAMPLES) {
        firstChange = outPos;
      }

      const diff = Math.abs(gain - prevGain);
      const tbl = (diff - 1) * 3;
      if (gain > prevGain) {
        const basePrev = at5Pow2Scale(prevGain);
        const baseCurr = at5Pow2Scale(gain);
        scaleOut[outPos] = basePrev * AT5_GAINC_WINDOW[tbl + 2];
        scaleOut[outPos - 1] = basePrev * AT5_GAINC_WINDOW[tbl + 1];
        scaleOut[outPos - 2] = basePrev * AT5_GAINC_WINDOW[tbl + 0];
        scaleOut[outPos - 3] = baseCurr;
      } else {
        const baseCurr = at5Pow2Scale(gain);
        scaleOut[outPos - 3] = baseCurr;
        scaleOut[outPos - 2] = baseCurr * AT5_GAINC_WINDOW[tbl + 2];
        scaleOut[outPos - 1] = baseCurr * AT5_GAINC_WINDOW[tbl + 1];
        scaleOut[outPos] = baseCurr * AT5_GAINC_WINDOW[tbl + 0];
      }
    }

    prevGain = gain;
    outPos -= AT5_GAIN_STEP_STRIDE;
  }

  if (firstChange === AT5_TIME_SAMPLES) {
    return 0xff;
  }
  return firstChange | 0;
}

export function createAt5GaincBlock() {
  return {
    segmentCount: 0,
    segmentEnd: new Int32Array(7),
    segmentGainSel: new Int32Array(7),
    windowFlag: 0,
  };
}

export function copyGainRecordToGaincBlock(record, outBlock) {
  const entries = record?.entries;
  assertNonNegativeI32(entries, "record.entries");
  outBlock.segmentCount = entries;
  outBlock.windowFlag = 0;
  outBlock.segmentEnd.fill(0);
  outBlock.segmentGainSel.fill(0);

  for (let i = 0; i < entries; i += 1) {
    outBlock.segmentEnd[i] = record.locations[i] | 0;
    outBlock.segmentGainSel[i] = record.levels[i] | 0;
  }
}

export function winormalMdct128ExAt5(src, dst, win, flag) {
  const fft = gMdctFftScratch;
  fft.fill(0);

  for (let i = 0; i < 64; i += 1) {
    const idxA = AT5_MATRIX[64 + i] | 0;
    const idxB = AT5_MATRIX[63 - i] | 0;

    const winHead = Math.fround(win[i] * src[i]); // Required rounding
    const winTail = Math.fround(win[127 - i] * src[127 - i]); // Required rounding
    fft[idxA] = winHead - winTail;

    const winMid = Math.fround(win[128 + i] * src[128 + i]); // Required rounding
    const winEnd = Math.fround(win[255 - i] * src[255 - i]); // Required rounding
    fft[idxB] = -(winMid + winEnd);
  }

  let twiddleBase = 0;
  for (let stage = 0; stage < 6; stage += 1) {
    const step = 1 << stage;
    const len = step << 1;
    const groups = 0x80 / (step * 4);
    let base = 0;

    for (let group = 0; group < groups; group += 1) {
      let twiddle = twiddleBase;
      for (let j = 0; j < step; j += 1) {
        const i0 = base + j * 2;
        const i1 = i0 + len;

        const aRe = fft[i0];
        const aIm = fft[i0 + 1];
        const bRe = fft[i1];
        const bIm = fft[i1 + 1];

        const cosv = AT5_COEF_C[twiddle];
        const sinv = AT5_COEF_S[twiddle];

        const prodRe = Math.fround(bRe * cosv); // Required rounding
        const tRe = Math.fround(sinv * bIm + prodRe); // Required rounding

        const prodIm = Math.fround(cosv * -bIm); // Required rounding
        const tIm = Math.fround(bRe * sinv + prodIm); // Required rounding

        fft[i0] = aRe + tRe;
        fft[i0 + 1] = aIm + tIm;
        fft[i1] = aRe - tRe;
        fft[i1 + 1] = aIm - tIm;

        twiddle += 1;
      }
      base += len * 2;
    }

    twiddleBase += step;
  }

  let twiddle = twiddleBase;
  const scale = AT5_MDCT_128_SCALE;

  if ((flag | 0) !== 0) {
    for (let i = 0; i < 64; i += 1) {
      const r = fft[i * 2];
      const im = fft[i * 2 + 1];
      const cosv = AT5_COEF_C[twiddle];
      const sinv = AT5_COEF_S[twiddle];

      const prod0 = Math.fround(r * cosv); // Required rounding
      const sum0 = sinv * im + prod0;

      const prod1 = Math.fround(cosv * -im); // Required rounding
      const sum1 = r * sinv + prod1;

      dst[127 - i * 2] = sum0 * scale;
      dst[i * 2] = sum1 * scale;
      twiddle += 1;
    }
  } else {
    for (let i = 0; i < 64; i += 1) {
      const r = fft[i * 2];
      const im = fft[i * 2 + 1];
      const cosv = AT5_COEF_C[twiddle];
      const sinv = AT5_COEF_S[twiddle];

      const prod0 = Math.fround(r * cosv); // Required rounding
      const sum0 = sinv * im + prod0;

      const prod1 = Math.fround(cosv * -im); // Required rounding
      const sum1 = r * sinv + prod1;

      dst[i * 2] = sum0 * scale;
      dst[127 - i * 2] = sum1 * scale;
      twiddle += 1;
    }
  }
}

export function backwardTransformAt5(src, outPtrs, gainBlocksA, gainBlocksB, blocks, overlap) {
  assertNonNegativeI32(blocks, "blocks");
  if (blocks > AT5_SUBBAND_BLOCKS) {
    throw new RangeError("invalid blocks");
  }

  const scratch = getBackwardTransformScratch(overlap);
  const fft = scratch?.fft ?? new Float32Array(AT5_SPECTRUM_SAMPLES);
  const time = scratch?.time ?? new Float32Array(AT5_TIME_SAMPLES);
  const scale = scratch?.scale ?? new Float32Array(AT5_TIME_SAMPLES);
  const gainSteps = scratch?.gainSteps ?? new Int32Array(AT5_GAIN_STEP_COUNT);

  for (let blockIdx = 0; blockIdx < (blocks | 0); blockIdx += 1) {
    const blockA = gainBlocksA[blockIdx];
    const blockB = gainBlocksB[blockIdx];
    const win = mdctWindowForGaincFlags(blockA.windowFlag, blockB.windowFlag);

    const specBase = blockIdx * AT5_SPECTRUM_SAMPLES;
    let twiddle = 0x3f;
    if ((AT5_REV[blockIdx] | 0) !== 0) {
      for (let i = 0; i < 0x40; i += 1) {
        const idx = i * 2;
        const head = src[specBase + idx];
        const tail = src[specBase + (0x7f - idx)];
        const c = AT5_COEF_C[twiddle];
        const s = AT5_COEF_S[twiddle];
        fft[idx] = c * tail + s * head;
        fft[idx + 1] = tail * s - head * c;
        twiddle += 1;
      }
    } else {
      for (let i = 0; i < 0x40; i += 1) {
        const idx = i * 2;
        const head = src[specBase + idx];
        const tail = src[specBase + (0x7f - idx)];
        const c = AT5_COEF_C[twiddle];
        const s = AT5_COEF_S[twiddle];
        fft[idx] = c * head + s * tail;
        fft[idx + 1] = head * s - tail * c;
        twiddle += 1;
      }
    }

    let twiddleBase = 0x3f;
    for (let stage = 5; stage >= 0; stage -= 1) {
      const step = 1 << stage;
      const half = step * 2;
      const groupStride = step * 4;
      const groups = AT5_SPECTRUM_SAMPLES / groupStride;

      for (let g = 0; g < groups; g += 1) {
        let tw = twiddleBase - step;
        const base = g * groupStride;

        for (let j = 0; j < step; j += 1) {
          const i0 = base + j * 2;
          const i1 = base + half + j * 2;

          const ar = fft[i0];
          const ai = fft[i0 + 1];
          const br = fft[i1];
          const bi = fft[i1 + 1];

          const sumR = ar + br;
          const sumI = ai + bi;
          const diffR = ar - br;
          const diffI = ai - bi;

          const c = AT5_COEF_C[tw];
          const s = AT5_COEF_S[tw];

          fft[i0] = sumR;
          fft[i0 + 1] = sumI;
          fft[i1] = diffR * c + diffI * s;
          fft[i1 + 1] = diffR * s - diffI * c;

          tw += 1;
        }
      }

      twiddleBase -= step;
    }

    for (let i = 0; i < 0x40; i += 1) {
      const idx0 = AT5_MATRIX[0x40 + i] | 0;
      time[i] = win[i] * fft[idx0];

      const idx1 = AT5_MATRIX[i] | 0;
      time[0xc0 + i] = -(fft[idx1] * win[0xc0 + i]);
    }

    for (let i = 0, j = 0x7f; i < 0x80; i += 1, j -= 1) {
      const idx = AT5_MATRIX[j] | 0;
      time[0x40 + i] = -(fft[idx] * win[0x40 + i]);
    }

    const countA = blockA.segmentCount | 0;
    const countB = blockB.segmentCount | 0;
    const out = outPtrs[blockIdx];
    const overlapBase = blockIdx * AT5_OVERLAP_SAMPLES;

    if (countA === 0 && countB === 0) {
      for (let i = 0; i < AT5_OVERLAP_SAMPLES; i += 1) {
        out[i] = time[i] + overlap[overlapBase + i];
      }
      overlap.set(time.subarray(AT5_OVERLAP_SAMPLES), overlapBase);
    } else {
      gainSteps.fill(0);

      gaincDecodeStepsSet(gainSteps, blockB, 0x20);
      gaincDecodeStepsAdd(gainSteps, blockA, 0x00);

      const limit = gaincBuildScale(gainSteps, scale);
      if (limit >= 0x80) {
        for (let i = 0x80; i <= limit; i += 1) {
          time[i] *= scale[i];
        }
      }

      for (let i = 0; i < AT5_OVERLAP_SAMPLES; i += 1) {
        out[i] = scale[i] * time[i] + overlap[overlapBase + i];
      }
      overlap.set(time.subarray(AT5_OVERLAP_SAMPLES), overlapBase);
    }
  }

  if ((blocks | 0) < AT5_SUBBAND_BLOCKS) {
    const tailBase = (blocks | 0) * AT5_OVERLAP_SAMPLES;
    const tailSize = (AT5_SUBBAND_BLOCKS - (blocks | 0)) * AT5_OVERLAP_SAMPLES;
    overlap.fill(0, tailBase, tailBase + tailSize);
  }
}

const AT5_SYNTH_WINDOW_SAMPLES = 256;
const AT5_SYNTH_WINDOW_HALF_SAMPLES = 128;
const AT5_PHASE_MASK = 0x7ff;
const gSynthWindowScratch = new Float32Array(AT5_SYNTH_WINDOW_SAMPLES);

export function synthesisWavAt5(ctx, out, offset, count, mode, flipFlag, flipMode) {
  if (!ctx) {
    throw new TypeError("invalid AT5 synthesis context");
  }

  assertNonNegativeI32(offset, "offset");
  assertNonNegativeI32(count, "count");
  if (!out || typeof out.length !== "number" || out.length < count) {
    throw new RangeError("invalid output buffer");
  }

  for (let i = 0; i < count; i += 1) {
    out[i] = 0;
  }

  const entryCount = ctx.entryCount | 0;
  if (entryCount > 0) {
    const baseOffset = (offset | 0) - AT5_SYNTH_WINDOW_HALF_SAMPLES;
    const entries = ctx.entries;
    const raw = entries instanceof Uint32Array;

    if ((mode | 0) === 0) {
      for (let i = 0; i < entryCount; i += 1) {
        const base = i * 4;
        const entry = raw ? null : entries[i];
        const sftIndex = raw ? entries[base + 0] | 0 : entry.sftIndex | 0;
        const ampIndex = raw ? entries[base + 1] | 0 : entry.ampIndex | 0;
        const phaseBase = raw ? entries[base + 2] | 0 : entry.phaseBase | 0;
        const step = raw ? entries[base + 3] | 0 : entry.step | 0;

        const amp = AT5_GHA_AMP[ampIndex] * AT5_SFTBL_GHA[sftIndex];
        let phase = (((phaseBase | 0) & 0x1f) << 6) + baseOffset * step;
        phase &= AT5_PHASE_MASK;

        for (let j = 0; j < count; j += 1) {
          out[j] = out[j] + amp * AT5_SIN[phase];
          phase = (phase + step) & AT5_PHASE_MASK;
        }
      }
    } else {
      for (let i = 0; i < entryCount; i += 1) {
        const base = i * 4;
        const entry = raw ? null : entries[i];
        const sftIndex = raw ? entries[base + 0] | 0 : entry.sftIndex | 0;
        const phaseBase = raw ? entries[base + 2] | 0 : entry.phaseBase | 0;
        const step = raw ? entries[base + 3] | 0 : entry.step | 0;

        const amp = AT5_SFTBL_GHA[sftIndex];
        let phase = (((phaseBase | 0) & 0x1f) << 6) + baseOffset * step;
        phase &= AT5_PHASE_MASK;

        for (let j = 0; j < count; j += 1) {
          out[j] = out[j] + amp * AT5_SIN[phase];
          phase = (phase + step) & AT5_PHASE_MASK;
        }
      }
    }
  }

  if ((flipFlag | 0) !== 0 && (flipMode | 0) === 1) {
    for (let i = 0; i < count; i += 1) {
      out[i] = -out[i];
    }
  }

  const win = gSynthWindowScratch;
  win.fill(AT5_SYNTH_WIN_FILL);

  if ((ctx.hasLeftFade | 0) !== 0) {
    const idx = ctx.leftIndex | 0;
    for (let i = 0; i < idx; i += 1) {
      win[i] = 0;
    }
    win[idx + 0] = AT5_SYNTH_WIN_EDGE_0;
    win[idx + 1] = AT5_SYNTH_WIN_EDGE_1;
    win[idx + 2] = AT5_SYNTH_WIN_EDGE_2;
    win[idx + 3] = AT5_SYNTH_WIN_EDGE_3;
  }

  if ((ctx.hasRightFade | 0) !== 0) {
    const idx = ctx.rightIndex | 0;
    win[idx - 4] = AT5_SYNTH_WIN_EDGE_3;
    win[idx - 3] = AT5_SYNTH_WIN_EDGE_2;
    win[idx - 2] = AT5_SYNTH_WIN_EDGE_1;
    win[idx - 1] = AT5_SYNTH_WIN_EDGE_0;
    for (let i = idx; i < AT5_SYNTH_WINDOW_SAMPLES; i += 1) {
      win[i] = 0;
    }
  }

  for (let i = 0; i < count; i += 1) {
    out[i] = out[i] * win[(offset | 0) + i];
  }
}
