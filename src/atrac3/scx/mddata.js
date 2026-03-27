/**
 * ATRAC3 SCX mddata non-tone search, budget fitting, and final refinement.
 */
import { CodecError } from "../../common/errors.js";
import { AT3_MDDATA_STEP_TABLE_LARGE, AT3_MDDATA_STEP_TABLE_SMALL } from "../encode-tables.js";
import {
  ensureNumericView,
  fpUnorderedOrLe,
  toInt,
  toIntChecked,
  viewSlice,
} from "./mddata-common.js";
import { extractMultitone, extractSingleTones, singleToneCheck } from "./mddata-tones.js";
import {
  getAt3GainControlCount,
  isAt3GainControlAttack,
  setAt3GainControlCount,
} from "./gainc-layout.js";
import {
  AT3_NBITS_ERROR,
  filterBandForQuantBandAt3,
  quantStepCountForWordLengthIndexAt3,
  scaleFactorValueForIndexAt3,
  scaleFactorIndexForAbsValueAt3,
  spectrumOffsetForQuantBandAt3,
  spectrumSampleCountForQuantBandAt3,
  zeroThresholdForWordLengthIndexAt3,
} from "./tables.js";
import { nbitsForPackdataAt3 } from "./pack-bits.js";
import { quantNontoneNspecs } from "./quant.js";

function setCuidsfFromSpec(spec, dst, count) {
  ensureNumericView(spec, "spec");
  const n = toIntChecked(count, "count");
  const out = dst ?? new Int32Array(n);
  ensureNumericView(out, "dst");

  for (let i = 0; i < n; i += 1) {
    const base = i * 4;
    let maxVal = 0;
    for (let k = 0; k < 4; k += 1) {
      const value = Math.abs(spec[base + k] ?? 0);
      if (value > maxVal) {
        maxVal = value;
      }
    }
    out[i] = scaleFactorIndexForAbsValueAt3(maxVal + 6.0e-6);
  }

  return out;
}

function cuidsfIndexFromIqt(index) {
  let value = spectrumOffsetForQuantBandAt3(index);
  if (value < 0) {
    value += 3;
  }
  return value >> 2;
}

function setQuidsfFromCuidsf(cuidsf, out, count) {
  const src = ensureNumericView(cuidsf, "cuidsf");
  const n = toIntChecked(count, "count");
  const dst = out ?? new Int32Array(n);
  ensureNumericView(dst, "out");

  for (let i = 0; i < n; i += 1) {
    const base = cuidsfIndexFromIqt(i);
    let best = toIntChecked(src[base] ?? 0, `cuidsf[${base}]`);
    const limit = cuidsfIndexFromIqt(i + 1);
    for (let j = base + 1; j < limit; j += 1) {
      const cur = toIntChecked(src[j] ?? 0, `cuidsf[${j}]`);
      if (best < cur) {
        best = cur;
      }
    }
    dst[i] = best;
  }

  return dst;
}

function translateToIdwl(limits, minVal, src, ref, dst, count, maxVal) {
  const limitsView = ensureNumericView(limits, "limits");
  const srcView = ensureNumericView(src, "src");
  const refView = ensureNumericView(ref, "ref");
  const out = dst ?? new Int32Array(toIntChecked(count, "count"));
  ensureNumericView(out, "dst");

  const n = toIntChecked(count, "count");
  const lo = toIntChecked(minVal, "minVal");
  const hi = toIntChecked(maxVal, "maxVal");

  for (let i = 0; i < n; i += 1) {
    let value = (Number(srcView[i] ?? 0) + 0.5) | 0;
    if (value > hi) {
      value = hi;
    }
    if (value < lo) {
      value = lo;
    }
    out[i] = value;
  }

  let maxRef = 0;
  for (let i = 1; i < n; i += 1) {
    const value = toIntChecked(refView[i] ?? 0, `ref[${i}]`);
    if (value > maxRef) {
      maxRef = value;
    }
  }

  let threshold = 0;
  if (maxRef <= 0x1d) {
    threshold = (maxRef / 6) | 0;
    if (threshold === 0) {
      threshold = 1;
    }
  } else {
    threshold = 6;
  }

  for (let i = 0; i < n; i += 1) {
    const refI = toIntChecked(refView[i] ?? 0, `ref[${i}]`);
    if (refI < threshold) {
      out[i] = 0;
    }

    let idx = i - 1;
    for (let k = 0; k <= 7; k += 1, idx -= 1) {
      if (idx < 0) {
        continue;
      }
      const diff =
        toIntChecked(refView[idx] ?? 0, `ref[${idx}]`) -
        toIntChecked(limitsView[k] ?? 0, `limits[${k}]`);
      if (refI < diff) {
        out[i] = 0;
      }
    }
  }

  return threshold | 0;
}

function quantizeMddataBand({
  band,
  id,
  idwl,
  specs,
  out,
  outOffset = null,
  tableGroupIdx,
  ctx,
  quantizeNonToneSpecs,
}) {
  const specOffset = spectrumOffsetForQuantBandAt3(band);
  const specCount = spectrumSampleCountForQuantBandAt3(band);
  if (specOffset < 0 || specCount < 0) {
    return AT3_NBITS_ERROR;
  }

  const writeOffset = outOffset ?? specOffset;
  const bits = quantizeNonToneSpecs(
    tableGroupIdx,
    idwl,
    zeroThresholdForWordLengthIndexAt3(id, idwl),
    specCount,
    viewSlice(specs, specOffset, specOffset + specCount),
    viewSlice(out, writeOffset, writeOffset + specCount),
    ctx
  );
  if (bits === AT3_NBITS_ERROR) {
    return bits;
  }

  return { bits, specOffset, specCount };
}

