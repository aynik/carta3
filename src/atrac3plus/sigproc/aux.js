import {
  AT5_SIGPROC_AUX_BYTES,
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_CORR_SAMPLES,
  AT5_SIGPROC_MAX_CHANNELS,
  AT5_SIGPROC_SLOTS,
  AT5_SIGPROC_SUBSAMPLES,
} from "./constants.js";

const AUX_ROW_BANDS = AT5_SIGPROC_BANDS_MAX;
const AUX_ROW_BYTES = AUX_ROW_BANDS * Float32Array.BYTES_PER_ELEMENT;
const AUX_CORR_HISTORY_ROWS = 4;
const AUX_RESERVED_HISTORY_ROWS = 6;

function viewDescriptor(ViewType, offset, length) {
  return Object.freeze({
    ViewType,
    offset,
    length,
    byteLength: length * ViewType.BYTES_PER_ELEMENT,
  });
}

const AT5_SIGPROC_AUX_FIELDS = Object.freeze({
  intensityBand: viewDescriptor(Uint32Array, 0x000, 1),
  mode3ToneCount: viewDescriptor(Uint32Array, 0x000, 1),
  mode3ToneActiveFlags: viewDescriptor(Uint32Array, 0x004, AT5_SIGPROC_BANDS_MAX),
  corrMetric0Lead: viewDescriptor(Float32Array, 0x044, AUX_ROW_BANDS),
  corrHist0: viewDescriptor(Uint32Array, 0x044, AUX_ROW_BANDS),
  // Mode-3 tone values intentionally reuse the newest correlation row.
  mode3ToneValues: viewDescriptor(Float32Array, 0x084, AT5_SIGPROC_BANDS_MAX),
  corrMetric0Hist: viewDescriptor(Float32Array, 0x084, AUX_ROW_BANDS * AUX_CORR_HISTORY_ROWS),
  corrMetric1Hist: viewDescriptor(Float32Array, 0x184, AUX_ROW_BANDS * AUX_CORR_HISTORY_ROWS),
  corrMetric2Hist: viewDescriptor(Float32Array, 0x284, AUX_ROW_BANDS * AUX_CORR_HISTORY_ROWS),
  corrFlagsHist: viewDescriptor(Uint32Array, 0x384, AUX_ROW_BANDS * AUX_CORR_HISTORY_ROWS),
  reservedHist: viewDescriptor(Uint32Array, 0x484, AUX_ROW_BANDS * AUX_RESERVED_HISTORY_ROWS),
  // Flip hints occupy reserved history row 1 so the shift path can preserve older values.
  mode3FlipValues: viewDescriptor(Float32Array, 0x4c4, AT5_SIGPROC_BANDS_MAX),
  dbDiff: viewDescriptor(Float32Array, 0x604, AT5_SIGPROC_BANDS_MAX),
  mixHist: viewDescriptor(Float32Array, 0x644, AUX_ROW_BANDS * 5),
  scalePrev: viewDescriptor(Float32Array, 0x784, AUX_ROW_BANDS * 2),
  scaleCur: viewDescriptor(Float32Array, 0x804, AUX_ROW_BANDS * 2),
});

function createAt5SigprocScratch() {
  const slot8BandPtrs = Array.from({ length: AT5_SIGPROC_MAX_CHANNELS }, () =>
    new Array(AT5_SIGPROC_BANDS_MAX).fill(null)
  );

  return {
    activeStates: new Array(AT5_SIGPROC_MAX_CHANNELS).fill(null),
    bandPtrTable: new Array(
      AT5_SIGPROC_SLOTS * AT5_SIGPROC_MAX_CHANNELS * AT5_SIGPROC_BANDS_MAX
    ).fill(null),
    slot8BandPtrs,

    slot1Left: new Array(AT5_SIGPROC_BANDS_MAX).fill(null),
    slot1Right: new Array(AT5_SIGPROC_BANDS_MAX).fill(null),

    prevBufs: new Array(AT5_SIGPROC_MAX_CHANNELS).fill(null),
    curBufs: new Array(AT5_SIGPROC_MAX_CHANNELS).fill(null),

    corr: {
      diffBuf: new Float32Array(AT5_SIGPROC_CORR_SAMPLES),
      powers: { ab: 0, cd: 0, ef: 0 },
    },
    dbDiff: {
      diffBuf: new Float32Array(AT5_SIGPROC_SUBSAMPLES),
      powers: { ab: 0, cd: 0, ef: 0 },
    },
    intensity: {
      weights: new Float32Array(AT5_SIGPROC_BANDS_MAX),
      diffBuf: new Float32Array(AT5_SIGPROC_SUBSAMPLES * 2),
      addBuf: new Float32Array(AT5_SIGPROC_SUBSAMPLES * 2),
      newScale: new Float32Array(32),
      powerDual: { ab: 0, cd: 0 },
      powerL: new Float32Array(3),
      powerR: new Float32Array(3),
    },

    // Shared scratch used by low-mode time2freq gain overflow mitigation.
    t2fMaxima: {
      maxPre: new Float32Array(32),
      maxPost: new Float32Array(32),
    },
  };
}

function auxSource(value) {
  if (!value) {
    return null;
  }
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value.bytes instanceof Uint8Array ||
    value.buffer instanceof ArrayBuffer
  ) {
    return value;
  }

  const header = value?.header ?? value ?? null;
  return header?.sharedAux ?? value.sharedAux ?? header?.aux ?? value.aux ?? null;
}

