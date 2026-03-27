import { AT5_GAIN_SEGMENTS_MAX } from "./constants.js";

const AT5_GAIN_NEUTRAL_LEVEL = 6;

function boundedEntryCount(record) {
  if (!record) {
    return 0;
  }

  const count = record.entries | 0;
  if (count <= 0) {
    return 0;
  }
  return count > AT5_GAIN_SEGMENTS_MAX ? AT5_GAIN_SEGMENTS_MAX : count;
}

function clearUnusedTail(record, count) {
  for (let i = count; i < AT5_GAIN_SEGMENTS_MAX; i += 1) {
    record.locations[i] = 0;
    record.levels[i] = 0;
  }
}

function compactAdjacentEntries(record, count, shouldMerge) {
  let write = 0;

  for (let read = 0; read < count; read += 1) {
    if (write > 0 && shouldMerge(write - 1, read)) {
      write -= 1;
    }
    if (write !== read) {
      record.locations[write] = record.locations[read];
      record.levels[write] = record.levels[read];
    }
    write += 1;
  }

  return write;
}

export function fillGainParamFromRecord(record, out) {
  out.fill(0);
  const count = boundedEntryCount(record);
  out[0] = count >>> 0;
  for (let i = 0; i < count; i += 1) {
    out[1 + i] = record.locations[i] >>> 0;
    out[8 + i] = record.levels[i] >>> 0;
  }
  return out;
}

export function at5GainRecordNormalize(record) {
  if (!record) {
    return;
  }

  let count = boundedEntryCount(record);
  count = compactAdjacentEntries(record, count, (previous, current) => {
    return record.levels[previous] === record.levels[current];
  });

  if (count > 0 && record.levels[count - 1] === AT5_GAIN_NEUTRAL_LEVEL) {
    count -= 1;
  }

  count = compactAdjacentEntries(record, count, (previous, current) => {
    return record.locations[previous] === record.locations[current];
  });
  record.entries = count >>> 0;
  clearUnusedTail(record, count);
}

export function at5GainRecordClearUnusedTail(record) {
  if (!record) {
    return;
  }
  clearUnusedTail(record, boundedEntryCount(record));
}

export function at5GainRecordCopy(dst, src) {
  if (!dst || !src) {
    return;
  }

  dst.entries = src.entries | 0;
  dst.locations.set(src.locations);
  dst.levels.set(src.levels);

  dst.tlevFlag = src.tlevFlag | 0;
  dst.attackTotal = src.attackTotal;
  dst.releaseTotal = src.releaseTotal;

  dst.minAll = src.minAll;
  dst.minHi = src.minHi;
  dst.minTail = src.minTail;
  dst.gainBase = src.gainBase;

  dst.attackPoints = src.attackPoints;
  dst.attackFirst = src.attackFirst;
  dst.releaseLast = src.releaseLast;

  dst.tlev = src.tlev;

  dst.histA = src.histA;
  dst.histB = src.histB;

  dst.ampScaledMax = src.ampScaledMax;
  dst.attackSeedLimit = src.attackSeedLimit;
  dst.attackRoundDownCarry = src.attackRoundDownCarry;

  dst.derivMaxAll = src.derivMaxAll;
  dst.derivMaxHi = src.derivMaxHi;
  dst.derivSeedLimit = src.derivSeedLimit;

  dst.attackTotalB = src.attackTotalB;
  dst.releaseTotalB = src.releaseTotalB;

  dst.ampSlotMaxSum = src.ampSlotMaxSum;
  dst.derivSlotMaxSum = src.derivSlotMaxSum;
}

export function at5GainRecordEqual(a, b) {
  if (!a || !b) {
    return false;
  }

  const countA = a.entries | 0;
  const countB = b.entries | 0;
  if (countA !== countB) {
    return false;
  }
  if (countA <= 0) {
    return true;
  }

  for (let i = 0; i < countA; i += 1) {
    if (a.locations[i] !== b.locations[i] || a.levels[i] !== b.levels[i]) {
      return false;
    }
  }
  return true;
}

export function at5GainRecordMetric(record) {
  if (!record) {
    return 0;
  }

  const count = record.entries | 0;
  let sum = 0;
  if (count > 0) {
    for (let i = 1; i < count; i += 1) {
      sum += (record.levels[i - 1] | 0) - (record.levels[i] | 0);
    }
    sum += (record.levels[count - 1] | 0) - AT5_GAIN_NEUTRAL_LEVEL;
  }
  return sum;
}

export function at5GainRecordDecrementIndex(record) {
  if (!record) {
    return -1;
  }

  const count = record.entries | 0;
  if (count <= 0) {
    return -1;
  }

  for (let i = 0; i < count - 1; i += 1) {
    const a = record.levels[i] | 0;
    const b = record.levels[i + 1] | 0;
    if (a > b) {
      return i;
    }
  }

  const tail = record.levels[count - 1] | 0;
  return tail > AT5_GAIN_NEUTRAL_LEVEL ? count - 1 : -1;
}

export function recordEntries(record) {
  return (record?.entries ?? 0) | 0;
}

export function recordLevels(record) {
  return record?.levels ?? null;
}

export function recordLocations(record) {
  return record?.locations ?? null;
}

export function bandCopyTarget(a, b) {
  if (recordEntries(b) < recordEntries(a)) {
    return { dst: a, src: b };
  }
  return { dst: b, src: a };
}