function resolveBandSpecRange(band) {
  const start = spectrumOffsetForQuantBandAt3(band);
  const end = spectrumOffsetForQuantBandAt3(band + 1);
  if (start < 0 || end < start) {
    return null;
  }

  return { start, end };
}

function scaleBandSpecRange(specs, bandRange, scale) {
  for (let i = bandRange.start; i < bandRange.end; i += 1) {
    specs[i] = scale * specs[i];
  }
}

function measureBandEnergyPair(specs, quantSpecs, bandRange, inverseQuantStep) {
  let energyOrig = 0.0;
  let energyQuant = 0.0;

  for (let i = bandRange.start; i < bandRange.end; i += 1) {
    const value = specs[i];
    energyOrig += value * value;

    const quantizedValue = inverseQuantStep * quantSpecs[i];
    energyQuant += quantizedValue * quantizedValue;
  }

  return { energyOrig, energyQuant };
}

function calcBitnumber(
  flags,
  idwlValues,
  specs,
  quantSpecs,
  bitsByBand,
  specGroupCount,
  tableGroupIdx,
  ids,
  ctx,
  quantizeNonToneSpecs
) {
  if (typeof quantizeNonToneSpecs !== "function") {
    throw new CodecError("quantNontoneNspecs must be a function");
  }

  const activeFlags = ensureNumericView(flags, "flags");
  const idwl = ensureNumericView(idwlValues, "idwlValues");
  const specView = ensureNumericView(specs, "specs");
  const quantView = ensureNumericView(quantSpecs, "quantSpecs");
  const bitsView = ensureNumericView(bitsByBand, "bitsByBand");
  const idView = ensureNumericView(ids, "ids");
  const bandCount = toIntChecked(specGroupCount, "specGroupCount");
  const tableIndex = toIntChecked(tableGroupIdx, "tableGroupIdx");

  let totalBits = 0;
  for (let band = 0; band < bandCount; band += 1) {
    if (toIntChecked(activeFlags[band] ?? 0, `flags[${band}]`) >>> 0 === 1) {
      const quantizedBand = quantizeMddataBand({
        band,
        id: toIntChecked(idView[band] ?? 0, `ids[${band}]`),
        idwl: toIntChecked(idwl[band] ?? 0, `idwlValues[${band}]`),
        specs: specView,
        out: quantView,
        tableGroupIdx: tableIndex,
        ctx,
        quantizeNonToneSpecs,
      });
      if (quantizedBand === AT3_NBITS_ERROR) {
        return AT3_NBITS_ERROR;
      }

      bitsView[band] = quantizedBand.bits;
    }

    totalBits += toIntChecked(bitsView[band] ?? 0, `bitsByBand[${band}]`);
  }

  return totalBits | 0;
}

function iorderFromMax(src, order, count) {
  const srcView = ensureNumericView(src, "src");
  const out = order ?? new Int32Array(toIntChecked(count, "count"));
  ensureNumericView(out, "order");
  const n = toIntChecked(count, "count");
  if (n <= 0) {
    return out;
  }

  const tmp = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    tmp[i] = toIntChecked(srcView[i] ?? 0, `src[${i}]`);
    out[i] = i;
  }

  let gap = 1;
  while (gap <= n) {
    gap = gap * 3 + 1;
  }

  for (gap = (gap / 3) | 0; gap > 0; gap = (gap / 3) | 0) {
    for (let i = gap; i < n; i += 1) {
      const value = tmp[i];
      const valueOrder = out[i];
      let j = i - gap;
      while (j >= 0 && tmp[j] < value) {
        tmp[j + gap] = tmp[j];
        out[j + gap] = out[j];
        j -= gap;
      }
      tmp[j + gap] = value;
      out[j + gap] = valueOrder;
    }
  }

  return out;
}

function buildBandOrderFromMetric(bandCount, metricForBand) {
  const metric = new Int32Array(bandCount);
  const order = new Int32Array(bandCount);

  for (let band = 0; band < bandCount; band += 1) {
    metric[band] = metricForBand(band);
  }

  iorderFromMax(metric, order, bandCount);
  return order;
}

function divisorForBand(band) {
  if (band < 8) {
    return 3.0;
  }
  if (band < 0x0c) {
    return 3.3;
  }
  if (band < 0x10) {
    return 3.4;
  }
  if (band < 0x12) {
    return 3.5;
  }
  if (band < 0x1a) {
    return 3.6;
  }
  if (band < 0x1c) {
    return 3.8;
  }
  if (band > 0x1d) {
    return 4.2;
  }
  return 4.0;
}

function loadStepLimits(tableBytes) {
  const limits = new Int32Array(8);
  const view = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);
  for (let i = 0; i < 8; i += 1) {
    limits[i] = view.getInt32(i * 4, true);
  }
  return limits;
}

const AT3_MDDATA_STEP_LIMITS_SMALL = loadStepLimits(AT3_MDDATA_STEP_TABLE_SMALL);
const AT3_MDDATA_STEP_LIMITS_LARGE = loadStepLimits(AT3_MDDATA_STEP_TABLE_LARGE);

function ensureScratchBuffer(scratch, key, TypedArrayCtor, length) {
  const existing = scratch?.[key] ?? null;
  if (existing instanceof TypedArrayCtor && existing.length === length) {
    return existing;
  }

  const next = new TypedArrayCtor(length);
  if (scratch && typeof scratch === "object") {
    scratch[key] = next;
  }
  return next;
}

