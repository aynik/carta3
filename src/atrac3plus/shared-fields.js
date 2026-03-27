export function sharedMapSegmentCount(shared) {
  return (shared?.mapSegmentCount ?? 0) >>> 0;
}

export function sharedZeroSpectraFlag(shared) {
  return (shared?.zeroSpectraFlag ?? 0) >>> 0;
}

export function sharedHasZeroSpectra(shared) {
  return sharedZeroSpectraFlag(shared) !== 0;
}

export function sharedNoiseFillEnabled(shared) {
  return (shared?.noiseFillEnabled ?? 0) >>> 0;
}

export function sharedNoiseFillShift(shared) {
  return (shared?.noiseFillShift ?? 0) >>> 0;
}

export function sharedNoiseFillCursor(shared) {
  return (shared?.noiseFillCursor ?? 0) >>> 0;
}

export function sharedUsedBitCount(shared) {
  return (shared?.usedBitCount ?? 0) >>> 0;
}
