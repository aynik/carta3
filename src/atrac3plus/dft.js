/**
 * Real-valued DFT helpers used by ATRAC3plus time-domain analysis stages.
 */
import { AT5_SC016, AT5_SC032, AT5_SC064, AT5_SC128, AT5_SC256 } from "./tables/encode-init.js";

function reverseBits(v, bitCount) {
  let out = 0;
  let x = v >>> 0;
  for (let i = 0; i < (bitCount | 0); i += 1) {
    out = ((out << 1) | (x & 1)) >>> 0;
    x >>>= 1;
  }
  return out >>> 0;
}

function bitReverseComplexPairs(a, n) {
  const complexCount = (n | 0) >> 1;
  if (complexCount <= 2) {
    return;
  }

  let bitCount = 0;
  for (let v = complexCount; v > 1; v >>= 1) {
    bitCount += 1;
  }

  for (let i = 0; i < complexCount; i += 1) {
    const j = reverseBits(i >>> 0, bitCount) | 0;
    if (j <= i) {
      continue;
    }

    const i0 = i << 1;
    const j0 = j << 1;
    const tmpRe = a[i0 + 0];
    const tmpIm = a[i0 + 1];
    a[i0 + 0] = a[j0 + 0];
    a[i0 + 1] = a[j0 + 1];
    a[j0 + 0] = tmpRe;
    a[j0 + 1] = tmpIm;
  }
}