function mddataScratchForChannel(globalState, channel) {
  const scratchChannels = globalState?.channelScratch ?? null;
  if (!Array.isArray(scratchChannels)) {
    return null;
  }

  const channelIndex = channel?.channelIndex;
  if (
    !Number.isInteger(channelIndex) ||
    channelIndex < 0 ||
    channelIndex >= scratchChannels.length
  ) {
    return null;
  }

  const scratch = scratchChannels[channelIndex];
  if (!scratch || typeof scratch !== "object") {
    return null;
  }

  let mddata = scratch.mddata;
  if (!mddata || typeof mddata !== "object") {
    mddata = {};
    scratch.mddata = mddata;
  }
  return mddata;
}

function copyPrefix(src, dst, dstOffset, count) {
  for (let i = 0; i < count; i += 1) {
    dst[dstOffset + i] = src[i] | 0;
  }
}

function recalculateMddataBits({
  flags,
  idwl,
  specs,
  quantSpecs,
  bitsByBand,
  specGroupCount,
  ids,
  globalState,
  failSiteKey = null,
  failSite = 0,
}) {
  const sumBits = calcBitnumber(
    flags,
    idwl,
    specs,
    quantSpecs,
    bitsByBand,
    specGroupCount,
    0,
    ids,
    globalState,
    quantNontoneNspecs
  );
  if (sumBits === AT3_NBITS_ERROR && failSite !== 0) {
    setAt3MddataFailSite(failSiteKey, failSite);
  }
  return sumBits;
}

function fitMddataBitBudget({
  budgetState,
  searchState,
  specs,
  quantSpecs,
  globalState,
  failSiteKey,
}) {
  const { budgetBits, specGroupCount, componentGroupCount, singleToneMode } = budgetState;
  const {
    thresholdsBase,
    thresholdsAdjusted,
    stepLimits,
    quidsfTransformedBand,
    idwl,
    idwlPrev,
    idwlInitial,
    changedFlags,
    maxIdwl,
    ids,
    idLimit,
    calcFlags,
    bitsByBand,
  } = searchState;

  let sumBits = 0;
  const recalculateBudget = (flags, failSite = 0) => {
    sumBits = recalculateMddataBits({
      flags,
      idwl,
      specs,
      quantSpecs,
      bitsByBand,
      specGroupCount,
      ids,
      globalState,
      failSiteKey,
      failSite,
    });
    return sumBits;
  };
  const negativeTuneWeight = (band) =>
    band < 1 ? 0.2 : band < 2 ? 0.3 : band < 8 ? 0.4 : band < 0x12 ? 0.6 : 1.0;

  sumBits = recalculateBudget(calcFlags);
  if (sumBits === AT3_NBITS_ERROR) {
    return sumBits;
  }

  // Phase 1: search for a threshold offset that fits the mddata budget.
  let thresholdTune = 2.0;
  let thresholdStep = 4.0;
  for (let iter = 0; iter < 15; iter += 1) {
    for (let band = 0; band < specGroupCount; band += 1) {
      const thresholdOffset =
        thresholdTune >= 0.0 ? thresholdTune : thresholdTune * negativeTuneWeight(band);
      thresholdsAdjusted[band] = thresholdsBase[band] + thresholdOffset;
    }

    idwlPrev.set(idwl);

    translateToIdwl(
      stepLimits,
      1,
      thresholdsAdjusted,
      quidsfTransformedBand,
      idwl,
      specGroupCount,
      maxIdwl
    );

    if (sumBits < 10 && idwl[0] < 6) {
      idwl[0] = 6;
    }
    for (let band = 0; band < specGroupCount; band += 1) {
      if (idwlInitial[band] === 0) {
        idwl[band] = 0;
      }
      changedFlags[band] = idwl[band] !== idwlPrev[band] ? 1 : 0;
    }

    if (recalculateBudget(changedFlags, AT3_MDDATA_FAIL_CALC_SEARCH) === AT3_NBITS_ERROR) {
      return AT3_NBITS_ERROR;
    }

    if (sumBits <= budgetBits && iter > 5) {
      break;
    }

    const nextTune =
      sumBits < budgetBits ? thresholdTune + thresholdStep : thresholdTune - thresholdStep;
    thresholdStep *= iter < 7 ? 0.5 : 1.5;
    thresholdTune = nextTune;
  }

  // Phase 2: relax selector IDs in the leading component groups before shrinking IDWL.
  for (let pass = 0; pass < 4 && budgetBits < sumBits; pass += 1) {
    for (let band = componentGroupCount - 1; band >= 0 && budgetBits < sumBits; band -= 1) {
      if (idwl[band] <= 0 || ids[band] >= idLimit) {
        continue;
      }

      ids[band] += 1;
      if (recalculateBudget(calcFlags, AT3_MDDATA_FAIL_ID_ADJUST) === AT3_NBITS_ERROR) {
        return AT3_NBITS_ERROR;
      }
    }
  }

  changedFlags.fill(0, 0, specGroupCount);
  if (budgetBits >= sumBits) {
    return sumBits;
  }

  // Phase 3: if still over budget, shrink IDWL from the lowest-priority bands first.
  const order = buildBandOrderFromMetric(specGroupCount, (band) =>
    singleToneMode
      ? ((quidsfTransformedBand[band] + 1) * 0x20 - band) | 0
      : (quidsfTransformedBand[band] - ((band / 2) | 0)) | 0
  );
  for (
    let orderIndex = specGroupCount - 1;
    orderIndex >= 0 && budgetBits < sumBits;
    orderIndex -= 1
  ) {
    const band = order[orderIndex] | 0;
    while (idwl[band] > 0 && budgetBits < sumBits) {
      idwl[band] -= 1;
      changedFlags[band] = 1;
      if (recalculateBudget(changedFlags, AT3_MDDATA_FAIL_IDWL_DECR) === AT3_NBITS_ERROR) {
        return AT3_NBITS_ERROR;
      }
      changedFlags[band] = 0;
    }
  }

  return sumBits;
}