function viewBytes(valueOrBlock) {
  const aux = auxSource(valueOrBlock);
  if (!aux) {
    return null;
  }

  if (aux instanceof ArrayBuffer) {
    return new Uint8Array(aux);
  }
  if (aux instanceof Uint8Array) {
    return aux;
  }
  if (ArrayBuffer.isView(aux)) {
    return new Uint8Array(aux.buffer, aux.byteOffset, aux.byteLength);
  }
  if (aux?.bytes instanceof Uint8Array) {
    return aux.bytes;
  }
  if (aux?.buffer instanceof ArrayBuffer) {
    const byteOffset = aux.byteOffset ?? 0;
    const byteLength = aux.byteLength ?? aux.buffer.byteLength - byteOffset;
    return new Uint8Array(aux.buffer, byteOffset, byteLength);
  }
  return null;
}

function createTypedView(buffer, descriptor) {
  return new descriptor.ViewType(buffer, descriptor.offset, descriptor.length);
}

function typedViewFromAux(aux, fieldName) {
  const descriptor = AT5_SIGPROC_AUX_FIELDS[fieldName];
  if (!descriptor) {
    return null;
  }

  if (aux?.[fieldName] instanceof descriptor.ViewType) {
    return aux[fieldName];
  }

  const bytes = viewBytes(aux);
  if (!bytes) {
    return null;
  }

  return new descriptor.ViewType(
    bytes.buffer,
    bytes.byteOffset + descriptor.offset,
    descriptor.length
  );
}

function createFieldViews(buffer) {
  const fields = {};
  for (const [fieldName, descriptor] of Object.entries(AT5_SIGPROC_AUX_FIELDS)) {
    fields[fieldName] = createTypedView(buffer, descriptor);
  }
  return fields;
}

function pickTypedViews(aux, fieldNames) {
  const views = {};
  for (const fieldName of fieldNames) {
    views[fieldName] = typedViewFromAux(aux, fieldName);
  }
  return views;
}

function shiftHistoryRows(bytes, fieldName, rowCount) {
  const descriptor = AT5_SIGPROC_AUX_FIELDS[fieldName];
  if (!descriptor) {
    return;
  }

  const targetOffset = descriptor.offset;
  const sourceOffset = targetOffset + AUX_ROW_BYTES;
  const endOffset = targetOffset + rowCount * AUX_ROW_BYTES;
  bytes.copyWithin(targetOffset, sourceOffset, endOffset);
  bytes.fill(0, endOffset - AUX_ROW_BYTES, endOffset);
}

export function createAt5SigprocAux() {
  const buffer = new ArrayBuffer(AT5_SIGPROC_AUX_BYTES);
  const bytes = new Uint8Array(buffer);
  return {
    buffer,
    bytes,
    ...createFieldViews(buffer),
    scratch: createAt5SigprocScratch(),
  };
}

export function at5SigprocMode3Views(aux) {
  const views = pickTypedViews(aux, [
    "mode3ToneCount",
    "mode3ToneActiveFlags",
    "mode3ToneValues",
    "mode3FlipValues",
  ]);
  return {
    toneCount: views.mode3ToneCount,
    toneActiveFlags: views.mode3ToneActiveFlags,
    toneValues: views.mode3ToneValues,
    flipValues: views.mode3FlipValues,
  };
}

export function at5SigprocCorrHistoryViews(aux) {
  const views = pickTypedViews(aux, [
    "corrMetric0Lead",
    "corrHist0",
    "corrMetric0Hist",
    "corrMetric1Hist",
    "corrMetric2Hist",
    "corrFlagsHist",
  ]);
  return {
    metric0Lead: views.corrMetric0Lead,
    metric0LeadBits: views.corrHist0,
    metric0: views.corrMetric0Hist,
    metric1: views.corrMetric1Hist,
    metric2: views.corrMetric2Hist,
    flags: views.corrFlagsHist,
  };
}

export function at5SigprocIntensityBandView(aux) {
  return typedViewFromAux(aux, "intensityBand");
}

export function at5SigprocTime2freqBandFlagsView(aux) {
  // Low-mode time2freq still depends on this shared band-flag row carrying state
  // between passes; moving it to private scratch regressed low-rate stereo/ch6 output.
  return typedViewFromAux(aux, "mode3ToneActiveFlags");
}

export function at5SigprocBandRow(view, row) {
  if (!view) {
    return null;
  }

  const start = row * AUX_ROW_BANDS;
  return view.subarray(start, start + AUX_ROW_BANDS);
}

export function at5SigprocShiftAux(aux) {
  const bytes = viewBytes(aux);
  if (!bytes) {
    return;
  }

  const corrLead = AT5_SIGPROC_AUX_FIELDS.corrHist0;
  const corrMetric0 = AT5_SIGPROC_AUX_FIELDS.corrMetric0Hist;
  bytes.set(
    bytes.subarray(corrMetric0.offset, corrMetric0.offset + AUX_ROW_BYTES),
    corrLead.offset
  );

  shiftHistoryRows(bytes, "corrMetric0Hist", AUX_CORR_HISTORY_ROWS);
  shiftHistoryRows(bytes, "corrMetric1Hist", AUX_CORR_HISTORY_ROWS);
  shiftHistoryRows(bytes, "corrMetric2Hist", AUX_CORR_HISTORY_ROWS);
  shiftHistoryRows(bytes, "corrFlagsHist", AUX_CORR_HISTORY_ROWS);

  const reservedHistory = AT5_SIGPROC_AUX_FIELDS.reservedHist;
  const flipHistory = AT5_SIGPROC_AUX_FIELDS.mode3FlipValues;
  const dbDiff = AT5_SIGPROC_AUX_FIELDS.dbDiff;
  // This history window spans reserved rows 1-5 plus the db-diff scratch row.
  bytes.copyWithin(
    reservedHistory.offset,
    flipHistory.offset,
    flipHistory.offset + reservedHistory.byteLength
  );
  bytes.fill(0, dbDiff.offset, dbDiff.offset + dbDiff.byteLength);
}