function rdftvAt5(n, a, sc) {
  const nn = n | 0;
  if (nn <= 8) {
    return;
  }

  bitReverseComplexPairs(a, nn);

  {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    const a4 = a[4];
    const a5 = a[5];
    const a6 = a[6];
    const a7 = a[7];

    const t0 = a0 + a2;
    const t1 = a1 + a3;
    const t2 = a1 - a3;
    const t3 = a4 + a6;
    const t4 = a5 + a7;
    const t5 = a5 - a7;
    const t6 = a0 - a2;
    const t7 = a4 - a6;

    a[0] = t0 + t3;
    a[1] = t1 + t4;
    a[4] = t0 - t3;
    a[5] = t1 - t4;
    a[2] = t6 - t5;
    a[3] = t2 + t7;
    a[6] = t5 + t6;
    a[7] = t2 - t7;
  }

  {
    const wn4 = sc[2];

    const a8 = a[8];
    const a9 = a[9];
    const a10 = a[10];
    const a11 = a[11];
    const a12 = a[12];
    const a13 = a[13];
    const a14 = a[14];
    const a15 = a[15];

    const t0 = a8 + a10;
    const t1 = a9 + a11;
    const t2 = a9 - a11;
    const t3 = a8 - a10;
    const t4 = a14 + a12;
    const t5 = a13 + a15;
    const t6 = a13 - a15;
    const t7 = a12 - a14;

    a[8] = t0 + t4;
    a[9] = t1 + t5;
    a[12] = t5 - t1;

    const u0 = t2 + t7;
    const u1 = t3 - t6;
    a[13] = t0 - t4;

    const u2 = t7 - t2;
    const u3 = t6 + t3;
    a[10] = (u1 - u0) * wn4;
    a[11] = (u1 + u0) * wn4;
    a[14] = (u2 - u3) * wn4;
    a[15] = (u2 + u3) * wn4;
  }

  if (nn > 0x10) {
    let tw = 0;
    for (let base = 0x10; base < nn; base += 0x10, tw += 2) {
      const k = (tw + 2) | 0;

      const wk1i = sc[tw + 3];
      const wk1r = sc[k];

      const wk2i = sc[k * 2 + 1];
      const wk2r = sc[k * 2];
      const wk3r = wk2r - wk2i * (wk1i + wk1i);
      const wk3i = (wk1i + wk1i) * wk2r - wk2i;

      const xBase = base | 0;

      {
        const x0 = a[xBase + 0];
        const x1 = a[xBase + 1];
        const x2 = a[xBase + 2];
        const x3 = a[xBase + 3];
        const x4 = a[xBase + 4];
        const x5 = a[xBase + 5];
        const x6 = a[xBase + 6];
        const x7 = a[xBase + 7];

        const sum13 = x1 + x3;
        const diff13 = x1 - x3;
        const sum57 = x5 + x7;
        const diff57 = x5 - x7;

        const sum0246 = x0 + x2 + x4 + x6;
        const tmp14 = sum13 - sum57;

        a[xBase + 0] = sum0246;
        a[xBase + 1] = sum13 + sum57;

        const tmp06 = x0 + x2 - (x4 + x6);
        const tmp11 = x0 - x2 + diff57;
        const tmp13 = diff13 - (x4 - x6);
        const tmp15 = x0 - x2 - diff57;
        const tmp12 = diff13 + (x4 - x6);

        a[xBase + 4] = wk1r * tmp06 - wk1i * tmp14;
        a[xBase + 5] = wk1r * tmp14 + wk1i * tmp06;
        a[xBase + 2] = wk2r * tmp15 - wk2i * tmp12;
        a[xBase + 3] = wk2i * tmp15 + wk2r * tmp12;
        a[xBase + 6] = wk3r * tmp11 - wk3i * tmp13;
        a[xBase + 7] = wk3r * tmp13 + wk3i * tmp11;
      }

      const wk2iB = sc[k * 2 + 3];
      const wk2rB = sc[k * 2 + 2];
      const wk3rB = wk2rB - wk2iB * (wk1r + wk1r);
      const wk3iB = (wk1r + wk1r) * wk2rB - wk2iB;

      {
        const x8 = a[xBase + 8];
        const x9 = a[xBase + 9];
        const x10 = a[xBase + 10];
        const x11 = a[xBase + 11];
        const x12 = a[xBase + 12];
        const x13 = a[xBase + 13];
        const x14 = a[xBase + 14];
        const x15 = a[xBase + 15];

        const sum9b = x9 + x11;
        const diff9b = x9 - x11;
        const sumdf = x13 + x15;
        const diffdf = x13 - x15;

        const tmp15 = sum9b - sumdf;
        const sum8ace = x8 + x10 + x12 + x14;
        const tmp16 = diff9b - (x12 - x14);

        a[xBase + 8] = sum8ace;
        a[xBase + 9] = sum9b + sumdf;

        const tmp06 = x8 + x10 - (x12 + x14);
        const tmp11 = x8 - x10 - diffdf;
        const tmp12 = diff9b + (x12 - x14);
        const tmp14 = x8 - x10 + diffdf;

        a[xBase + 12] = -wk1i * tmp06 - wk1r * tmp15;
        a[xBase + 13] = -wk1i * tmp15 + wk1r * tmp06;
        a[xBase + 10] = wk2rB * tmp11 - wk2iB * tmp12;
        a[xBase + 11] = wk2iB * tmp11 + wk2rB * tmp12;
        a[xBase + 14] = wk3rB * tmp14 - wk3iB * tmp16;
        a[xBase + 15] = wk3rB * tmp16 + wk3iB * tmp14;
      }
    }
  }

  let l = 8;
  if (nn > 0x20) {
    let keepGoing = 0;
    do {
      const oldL = l | 0;
      const m = (oldL * 4) | 0;

      if (oldL > 0) {
        const seg1 = oldL;
        const seg2 = (oldL * 2) | 0;
        const seg3 = (oldL * 3) | 0;
        for (let j = 0; j < oldL; j += 2) {
          const a0r = a[j];
          const a0i = a[j + 1];
          const a1r = a[seg1 + j];
          const a1i = a[seg1 + j + 1];
          const a2r = a[seg2 + j];
          const a2i = a[seg2 + j + 1];
          const a3r = a[seg3 + j];
          const a3i = a[seg3 + j + 1];

          const p0r = a0r + a1r;
          const p0i = a0i + a1i;
          const p1r = a0r - a1r;
          const p1i = a0i - a1i;
          const p2r = a2r + a3r;
          const p2i = a2i + a3i;
          const p3i = a2i - a3i;
          const p3r = a2r - a3r;

          a[j] = p0r + p2r;
          a[j + 1] = p0i + p2i;
          a[seg2 + j] = p0r - p2r;
          a[seg2 + j + 1] = p0i - p2i;
          a[seg1 + j] = p1r - p3i;
          a[seg1 + j + 1] = p1i + p3r;
          a[seg3 + j] = p3i + p1r;
          a[seg3 + j + 1] = p1i - p3r;
        }
      }

      {
        const wn4 = sc[2];

        const b0 = m;
        const b1 = (b0 + oldL) | 0;
        const b2 = (b1 + oldL) | 0;
        const b3 = (b2 + oldL) | 0;

        for (let j = 0; j < oldL; j += 2) {
          const s0r = a[b0 + j] + a[b1 + j];
          const d0r = a[b0 + j] - a[b1 + j];
          const s0i = a[b0 + j + 1] + a[b1 + j + 1];
          const d0i = a[b0 + j + 1] - a[b1 + j + 1];
          const s2r = a[b2 + j] + a[b3 + j];
          const s2i = a[b2 + j + 1] + a[b3 + j + 1];
          const d2i = a[b2 + j + 1] - a[b3 + j + 1];
          const d2r = a[b2 + j] - a[b3 + j];

          a[b0 + j] = s0r + s2r;
          a[b0 + j + 1] = s0i + s2i;
          a[b2 + j] = s2i - s0i;
          a[b2 + j + 1] = s0r - s2r;

          const t0 = d0r - d2i;
          const t1 = d0i + d2r;
          const t2 = d2i + d0r;
          const t3 = d2r - d0i;

          a[b1 + j] = (t0 - t1) * wn4;
          a[b1 + j + 1] = (t1 + t0) * wn4;
          a[b3 + j] = (t3 - t2) * wn4;
          a[b3 + j + 1] = (t2 + t3) * wn4;
        }
      }

      const step = (oldL * 8) | 0;
      let idx = 2;
      for (let base = step; base < nn; base += step, idx += 2) {
        const wk1r = sc[idx];
        const wk1i = sc[idx + 1];

        const wk2i = sc[idx * 2 + 1];
        const wk2r = sc[idx * 2];
        const wk3r = wk2r - (wk1i + wk1i) * wk2i;
        const wk3i = (wk1i + wk1i) * wk2r - wk2i;

        const p0 = base | 0;
        const p1 = (p0 + oldL) | 0;
        const p2 = (p1 + oldL) | 0;
        const p3 = (p2 + oldL) | 0;

        for (let j = 0; j < oldL; j += 2) {
          const a01r = a[p0 + j] + a[p1 + j];
          const x2r = a[p2 + j];
          const a01i = a[p0 + j + 1] + a[p1 + j + 1];
          const d01i = a[p0 + j + 1] - a[p1 + j + 1];
          const a23r = a[p3 + j] + x2r;
          const d01r = a[p0 + j] - a[p1 + j];
          const a23i = a[p2 + j + 1] + a[p3 + j + 1];
          const d23i = a[p2 + j + 1] - a[p3 + j + 1];
          const x3r = a[p3 + j];

          a[p0 + j] = a01r + a23r;
          a[p0 + j + 1] = a01i + a23i;

          const t0r = a01r - a23r;
          const t0i = a01i - a23i;
          const d23r = x2r - x3r;

          a[p2 + j] = wk1r * t0r - wk1i * t0i;
          a[p2 + j + 1] = wk1r * t0i + wk1i * t0r;

          const tmp9 = d01i + d23r;
          const tmp12 = d01i - d23r;
          const tmp8 = d01r - d23i;
          const tmp13 = d23i + d01r;

          a[p1 + j] = wk2r * tmp8 - wk2i * tmp9;
          a[p1 + j + 1] = wk2r * tmp9 + wk2i * tmp8;
          a[p3 + j] = wk3r * tmp13 - wk3i * tmp12;
          a[p3 + j + 1] = wk3i * tmp13 + wk3r * tmp12;
        }

        const wk2rB = sc[idx * 2 + 2];
        const wk2iB = sc[idx * 2 + 3];
        const wk3rB = wk2rB - (wk1r + wk1r) * wk2iB;
        const wk3iB = (wk1r + wk1r) * wk2rB - wk2iB;

        const q0 = (p0 + m) | 0;
        const q1 = (q0 + oldL) | 0;
        const q2 = (q1 + oldL) | 0;
        const q3 = (q2 + oldL) | 0;

        for (let j = 0; j < oldL; j += 2) {
          const a01r = a[q0 + j] + a[q1 + j];
          const d01r = a[q0 + j] - a[q1 + j];
          const a01i = a[q0 + j + 1] + a[q1 + j + 1];
          const d01i = a[q0 + j + 1] - a[q1 + j + 1];

          const a23r = a[q3 + j] + a[q2 + j];
          const a23i = a[q2 + j + 1] + a[q3 + j + 1];
          const d23i = a[q2 + j + 1] - a[q3 + j + 1];
          const d23r = a[q2 + j] - a[q3 + j];

          const t0r = a01r - a23r;

          a[q0 + j] = a01r + a23r;
          a[q0 + j + 1] = a01i + a23i;

          const t0i = a01i - a23i;

          a[q2 + j] = -wk1i * t0r - wk1r * t0i;
          a[q2 + j + 1] = -wk1i * t0i + wk1r * t0r;

          const tmp8 = d01i + d23r;
          const tmp10 = d01r - d23i;
          const tmp16 = d23i + d01r;
          const tmp11 = d01i - d23r;

          a[q1 + j] = wk2rB * tmp10 - wk2iB * tmp8;
          a[q1 + j + 1] = wk2rB * tmp8 + wk2iB * tmp10;
          a[q3 + j] = wk3rB * tmp16 - wk3iB * tmp11;
          a[q3 + j + 1] = wk3rB * tmp11 + wk3iB * tmp16;
        }
      }

      l = m;
      keepGoing = oldL << 4 < nn ? 1 : 0;
    } while (keepGoing);
  }

  if (l * 4 === nn) {
    const a1 = l;
    const a2 = (l * 2) | 0;
    const a3 = (l * 3) | 0;
    for (let i = 0; i < l; i += 2) {
      const a0e = a[i];
      const a0o = a[i + 1];
      const a1e = a[a1 + i];
      const a1o = a[a1 + i + 1];
      const a2e = a[a2 + i];
      const a2o = a[a2 + i + 1];
      const a3e = a[a3 + i];
      const a3o = a[a3 + i + 1];
      a[i] = a0e + a1e + a2e + a3e;
      a[i + 1] = a0o + a1o + a2o + a3o;
      a[a1 + i] = a0e - a1e - a2o + a3o;
      a[a1 + i + 1] = a0o - a1o + a2e - a3e;
      a[a2 + i] = a0e + a1e - a2e - a3e;
      a[a2 + i + 1] = a0o + a1o - a2o - a3o;
      a[a3 + i] = a0e - a1e + a2o - a3o;
      a[a3 + i + 1] = a0o - a1o - a2e + a3e;
    }
  } else {
    const a1 = l;
    for (let i = 0; i < l; i += 2) {
      const a0e = a[i];
      const a0o = a[i + 1];
      const a1e = a[a1 + i];
      const a1o = a[a1 + i + 1];
      a[i] = a0e + a1e;
      a[i + 1] = a0o + a1o;
      a[a1 + i] = a0e - a1e;
      a[a1 + i + 1] = a0o - a1o;
    }
  }

  const half = 0.5;
  const halfCount = nn >> 1;
  let lo = (nn >> 2) + 1;
  let hi = halfCount - 1;

  for (let i = 2; i < halfCount; i += 2, lo += 1, hi -= 1) {
    const j = nn - i;
    const re = i;
    const im = i + 1;

    const xr = a[re] - a[j];
    const xi = a[im] + a[j + 1];

    const wr = half - sc[hi];
    const wi = sc[lo];

    const yr = wr * xr - wi * xi;
    const yi = wr * xi + wi * xr;

    a[re] = a[re] - yr;
    a[im] = a[im] - yi;
    a[j] = a[j] + yr;
    a[j + 1] = a[j + 1] - yi;
  }

  const t = a[1];
  a[1] = a[0] - t;
  a[0] = a[0] + t;
}