function applyBandRefinementAttempt({
  specs,
  band,
  id,
  idwl,
  qnsTmp,
  globalState,
  failSiteKey,
  bitsByBand,
  sumBits,
  totalBits,
  unitBits,
  ctxQuant,
  failSite,
}) {
  const quantizedBand = quantizeMddataBand({
    band,
    id,
    idwl,
    specs,
    out: qnsTmp,
    outOffset: 0,
    tableGroupIdx: 0,
    ctx: globalState,
    quantizeNonToneSpecs: quantNontoneNspecs,
  });
  if (quantizedBand === AT3_NBITS_ERROR) {
    setAt3MddataFailSite(failSiteKey, failSite);
    return quantizedBand;
  }

  const deltaBits = quantizedBand.bits - bitsByBand[band];
  const nextTotalBits = totalBits + deltaBits;
  if (nextTotalBits > unitBits) {
    return { accepted: false, sumBits, totalBits };
  }

  bitsByBand[band] = quantizedBand.bits;
  copyPrefix(qnsTmp, ctxQuant, quantizedBand.specOffset, quantizedBand.specCount);
  return {
    accepted: true,
    sumBits: sumBits + deltaBits,
    totalBits: nextTotalBits,
  };
}

function resolveIdLimit(budgetBits, specGroupCount) {
  const iqtTotal = spectrumOffsetForQuantBandAt3(specGroupCount);
  const ratio = budgetBits / (iqtTotal + 0x100);
  if (ratio > 1.15) {
    return 0;
  }
  if (ratio > 1.1) {
    return 3;
  }
  if (ratio > 1.05) {
    return 5;
  }
  if (ratio > 1.0) {
    return 7;
  }
  if (ratio > 0.95) {
    return 9;
  }
  if (ratio > 0.9) {
    return 0x0b;
  }
  return 0x0c;
}

function initializeMddataSearchState({
  specs,
  channel,
  prevChannel,
  singleToneMode,
  componentGroupCount,
  specGroupCount,
  multitoneBits,
  budgetBits,
  average,
  cuidsfOriginal,
  cuidsfTransformed,
  maxIdwl,
  itfLimits,
  mddataScratch = null,
}) {
  const failSiteKey = at3MddataFailSiteKey(channel);
  const quidsfOriginalBand = ensureScratchBuffer(
    mddataScratch,
    "quidsfOriginalBand",
    Int32Array,
    AT3_MDDATA_MAX_BANDS
  );
  quidsfOriginalBand.fill(0);
  setQuidsfFromCuidsf(cuidsfOriginal, quidsfOriginalBand, specGroupCount);

  const quidsfTransformedBand = ensureScratchBuffer(
    mddataScratch,
    "quidsfTransformedBand",
    Int32Array,
    AT3_MDDATA_MAX_BANDS
  );
  quidsfTransformedBand.fill(0);
  setQuidsfFromCuidsf(cuidsfTransformed, quidsfTransformedBand, specGroupCount);

  const quidsfRefinementBand = ensureScratchBuffer(
    mddataScratch,
    "quidsfRefinementBand",
    Int32Array,
    AT3_MDDATA_MAX_BANDS
  );
  quidsfRefinementBand.fill(0);
  quidsfRefinementBand.set(quidsfTransformedBand);

  const calcFlags = ensureScratchBuffer(
    mddataScratch,
    "calcFlags",
    Uint32Array,
    AT3_MDDATA_MAX_BANDS
  );
  calcFlags.fill(1);
  const changedFlags = ensureScratchBuffer(
    mddataScratch,
    "changedFlags",
    Uint32Array,
    AT3_MDDATA_MAX_BANDS
  );
  changedFlags.fill(1);
  const zeroBandFlags = ensureScratchBuffer(
    mddataScratch,
    "zeroBandFlags",
    Uint32Array,
    AT3_MDDATA_MAX_BANDS
  );
  zeroBandFlags.fill(0);

  const thresholdsBase = ensureScratchBuffer(
    mddataScratch,
    "thresholdsBase",
    Float32Array,
    AT3_MDDATA_MAX_BANDS
  );
  thresholdsBase.fill(0);
  const thresholdsAdjusted = ensureScratchBuffer(
    mddataScratch,
    "thresholdsAdjusted",
    Float32Array,
    AT3_MDDATA_MAX_BANDS
  );
  thresholdsAdjusted.fill(0);
  let hasAttack = false;
  for (const block of [channel, prevChannel]) {
    if (!block) {
      continue;
    }
    for (let i = 0; i < componentGroupCount; i += 1) {
      if (isAt3GainControlAttack(block.gaincParams[i]) === 1) {
        hasAttack = true;
        break;
      }
    }
    if (hasAttack) {
      break;
    }
  }

  // Phase 1: derive the per-band threshold curve from transformed scalefactors.
  for (let band = 0; band < specGroupCount; band += 1) {
    let threshold = (quidsfTransformedBand[band] - average) / divisorForBand(band);
    if (hasAttack) {
      threshold += band < 8 ? 0.7 : band < 0x12 ? 0.5 : 0.0;
    }
    thresholdsBase[band] = threshold;
  }
  if (specGroupCount > 0 && fpUnorderedOrLe(thresholdsBase[0], 6.0)) {
    thresholdsBase[0] = 6.0;
  }
  if (!hasAttack) {
    for (let band = 1; band <= 3 && band < specGroupCount; band += 1) {
      if (fpUnorderedOrLe(thresholdsBase[band], 3.0)) {
        thresholdsBase[band] = 3.0;
      }
    }
  }

  const stepLimits = singleToneMode ? AT3_MDDATA_STEP_LIMITS_LARGE : AT3_MDDATA_STEP_LIMITS_SMALL;
  const idwl = ensureScratchBuffer(mddataScratch, "idwl", Int32Array, AT3_MDDATA_MAX_BANDS);
  idwl.fill(0);
  const idwlInitial = ensureScratchBuffer(
    mddataScratch,
    "idwlInitial",
    Int32Array,
    AT3_MDDATA_MAX_BANDS
  );
  idwlInitial.fill(0);
  const idwlPrev = ensureScratchBuffer(mddataScratch, "idwlPrev", Int32Array, AT3_MDDATA_MAX_BANDS);
  idwlPrev.fill(0);
  const idwlThreshold = translateToIdwl(
    stepLimits,
    1,
    thresholdsBase,
    quidsfTransformedBand,
    idwl,
    specGroupCount,
    maxIdwl
  );
  const hasNoMultitoneBudget = multitoneBits === 0;

  // Phase 2: convert the threshold curve into initial IDWL and zero-band decisions.
  for (let band = 0; band < specGroupCount; band += 1) {
    const bandFallsBelowThreshold = quidsfOriginalBand[band] < idwlThreshold;
    if (bandFallsBelowThreshold) {
      idwl[band] = 0;
    }
    zeroBandFlags[band] =
      bandFallsBelowThreshold ||
      (hasNoMultitoneBudget &&
        (idwl[band] === 0 || fpUnorderedOrLe(quidsfOriginalBand[band], average)))
        ? 1
        : 0;
    idwlInitial[band] = idwl[band];
  }

  // Phase 3: normalize each band by its original scalefactor before quantizer search.
  for (let band = 0; band < specGroupCount; band += 1) {
    const scfof = scaleFactorValueForIndexAt3(quidsfOriginalBand[band]);
    if (scfof < 0.0) {
      setAt3MddataFailSite(failSiteKey, AT3_MDDATA_FAIL_SCFOF);
      return null;
    }

    const bandRange = resolveBandSpecRange(band);
    if (!bandRange) {
      setAt3MddataFailSite(failSiteKey, AT3_MDDATA_FAIL_SCFOF);
      return null;
    }

    scaleBandSpecRange(specs, bandRange, 1.0 / scfof);
  }

  const ids = ensureScratchBuffer(mddataScratch, "ids", Uint32Array, AT3_MDDATA_MAX_BANDS);
  ids.fill(0);
  const bitsByBand = ensureScratchBuffer(
    mddataScratch,
    "bitsByBand",
    Int32Array,
    AT3_MDDATA_MAX_BANDS
  );
  bitsByBand.fill(0);

  // Phase 4: seed selector IDs from the table-group limits recovered for each band.
  for (let band = 0; band < specGroupCount; band += 1) {
    const filterBand = filterBandForQuantBandAt3(band);
    const tableGroup = filterBand >= 0 && filterBand < 8 ? filterBand : 0;
    ids[band] = Math.min(itfLimits[tableGroup] >>> 0, 7);
  }

  return {
    calcFlags,
    changedFlags,
    zeroBandFlags,
    thresholdsBase,
    thresholdsAdjusted,
    stepLimits,
    idwl,
    idwlInitial,
    idwlPrev,
    maxIdwl,
    ids,
    bitsByBand,
    idLimit: resolveIdLimit(budgetBits, specGroupCount),
    quidsfOriginalBand,
    quidsfTransformedBand,
    quidsfRefinementBand,
  };
}

