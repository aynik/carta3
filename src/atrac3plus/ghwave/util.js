export function checkPowerLevelAt5F32(a, b, count) {
  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let sum3 = 0;
  const n = count | 0;
  for (let i = 0; i < n; i += 4) {
    sum0 = sum0 + b[i + 0] * a[i + 0];
    sum2 = sum2 + b[i + 2] * a[i + 2];
    sum1 = sum1 + b[i + 1] * a[i + 1];
    sum3 = sum3 + b[i + 3] * a[i + 3];
  }
  return sum0 + sum1 + sum2 + sum3;
}

export function searchPairedScaleIndex(table, maxIndex, value) {
  let low = 0;
  let high = maxIndex >>> 1;

  while (low < high) {
    const mid = (low + high) >>> 1;
    const oddIndex = (mid << 1) | 1;
    if ((table[oddIndex] ?? 0) >= value) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  const oddIndex = (low << 1) | 1;
  if (oddIndex > 1 && value < (table[oddIndex - 1] ?? 0)) {
    return (oddIndex - 1) | 0;
  }
  return oddIndex | 0;
}

export function shellSortDesc(values, indices, count) {
  let gap = 1;
  while (gap <= (count | 0)) {
    gap = gap * 3 + 1;
  }
  gap = (gap / 3) | 0;

  while (gap > 0) {
    if (gap < (count | 0)) {
      for (let i = gap; i < (count | 0); i += 1) {
        const temp = values[i];
        const tempIdx = indices[i];
        let j = (i - gap) | 0;
        while (j >= 0 && temp > values[j]) {
          values[j + gap] = values[j];
          indices[j + gap] = indices[j];
          j = (j - gap) | 0;
        }
        values[j + gap] = temp;
        indices[j + gap] = tempIdx;
      }
    }
    gap = (gap / 3) | 0;
  }
}

export function findPeakBin(spec, bins) {
  let peakIdx = -1;
  let peakVal = 0;
  const n = bins | 0;
  for (let i = 0; i < n; i += 1) {
    const v = spec[i];
    if (v > peakVal) {
      peakVal = v;
      peakIdx = i;
    }
  }
  return peakIdx | 0;
}