function magPair(re, im) {
  const sum = re * re + im * im;
  return Math.sqrt(sum);
}

function scTableForN(n) {
  const nn = n | 0;
  if (nn === 0x10) {
    return AT5_SC016;
  }
  if (nn === 0x20) {
    return AT5_SC032;
  }
  if (nn === 0x40) {
    return AT5_SC064;
  }
  if (nn === 0x80) {
    return AT5_SC128;
  }
  if (nn === 0x100) {
    return AT5_SC256;
  }
  return null;
}

export function dftXAt5(src, n, dst, srcOffset = 0, scratch = null) {
  const nn = n | 0;
  const off = srcOffset | 0;
  const buf =
    scratch instanceof Float32Array && scratch.length >= 0x100 ? scratch : new Float32Array(0x100);

  buf.fill(0);
  if (nn > 0) {
    const copyCount = Math.min(nn, 0x100);
    buf.set(src.subarray(off, off + copyCount), 0);
  }

  rdftvAt5(0x100, buf, AT5_SC256);

  const nyquist = buf[1];
  buf[1] = 0;

  for (let i = 0; i < 0x80; i += 1) {
    const re = buf[i * 2];
    const im = buf[i * 2 + 1];
    dst[i] = re * re + im * im;
  }

  dst[0x80] = nyquist * nyquist;
}

export function dftVAt5(src, stride, n, dst, srcOffset = 0, scratch = null) {
  const nn = n | 0;
  const st = stride | 0;
  const off = srcOffset | 0;
  const buf =
    scratch instanceof Float32Array && scratch.length >= 0x100 ? scratch : new Float32Array(0x100);

  buf.fill(0);
  if (nn > 0) {
    if (st === 1) {
      buf.set(src.subarray(off, off + nn), 0);
    } else {
      let cur = off;
      for (let i = 0; i < nn; i += 1) {
        buf[i] = src[cur] ?? 0;
        cur += st;
      }
    }
  }

  const sc = scTableForN(nn);
  if (sc) {
    rdftvAt5(nn, buf, sc);
  }

  const half = nn >> 1;
  const nyquist = buf[1];

  if (half > 0) {
    buf[1] = 0;
    for (let i = 0; i < half; i += 1) {
      dst[i] = magPair(buf[i * 2], buf[i * 2 + 1]);
    }
  }

  dst[half] = Math.abs(nyquist);
}