function computeMddataBudgetBits(
  channel,
  unitBits,
  specGroupCount,
  componentGroupCount,
  toneBits = 0
) {
  let bitsAdjust = componentGroupCount * 3;
  for (let i = 0; i < componentGroupCount; i += 1) {
    bitsAdjust += getAt3GainControlCount(channel.gaincParams[i]) * 9;
  }
  const bitsSheader = channel?.scratchFlag >>> 0 === 1 ? 16 : 8;
  return unitBits - bitsSheader - bitsAdjust - specGroupCount * 3 - 0x0d - toneBits;
}

function applyQuidsfEnergyCorrection(failSiteKey, specs, quantSpecs, idwl, quidsf, specGroupCount) {
  for (let band = 0; band < specGroupCount; band += 1) {
    const idwlVal = idwl[band] | 0;
    const nsteps = quantStepCountForWordLengthIndexAt3(idwlVal);
    if (nsteps === -1) {
      setAt3MddataFailSite(failSiteKey, AT3_MDDATA_FAIL_NSTEPS);
      return AT3_NBITS_ERROR;
    }

    const bandRange = resolveBandSpecRange(band);
    if (!bandRange) {
      setAt3MddataFailSite(failSiteKey, AT3_MDDATA_FAIL_NSTEPS);
      return AT3_NBITS_ERROR;
    }

    const inv = 1.0 / (nsteps + 0.5);
    const { energyOrig, energyQuant } = measureBandEnergyPair(specs, quantSpecs, bandRange, inv);

    if (energyQuant > energyOrig * 1.25 && quidsf[band] > 0) {
      quidsf[band] -= 1;
    }
  }

  return 0;
}

