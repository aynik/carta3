/**
 * Shared time2freq runtime helpers.
 *
 * These helpers expose the scratch buffers and shared block/aux views reused
 * across the gain-control, low-mode, TLEV, and MDCT stages.
 */
import { at5SigprocCorrHistoryViews } from "../sigproc/aux.js";
import { gaincWindowEncAt5 } from "../gainc/internal.js";
import { AT5_T2F_BANDS_MAX } from "./constants.js";
import { fillGainParamFromRecord } from "./record.js";

const AT5_T2F_TIME_SAMPLES = 256;
const AT5_T2F_WINDOW_SCALE_SAMPLES = AT5_T2F_TIME_SAMPLES + 3;
const AT5_T2F_GAIN_PARAM_WORDS = 16;

function ensureTypedScratchBuffer(scratch, key, TypedArrayCtor, length, fallbackKey = null) {
  const value = fallbackKey ? (scratch?.[key] ?? scratch?.[fallbackKey]) : scratch?.[key];
  if (value instanceof TypedArrayCtor && value.length === length) {
    return value;
  }

  const next = new TypedArrayCtor(length);
  if (scratch && typeof scratch === "object") {
    scratch[key] = next;
  }
  return next;
}

export function ensureTime2freqGainWindowScratch(scratch) {
  return {
    time: ensureTypedScratchBuffer(scratch, "time", Float32Array, AT5_T2F_TIME_SAMPLES, "tmp"),
    winScale: ensureTypedScratchBuffer(
      scratch,
      "winScale",
      Float32Array,
      AT5_T2F_WINDOW_SCALE_SAMPLES
    ),
    prevParam: ensureTypedScratchBuffer(
      scratch,
      "prevParam",
      Uint32Array,
      AT5_T2F_GAIN_PARAM_WORDS
    ),
    curParam: ensureTypedScratchBuffer(scratch, "curParam", Uint32Array, AT5_T2F_GAIN_PARAM_WORDS),
  };
}

export function applyGainWindowToTimeSamples(time, prevRecord, curRecord, scratch) {
  const last = gaincWindowEncAt5(
    fillGainParamFromRecord(prevRecord, scratch.prevParam),
    fillGainParamFromRecord(curRecord, scratch.curParam),
    scratch.winScale
  );
  if (last < 0) {
    return last;
  }

  const windowEnd = Math.min(last, AT5_T2F_TIME_SAMPLES - 1);
  for (let i = 0; i <= windowEnd; i += 1) {
    time[i] *= scratch.winScale[i];
  }
  return last;
}

export function time2freqScratch(sharedAux) {
  const root = sharedAux?.scratch ?? null;
  if (!root || typeof root !== "object") {
    return null;
  }

  const existing = root.time2freq;
  const scratch = existing && typeof existing === "object" ? existing : (root.time2freq = {});

  if (!(scratch.mag instanceof Float32Array) || scratch.mag.length !== 144) {
    scratch.mag = new Float32Array(144);
  }
  if (!(scratch.dftScratch instanceof Float32Array) || scratch.dftScratch.length !== 0x100) {
    scratch.dftScratch = new Float32Array(0x100);
  }
  ensureTime2freqGainWindowScratch(scratch);

  return scratch;
}

export function at5T2fCorrByBandFromAux(sharedAux) {
  const corrHistory = at5SigprocCorrHistoryViews(sharedAux);
  if (!(corrHistory.metric0 instanceof Float32Array)) {
    return null;
  }
  return corrHistory.metric0.subarray(0, AT5_T2F_BANDS_MAX);
}

export function at5T2fComputeCorrAverage(corrByBand, bandCount) {
  if (!corrByBand || bandCount <= 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < bandCount; i += 1) {
    sum += corrByBand[i];
  }
  return sum / bandCount;
}

export function blockHeader(block) {
  return block?.header ?? block ?? null;
}

export function blockShared(block) {
  const header = blockHeader(block);
  return header?.shared ?? null;
}
