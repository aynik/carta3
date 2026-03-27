const AT5_GAINC_BAND_PAIR_VALUES = 2;
const AT5_GAINC_BAND_WINDOW_HISTORY_VALUES = 64;

function gaincBandPairOffset(band) {
  return band << 1;
}

function gaincBandWindowOffset(band) {
  return band * AT5_GAINC_BAND_WINDOW_HISTORY_VALUES;
}

function hasGaincBandPairHistory(history, band, TypedArrayCtor) {
  const pairEnd = gaincBandPairOffset(band) + AT5_GAINC_BAND_PAIR_VALUES;
  return history instanceof TypedArrayCtor && history.length >= pairEnd;
}

function hasGaincBandWindowHistory(history, band) {
  const windowEnd = gaincBandWindowOffset(band) + AT5_GAINC_BAND_WINDOW_HISTORY_VALUES;
  return history instanceof Float32Array && history.length >= windowEnd;
}

function hasGaincBandScalarHistory(history, band, TypedArrayCtor) {
  return history instanceof TypedArrayCtor && history.length > band;
}

function gaincBandPairView(history, band) {
  const offset = gaincBandPairOffset(band);
  return history.subarray(offset, offset + AT5_GAINC_BAND_PAIR_VALUES);
}

function gaincBandWindowHistoryView(history, band) {
  const offset = gaincBandWindowOffset(band);
  return history.subarray(offset, offset + AT5_GAINC_BAND_WINDOW_HISTORY_VALUES);
}

function getGaincBandHistory(block, band) {
  const pointGroupCountHistory = block?.pointGroupCountHistory ?? null;
  const disabledPointCountHistory = block?.disabledPointCountHistory ?? null;
  const gainLevelBoundsHistory = block?.gainLevelBoundsHistory ?? null;
  const peakIndexHistory = block?.peakIndexHistory ?? null;
  const peakValueHistory = block?.peakValueHistory ?? null;
  const windowAbsHistory = block?.windowAbsHistory ?? null;
  const windowScaleHistory = block?.windowScaleHistory ?? null;
  const trailingWindowPeakHistory = block?.trailingWindowPeakHistory ?? null;
  const duplicatePointCountHistory = block?.duplicatePointCountHistory ?? null;
  const gainPointHistoryBytes = block?.gainPointHistoryBytes ?? null;
  const stereoBandEnergyHistory = block?.stereoBandEnergyHistory ?? null;
  const stereoBandEnergyRatioHistory = block?.stereoBandEnergyRatioHistory ?? null;

  if (
    !hasGaincBandPairHistory(pointGroupCountHistory, band, Uint32Array) ||
    !hasGaincBandPairHistory(disabledPointCountHistory, band, Uint32Array) ||
    !hasGaincBandPairHistory(gainLevelBoundsHistory, band, Uint32Array) ||
    !hasGaincBandPairHistory(peakIndexHistory, band, Uint32Array) ||
    !hasGaincBandPairHistory(peakValueHistory, band, Float32Array) ||
    !hasGaincBandWindowHistory(windowAbsHistory, band) ||
    !hasGaincBandWindowHistory(windowScaleHistory, band) ||
    !hasGaincBandScalarHistory(trailingWindowPeakHistory, band, Float32Array) ||
    !hasGaincBandScalarHistory(duplicatePointCountHistory, band, Uint32Array) ||
    !(gainPointHistoryBytes instanceof Uint8Array) ||
    !hasGaincBandScalarHistory(stereoBandEnergyHistory, band, Float32Array) ||
    !hasGaincBandScalarHistory(stereoBandEnergyRatioHistory, band, Float32Array)
  ) {
    return null;
  }

  return {
    pointGroupCounts: gaincBandPairView(pointGroupCountHistory, band),
    disabledPointCounts: gaincBandPairView(disabledPointCountHistory, band),
    gainLevelBounds: gaincBandPairView(gainLevelBoundsHistory, band),
    peakIndices: gaincBandPairView(peakIndexHistory, band),
    peakValues: gaincBandPairView(peakValueHistory, band),
    windowAbs: gaincBandWindowHistoryView(windowAbsHistory, band),
    windowScale: gaincBandWindowHistoryView(windowScaleHistory, band),
    gainPointHistoryBytes,
    get trailingWindowPeak() {
      return trailingWindowPeakHistory[band] ?? 0;
    },
    set trailingWindowPeak(value) {
      trailingWindowPeakHistory[band] = value;
    },
    get duplicatePointCount() {
      return duplicatePointCountHistory[band] | 0;
    },
    set duplicatePointCount(value) {
      duplicatePointCountHistory[band] = value >>> 0;
    },
    get stereoBandEnergy() {
      return stereoBandEnergyHistory[band] ?? 0;
    },
    set stereoBandEnergy(value) {
      stereoBandEnergyHistory[band] = value;
    },
    get stereoBandEnergyRatio() {
      return stereoBandEnergyRatioHistory[band] ?? 0;
    },
    set stereoBandEnergyRatio(value) {
      stereoBandEnergyRatioHistory[band] = value;
    },
  };
}

function sharedAuxU32View(aux) {
  if (!aux) {
    return null;
  }
  if (aux instanceof Uint8Array) {
    return new Uint32Array(aux.buffer, aux.byteOffset, Math.floor(aux.byteLength / 4));
  }
  if (aux.buffer instanceof ArrayBuffer) {
    return new Uint32Array(aux.buffer);
  }
  if (aux.bytes instanceof Uint8Array) {
    return new Uint32Array(
      aux.bytes.buffer,
      aux.bytes.byteOffset,
      Math.floor(aux.bytes.byteLength / 4)
    );
  }
  return null;
}

export { getGaincBandHistory, sharedAuxU32View };