function buildThresholdRefinementOrder({
  activeBandCount,
  channelIdwl,
  thresholdsBase,
  thresholdsAdjusted,
  idwlPrev,
  bandOrder = null,
}) {
  const out =
    bandOrder instanceof Int32Array && bandOrder.length === AT3_MDDATA_MAX_BANDS
      ? bandOrder
      : new Int32Array(AT3_MDDATA_MAX_BANDS);
  const refinementMetric = thresholdsBase;
  for (let band = 0; band < activeBandCount; band += 1) {
    const idwlValue = channelIdwl[band] | 0;
    refinementMetric[band] =
      idwlValue === 0 ? -9.989999771118164 : thresholdsAdjusted[band] - idwlValue;
    idwlPrev[band] = -1;
  }

  let minMetric = refinementMetric[0];
  let maxMetric = refinementMetric[0];
  for (let band = 1; band < activeBandCount; band += 1) {
    const value = refinementMetric[band];
    if (fpUnorderedOrLe(value, minMetric)) {
      minMetric = value;
    }
    if (value > maxMetric) {
      maxMetric = value;
    }
  }
  refinementMetric[0] = minMetric;

  let bandOrderCount = 0;
  for (let stepIdx = 0; stepIdx < 10; stepIdx += 1) {
    const cutoff = maxMetric - ((maxMetric - minMetric) * (stepIdx + 1)) / 10.0;
    for (let band = activeBandCount - 1; band >= 0; band -= 1) {
      if (idwlPrev[band] !== -1 || !(cutoff <= refinementMetric[band])) {
        continue;
      }
      out[bandOrderCount] = band;
      idwlPrev[band] = bandOrderCount;
      bandOrderCount += 1;
    }
  }

  return { bandOrder: out, bandOrderCount };
}

function runMddataRefinementPipeline({
  channel,
  specs,
  unitBits,
  bitsAfterFit,
  budgetState,
  searchState,
  globalState,
  mddataScratch = null,
}) {
  const failSiteKey = at3MddataFailSiteKey(channel);
  const { budgetBits, specGroupCount, componentGroupCount } = budgetState;
  const {
    ids,
    idwl,
    quidsfOriginalBand,
    thresholdsBase,
    thresholdsAdjusted,
    idwlPrev,
    bitsByBand,
    idwlInitial,
    zeroBandFlags,
    quidsfRefinementBand,
  } = searchState;
  if (specGroupCount === 0) {
    channel.specGroupCount = 1;
    channel.componentGroupCount = 1;
    setAt3GainControlCount(channel.gaincParams[0], 0);
    channel.mddataEntryIndex = 0;
    return nbitsForPackdataAt3(channel);
  }

  let activeBandCount = specGroupCount;
  while (activeBandCount > 1 && idwl[activeBandCount - 1] === 0) {
    activeBandCount -= 1;
  }

  copyPrefix(idwl, channel.idwl, 0, activeBandCount);
  copyPrefix(quidsfOriginalBand, channel.quidsf, 0, activeBandCount);
  channel.specGroupCount = activeBandCount;
  channel.componentGroupCount = componentGroupCount;
  channel.componentMode = 1;
  channel.specTableIndex = 0;

  const bandOrderScratch = ensureScratchBuffer(
    mddataScratch,
    "bandOrder",
    Int32Array,
    AT3_MDDATA_MAX_BANDS
  );
  const { bandOrder, bandOrderCount } = buildThresholdRefinementOrder({
    activeBandCount,
    channelIdwl: channel.idwl,
    thresholdsBase,
    thresholdsAdjusted,
    idwlPrev,
    bandOrder: bandOrderScratch,
  });

  const quantScratch = ensureScratchBuffer(
    mddataScratch,
    "quantScratch",
    Int32Array,
    AT3_CUIDSF_COUNT * 4
  );
  const quantSpecs = channel.quantSpecs;
  const refinementLimit = unitBits - 2;
  const stopThreshold = unitBits - 8;
  let refinementState = {
    sumBits: bitsAfterFit,
    totalBits: unitBits - (budgetBits - bitsAfterFit),
  };
  const hasRefinementBudget = () => refinementState.totalBits <= refinementLimit;
  const attemptBandRefinement = ({ failSite, band, id, idwl }) => {
    const nextState = applyBandRefinementAttempt({
      failSite,
      specs,
      band,
      id,
      idwl,
      qnsTmp: quantScratch,
      globalState,
      failSiteKey,
      bitsByBand,
      unitBits,
      ctxQuant: quantSpecs,
      ...refinementState,
    });
    if (nextState === AT3_NBITS_ERROR) {
      return nextState;
    }
    refinementState = nextState;
    return nextState.accepted;
  };

  // Phase 1: revisit bands that the budget fit left below their threshold target.
  for (let index = 0; index < bandOrderCount; index += 1) {
    const band = bandOrder[index] | 0;
    const oldIdwl = channel.idwl[band] | 0;
    if (zeroBandFlags[band] !== 0 || oldIdwl <= 0 || oldIdwl >= 7) {
      continue;
    }

    const oldId = ids[band] >>> 0;
    const nextIdwl = oldIdwl < idwlInitial[band] ? oldIdwl + 1 : oldIdwl;
    const nextId = nextIdwl === oldIdwl && oldId >= 1 ? oldId - 1 : oldId;
    if (nextIdwl === oldIdwl && nextId === oldId) {
      if (refinementState.totalBits > stopThreshold) {
        break;
      }
      continue;
    }

    const accepted = attemptBandRefinement({
      failSite: AT3_MDDATA_FAIL_QNS_REFINE_1,
      band,
      id: nextId,
      idwl: nextIdwl,
    });
    if (accepted === AT3_NBITS_ERROR) {
      return AT3_NBITS_ERROR;
    }
    if (!accepted) {
      continue;
    }

    channel.idwl[band] = nextIdwl;
    ids[band] = nextId;
    if (refinementState.totalBits > stopThreshold) {
      break;
    }
  }

  // Phase 2: prefer ID zero when the current band can keep the same IDWL.
  for (let band = 0; band < activeBandCount; band += 1) {
    const idwlValue = channel.idwl[band] | 0;
    if (ids[band] === 0 || idwlValue <= 0) {
      continue;
    }

    const accepted = attemptBandRefinement({
      failSite: AT3_MDDATA_FAIL_QNS_REFINE_2,
      band,
      id: 0,
      idwl: idwlValue,
    });
    if (accepted === AT3_NBITS_ERROR) {
      return AT3_NBITS_ERROR;
    }
    if (accepted) {
      ids[band] = 0;
    }
  }

  if (hasRefinementBudget()) {
    // Phase 3: spend spare bits to restore bands up to their original threshold-derived IDWL.
    for (let pass = 0; pass < 7 && hasRefinementBudget(); pass += 1) {
      for (let band = 0; band < activeBandCount && hasRefinementBudget(); band += 1) {
        const oldIdwl = channel.idwl[band] | 0;
        if (oldIdwl <= 0 || oldIdwl >= idwlInitial[band] || zeroBandFlags[band] !== 0) {
          continue;
        }

        const accepted = attemptBandRefinement({
          failSite: AT3_MDDATA_FAIL_QNS_REFINE_3,
          band,
          id: ids[band] | 0,
          idwl: oldIdwl + 1,
        });
        if (accepted === AT3_NBITS_ERROR) {
          return AT3_NBITS_ERROR;
        }
        if (accepted) {
          channel.idwl[band] = oldIdwl + 1;
        } else {
          zeroBandFlags[band] = 1;
        }
      }
    }
  }

  if (activeBandCount > 1 && hasRefinementBudget()) {
    const lateBandOrder = buildBandOrderFromMetric(
      activeBandCount,
      (band) => ((quidsfRefinementBand[band] + 1) * 0x20 - band) | 0
    );
    // Phase 4: late in the budget, prioritize the strongest high-band energy groups.
    for (let pass = 0; pass < 4 && hasRefinementBudget(); pass += 1) {
      for (let index = 0; index < activeBandCount && hasRefinementBudget(); index += 1) {
        const band = lateBandOrder[index] | 0;
        const oldIdwl = channel.idwl[band] | 0;
        if (oldIdwl <= 0 || oldIdwl >= pass + 3) {
          continue;
        }

        const accepted = attemptBandRefinement({
          failSite: AT3_MDDATA_FAIL_QNS_REFINE_4,
          band,
          id: ids[band] | 0,
          idwl: oldIdwl + 1,
        });
        if (accepted === AT3_NBITS_ERROR) {
          return AT3_NBITS_ERROR;
        }
        if (accepted) {
          channel.idwl[band] = oldIdwl + 1;
        }
      }
    }
  }

  if (hasRefinementBudget()) {
    // Phase 5: use the last spare bits for a final broad IDWL sweep.
    for (let pass = 0; pass < 7 && hasRefinementBudget(); pass += 1) {
      for (let band = 0; band < activeBandCount && hasRefinementBudget(); band += 1) {
        const oldIdwl = channel.idwl[band] | 0;
        if (oldIdwl <= 0 || oldIdwl > 6) {
          continue;
        }

        const accepted = attemptBandRefinement({
          failSite: AT3_MDDATA_FAIL_QNS_REFINE_5,
          band,
          id: ids[band] | 0,
          idwl: oldIdwl + 1,
        });
        if (accepted === AT3_NBITS_ERROR) {
          return AT3_NBITS_ERROR;
        }
        if (accepted) {
          channel.idwl[band] = oldIdwl + 1;
        }
      }
    }
  }

  if (
    applyQuidsfEnergyCorrection(
      failSiteKey,
      specs,
      quantSpecs,
      channel.idwl,
      channel.quidsf,
      activeBandCount
    ) === AT3_NBITS_ERROR
  ) {
    return AT3_NBITS_ERROR;
  }

  const bitsFinal = nbitsForPackdataAt3(channel);
  if (refinementState.totalBits !== bitsFinal) {
    setAt3MddataFailSite(failSiteKey, AT3_MDDATA_FAIL_FINAL_MISMATCH);
  }
  return bitsFinal;
}

