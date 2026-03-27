export const AT5_GAIN_RECORDS = 16;
export const AT5_GAIN_ENTRIES = 7;

export function createAt5GainRecord() {
  return {
    entries: 0,
    locations: new Uint32Array(AT5_GAIN_ENTRIES),
    levels: new Uint32Array(AT5_GAIN_ENTRIES),
  };
}

export function forEachActiveGainRecord(channel, visit) {
  const { activeCount, records } = channel.gain;
  for (let index = 0; index < activeCount >>> 0; index += 1) {
    if (visit(records[index], index, records) === false) {
      return false;
    }
  }
  return true;
}

export function clearAt5GainRecords(channel) {
  for (const record of channel.gain.records) {
    record.entries = 0;
    record.locations.fill(0);
    record.levels.fill(0);
  }
}

export function copyGainRecord(dst, src) {
  const count = src.entries >>> 0;
  dst.entries = count;
  if (count > 0) {
    dst.levels.set(src.levels.subarray(0, count), 0);
    dst.locations.set(src.locations.subarray(0, count), 0);
  }
}

export function gainBaseLevel(baseRecord, index) {
  const baseEntries = baseRecord?.entries >>> 0;
  return index < baseEntries ? (baseRecord?.levels?.[index] ?? 0) >>> 0 : 7;
}

export function gainLevelDelta(levels, index) {
  return (levels[index] | 0) - (levels[index - 1] | 0);
}

export function copyGainLocationPrefix(record, baseRecord) {
  const entries = record.entries >>> 0;
  const baseEntries = baseRecord?.entries >>> 0;
  const baseLocations = baseRecord?.locations ?? record.locations;
  const locations = record.locations;

  let copied = 0;
  for (; copied < entries && copied < baseEntries; copied += 1) {
    locations[copied] = baseLocations[copied];
  }
  return copied >>> 0;
}
