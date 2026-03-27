function maxAbsWindow(src, count) {
  const n = count | 0;
  if (n <= 0) {
    return 0;
  }
  let maxV = Math.abs(src[0] ?? 0);
  for (let i = 1; i < n; i += 1) {
    const v = Math.abs(src[i] ?? 0);
    if (v > maxV) {
      maxV = v;
    }
  }
  return maxV;
}

const AT5_GATE_PRE_WINDOW_OFFSET = 0x40;
const AT5_GATE_PRE_WINDOW_LENGTH = 0x40;
const AT5_GATE_PRE_END_OFFSET = 0x78;
const AT5_GATE_PRE_END_LENGTH = 8;
const AT5_GATE_GROUP_WINDOW_OFFSET = 0x80;
const AT5_GATE_GROUP_COUNT = 0x20;
const AT5_GATE_GROUP_STRIDE = 4;
const AT5_GATE_FUTURE_WINDOW_OFFSET = 0x100;
const AT5_GATE_FUTURE_WINDOW_LENGTH = 0x40;
const AT5_GATE_FUTURE_START_LENGTH = 4;

function ensureF32(value, length) {
  if (value instanceof Float32Array && value.length === length) {
    return value;
  }
  return new Float32Array(length);
}

export function analysisComputeGate(samples, state, four, zero) {
  if (!state || typeof state !== "object") {
    return;
  }

  const preMax = maxAbsWindow(
    samples.subarray(
      AT5_GATE_PRE_WINDOW_OFFSET,
      AT5_GATE_PRE_WINDOW_OFFSET + AT5_GATE_PRE_WINDOW_LENGTH
    ),
    AT5_GATE_PRE_WINDOW_LENGTH
  );
  const preEndMax = maxAbsWindow(
    samples.subarray(AT5_GATE_PRE_END_OFFSET, AT5_GATE_PRE_END_OFFSET + AT5_GATE_PRE_END_LENGTH),
    AT5_GATE_PRE_END_LENGTH
  );
  const futureMax = maxAbsWindow(
    samples.subarray(
      AT5_GATE_FUTURE_WINDOW_OFFSET,
      AT5_GATE_FUTURE_WINDOW_OFFSET + AT5_GATE_FUTURE_WINDOW_LENGTH
    ),
    AT5_GATE_FUTURE_WINDOW_LENGTH
  );
  const futureStartMax = maxAbsWindow(
    samples.subarray(
      AT5_GATE_FUTURE_WINDOW_OFFSET,
      AT5_GATE_FUTURE_WINDOW_OFFSET + AT5_GATE_FUTURE_START_LENGTH
    ),
    AT5_GATE_FUTURE_START_LENGTH
  );

  const scratch = state && typeof state === "object" ? state : null;
  const gateScratch =
    scratch && scratch.gateScratch && typeof scratch.gateScratch === "object"
      ? scratch.gateScratch
      : scratch
        ? (scratch.gateScratch = {})
        : null;
  const groupMax = ensureF32(gateScratch?.groupMax, AT5_GATE_GROUP_COUNT);
  const attackRatio = ensureF32(gateScratch?.attackRatio, AT5_GATE_GROUP_COUNT);
  const pairMax = ensureF32(gateScratch?.pairMax, AT5_GATE_GROUP_COUNT);
  const releaseRatio = ensureF32(gateScratch?.releaseRatio, AT5_GATE_GROUP_COUNT);
  if (gateScratch) {
    gateScratch.groupMax = groupMax;
    gateScratch.attackRatio = attackRatio;
    gateScratch.pairMax = pairMax;
    gateScratch.releaseRatio = releaseRatio;
  }
  attackRatio.fill(0);
  releaseRatio.fill(0);

  for (let g = 0; g < AT5_GATE_GROUP_COUNT; g += 1) {
    const base = AT5_GATE_GROUP_WINDOW_OFFSET + g * AT5_GATE_GROUP_STRIDE;
    let maxV = Math.abs(samples[base + 0] ?? 0);
    for (let i = 1; i < AT5_GATE_GROUP_STRIDE; i += 1) {
      const v = Math.abs(samples[base + i] ?? 0);
      if (v > maxV) {
        maxV = v;
      }
    }
    groupMax[g] = maxV;
  }

  let peak = zero;
  let peakGroup = 0;
  for (let g = 0; g < AT5_GATE_GROUP_COUNT; g += 1) {
    const v = groupMax[g];
    if (v > peak) {
      peak = v;
      peakGroup = g;
    }
  }

  let pivot = peakGroup | 0;
  if (futureMax > peak) {
    pivot = AT5_GATE_GROUP_COUNT;
  }

  let running = preMax;
  for (let g = 0; g < AT5_GATE_GROUP_COUNT; g += 1) {
    const v = groupMax[g];
    if (v > running) {
      running = v;
    }

    const threshold = four * running;
    if (g < AT5_GATE_GROUP_COUNT - 1) {
      const next = groupMax[g + 1];
      if (next > threshold && peak > zero) {
        attackRatio[g] = v / peak;
      }
    } else {
      if (futureStartMax > threshold && peak > zero) {
        attackRatio[g] = v / futureStartMax;
      }
    }
  }

  let gateStartValid = 0;
  let gateStartIdx = -1;
  if (pivot > 0) {
    for (let g = 0; g < pivot; g += 1) {
      if (attackRatio[g] > zero) {
        gateStartValid = 1;
        gateStartIdx = g;
      }
    }
    if (gateStartValid) {
      if (gateStartIdx < AT5_GATE_GROUP_COUNT - 2) {
        gateStartIdx += 2;
      } else if (gateStartIdx < AT5_GATE_GROUP_COUNT - 1) {
        gateStartIdx += 1;
      }
    }
  }

  if (preMax > peak) {
    pivot = 0;
  }

  for (let g = 0; g < AT5_GATE_GROUP_COUNT; g += 2) {
    const even = groupMax[g];
    const odd = groupMax[g + 1];
    const chosen = odd > even ? odd : even;
    pairMax[g] = chosen;
    pairMax[g + 1] = chosen;
  }

  let tailMax = futureMax;
  if (pivot < AT5_GATE_GROUP_COUNT) {
    for (let g = 0x1f; g >= pivot; g -= 1) {
      const cur = pairMax[g];
      if (cur > tailMax) {
        tailMax = cur;
      }

      const threshold = tailMax + tailMax;
      if (g >= 1) {
        const prev = pairMax[g - 1];
        if (prev > threshold && peak > zero) {
          releaseRatio[g] = cur / peak;
        }
      } else {
        if (preEndMax > threshold) {
          releaseRatio[g] = cur / preEndMax;
        }
      }
    }
  }

  let gateEndValid = 0;
  let gateEndIdx = AT5_GATE_GROUP_COUNT;

  if (pivot < AT5_GATE_GROUP_COUNT) {
    for (let g = 0x1f; g >= pivot; g -= 1) {
      if (releaseRatio[g] > zero) {
        gateEndValid = 1;
        gateEndIdx = g;
      }
    }

    if (gateEndValid && gateEndIdx > AT5_GATE_GROUP_COUNT - 3) {
      gateEndIdx = AT5_GATE_GROUP_COUNT - 1;
    }
  }

  state.gateStartValid = gateStartValid;
  state.gateEndValid = gateEndValid;
  state.gateStartIdx = gateStartValid ? gateStartIdx : -1;
  state.gateEndIdx = gateEndValid ? gateEndIdx : AT5_GATE_GROUP_COUNT;
}