function initializeMddataBudgetState({
  transformed,
  specs,
  channel,
  unitBits,
  globalState,
  mddataScratch = null,
}) {
  // Phase 1: measure the original and transformed scalefactor envelopes.
  const cuidsfOriginal = setCuidsfFromSpec(
    specs,
    ensureScratchBuffer(mddataScratch, "cuidsfOriginal", Int32Array, AT3_CUIDSF_COUNT),
    AT3_CUIDSF_COUNT
  );
  const cuidsfTransformed = setCuidsfFromSpec(
    transformed,
    ensureScratchBuffer(mddataScratch, "cuidsfTransformed", Int32Array, AT3_CUIDSF_COUNT),
    AT3_CUIDSF_COUNT
  );

  let peakIdx = 0;
  for (let i = 1; i < AT3_CUIDSF_COUNT; i += 1) {
    if ((cuidsfTransformed[i] | 0) > (cuidsfTransformed[peakIdx] | 0)) {
      peakIdx = i;
    }
  }

  const singleToneLevel = singleToneCheck(cuidsfOriginal);
  const usesSingleToneMode =
    singleToneLevel > 0 &&
    channel?.scratchFlag >>> 0 === 0 &&
    toInt(channel?.specGroupCount ?? 0) > 0x19;
  const singleToneMode = usesSingleToneMode ? 1 : 0;
  let specGroupCount = toInt(channel?.specGroupCount ?? 0);
  let componentGroupCount = toInt(channel?.componentGroupCount ?? 0);

  // Phase 2: choose the mddata layout that tone extraction will target.
  if (usesSingleToneMode) {
    if (peakIdx >= 0xa0) {
      specGroupCount = 0x20;
      componentGroupCount = 0x04;
    } else if (peakIdx > 0x5f) {
      specGroupCount = 0x1e;
      componentGroupCount = 0x03;
    }
  }
  const baseBudgetBits = computeMddataBudgetBits(
    channel,
    unitBits,
    specGroupCount,
    componentGroupCount
  );
  let toneBits = 0;

  // Phase 3: extract explicit tones before the non-tone mddata search begins.
  if (usesSingleToneMode) {
    channel.specGroupCount = specGroupCount;
    channel.componentGroupCount = componentGroupCount;
    toneBits = extractSingleTones(
      baseBudgetBits,
      singleToneLevel,
      unitBits > 0x4b0 ? 2 : 1,
      peakIdx,
      componentGroupCount,
      AT3_CUIDSF_COUNT,
      specs,
      cuidsfOriginal,
      channel
    );
  }

  if (toneBits === AT3_NBITS_ERROR) {
    setAt3MddataFailSite(at3MddataFailSiteKey(channel), AT3_MDDATA_FAIL_SINGLE_TONE);
    return null;
  }

  // Phase 4: derive the leftover non-tone budget from the post-tone envelope.
  const averageBandCount = Math.trunc(spectrumOffsetForQuantBandAt3(specGroupCount) / 4);
  let average = 0.0;
  if (averageBandCount > 0) {
    let sum = 0;
    for (let i = 0; i < averageBandCount; i += 1) {
      sum += cuidsfTransformed[i] | 0;
    }
    average = sum / averageBandCount;
  }
  const multitoneBudgetBits = baseBudgetBits - toneBits;
  const multitoneBits =
    toneBits === 0
      ? extractMultitone(
          multitoneBudgetBits,
          averageBandCount,
          componentGroupCount,
          average,
          cuidsfOriginal,
          cuidsfTransformed,
          specs,
          channel,
          globalState
        )
      : 0;
  const packdataBias = toInt(channel?.mddataEntryIndex ?? 0) === 0 ? 2 : 0;
  const budgetBits = baseBudgetBits - toneBits - multitoneBits + packdataBias;

  return {
    cuidsfOriginal,
    cuidsfTransformed,
    singleToneMode,
    specGroupCount,
    componentGroupCount,
    average,
    multitoneBits,
    budgetBits,
  };
}

