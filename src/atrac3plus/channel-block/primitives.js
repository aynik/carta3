export function clampI32(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function at5RoundHalfUp(value) {
  return Math.trunc(value + 0.5);
}

export function at5AbsI32(value) {
  return Math.abs(value | 0);
}

export function at5U16(value) {
  return value & 0xffff;
}

export function at5S16(value) {
  const wrapped = value & 0xffff;
  return wrapped >= 0x8000 ? wrapped - 0x10000 : wrapped;
}

export function toggleF32SignInPlace(values, start, end) {
  const lo = Math.max(0, start | 0);
  const hi = Math.max(lo, Math.min(values.length | 0, end | 0));
  for (let i = lo; i < hi; i += 1) {
    values[i] = -values[i];
  }
}

const AT5_PACK_MEASURE_BYTES = 0x2000;
const AT5_PACK_MEASURE_BITS = AT5_PACK_MEASURE_BYTES * 8;
const gPackMeasureBytes = new Uint8Array(AT5_PACK_MEASURE_BYTES);
const gPackMeasureState = { bitpos: 0 };

export function at5MeasurePackBits(packFn, ctx) {
  gPackMeasureBytes.fill(0);
  gPackMeasureState.bitpos = 0;
  const ok = packFn(ctx, gPackMeasureBytes, gPackMeasureState);
  const bitpos = gPackMeasureState.bitpos >>> 0;
  if (ok === false || bitpos > AT5_PACK_MEASURE_BITS) {
    return AT5_PACK_MEASURE_BITS;
  }
  return bitpos | 0;
}
