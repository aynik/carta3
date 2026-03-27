export function roundDivU32(numerator, denom) {
  if (!Number.isFinite(numerator) || numerator < 0) {
    throw new RangeError(`invalid numerator: ${numerator}`);
  }
  if (!Number.isFinite(denom) || denom <= 0) {
    throw new RangeError(`invalid denom: ${denom}`);
  }
  const rounded = Math.floor((numerator + Math.floor(denom / 2)) / denom);
  if (!Number.isFinite(rounded) || rounded < 0 || rounded > 0xffffffff) {
    throw new RangeError(`roundDivU32 overflow: ${rounded}`);
  }
  return rounded >>> 0;
}

export function roundToEvenI32(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const negative = value < 0;
  const magnitude = negative ? -value : value;
  let rounded = Math.floor(magnitude + 0.5);
  if (rounded - magnitude === 0.5 && (rounded & 1) === 1) {
    rounded -= 1;
  }

  return negative ? -rounded : rounded;
}