export function analysisPrepareWindow(dst, fallback) {
  if ((dst.gateStartValid | 0) === 0 || (dst.gateEndIdx | 0) <= (dst.gateStartIdx | 0)) {
    if ((fallback.gateStartValid | 0) !== 0) {
      dst.start = (fallback.gateStartIdx | 0) * AT5_GATE_GROUP_STRIDE;
      dst.hasStart = 1;
    } else {
      dst.start = 0;
      dst.hasStart = 0;
    }
  } else {
    dst.start = (dst.gateStartIdx | 0) * AT5_GATE_GROUP_STRIDE + AT5_GATE_GROUP_WINDOW_OFFSET;
    dst.hasStart = 1;
  }

  let endVal = 0;
  let hasEnd = 0;
  if (
    (fallback.gateEndValid | 0) === 0 ||
    (endVal = (fallback.gateEndIdx | 0) * AT5_GATE_GROUP_STRIDE) < (dst.start | 0)
  ) {
    if ((dst.gateEndValid | 0) !== 0) {
      endVal = (dst.gateEndIdx | 0) * AT5_GATE_GROUP_STRIDE + AT5_GATE_GROUP_WINDOW_OFFSET;
      hasEnd = 1;
    } else {
      endVal = AT5_GATE_FUTURE_WINDOW_OFFSET;
      hasEnd = 0;
    }
  } else {
    hasEnd = 1;
  }

  dst.end = endVal | 0;
  dst.hasEnd = hasEnd | 0;

  const endPlus = (dst.end | 0) + AT5_GATE_GROUP_STRIDE;
  dst.end = endPlus < 0x101 ? endPlus : 0x100;
}