const AT3_CUIDSF_COUNT = 0x100;
const AT3_MDDATA_MAX_BANDS = 32;

export const AT3_MDDATA_FAIL_NONE = 0;
export const AT3_MDDATA_FAIL_SINGLE_TONE = 1;
export const AT3_MDDATA_FAIL_CALC_SEARCH = 2;
export const AT3_MDDATA_FAIL_ID_ADJUST = 3;
export const AT3_MDDATA_FAIL_IDWL_DECR = 4;
export const AT3_MDDATA_FAIL_DEFAULT = 5;
export const AT3_MDDATA_FAIL_SCFOF = 51;
export const AT3_MDDATA_FAIL_QNS_REFINE_1 = 52;
export const AT3_MDDATA_FAIL_QNS_REFINE_2 = 53;
export const AT3_MDDATA_FAIL_QNS_REFINE_3 = 54;
export const AT3_MDDATA_FAIL_QNS_REFINE_4 = 55;
export const AT3_MDDATA_FAIL_QNS_REFINE_5 = 56;
export const AT3_MDDATA_FAIL_NSTEPS = 57;
export const AT3_MDDATA_FAIL_FINAL_MISMATCH = 58;

const gAt3MddataFailSiteByKey = new WeakMap();

function at3MddataFailSiteKey(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const globalState = value.globalState;
  if (globalState && typeof globalState === "object") {
    return globalState;
  }

  return value;
}

function setAt3MddataFailSite(key, failSite) {
  if (!key) {
    return;
  }
  gAt3MddataFailSiteByKey.set(key, failSite | 0);
}

export function getAt3MddataFailSite(stateOrChannel = null) {
  const key = at3MddataFailSiteKey(stateOrChannel);
  if (!key) {
    return AT3_MDDATA_FAIL_NONE;
  }
  return (gAt3MddataFailSiteByKey.get(key) ?? AT3_MDDATA_FAIL_NONE) | 0;
}

export function encodeMddataAt3(transformed, specs, channel, prevChannel = null) {
  const failSiteKey = at3MddataFailSiteKey(channel);
  setAt3MddataFailSite(failSiteKey, AT3_MDDATA_FAIL_NONE);

  const unitBits = ((toInt(channel?.unitBytes ?? 0) << 3) >>> 0) | 0;
  const globalState = channel?.globalState ?? null;
  const mddataScratch = mddataScratchForChannel(globalState, channel);
  const itfLimits = ensureScratchBuffer(mddataScratch, "itfLimits", Int32Array, 8);
  itfLimits.fill(0);
  const maxIdwl = 0x07;
  const budgetState = initializeMddataBudgetState({
    transformed,
    specs,
    channel,
    unitBits,
    globalState,
    mddataScratch,
  });
  if (!budgetState) {
    return AT3_NBITS_ERROR;
  }
  const quantSpecs = channel.quantSpecs;

  // Phase 1: derive the search state for the non-tone mddata fit.
  const searchState = initializeMddataSearchState({
    specs,
    channel,
    prevChannel,
    ...budgetState,
    maxIdwl,
    itfLimits,
    mddataScratch,
  });
  if (!searchState) {
    return AT3_NBITS_ERROR;
  }

  // Phase 2: fit the remaining mddata budget, then spend any spare bits on refinement.
  const bitsAfterFit = fitMddataBitBudget({
    budgetState,
    searchState,
    specs,
    quantSpecs,
    globalState,
    failSiteKey,
  });
  if (bitsAfterFit === AT3_NBITS_ERROR) {
    return AT3_NBITS_ERROR;
  }

  return runMddataRefinementPipeline({
    channel,
    specs,
    unitBits,
    bitsAfterFit,
    budgetState,
    searchState,
    globalState,
    mddataScratch,
  });
}
