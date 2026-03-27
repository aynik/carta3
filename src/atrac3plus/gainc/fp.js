// Floating-point helpers shared by ATRAC3plus gain-control.

export function fmaF32(a, b, c) {
  return a * b + c;
}

// Ordered comparisons (false when either is NaN)
export function fGt(a, b) {
  return a === a && b === b && a > b;
}
export function fLt(a, b) {
  return a === a && b === b && a < b;
}
export function fLe(a, b) {
  return a === a && b === b && a <= b;
}
export function fGe(a, b) {
  return a === a && b === b && a >= b;
}

export function pow2Int(exp) {
  const base = 2 ** (Math.abs(exp) & 31);
  return exp < 0 ? 1 / base : base;
}

export const LOG2E = 1.442695021629333;
export const LOG2E_F32 = 1.4426950216293335;

export function nearbyintEven(v) {
  const fl = Math.floor(v);
  const frac = v - fl;
  if (frac < 0.5) return fl;
  if (frac > 0.5) return fl + 1;
  return (fl & 1) === 0 ? fl : fl + 1;
}
