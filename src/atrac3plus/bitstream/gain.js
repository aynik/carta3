import { AT5_HC_GC_IDLEV, AT5_HC_GC_IDLOC, AT5_HC_GC_NGC } from "../tables/unpack.js";
import { at5DecodeSym, at5ReadBits } from "./bitstream.js";
import {
  AT5_GAIN_ENTRIES,
  AT5_GAIN_RECORDS,
  clearAt5GainRecords,
  copyGainLocationPrefix,
  copyGainRecord,
  createAt5GainRecord,
  forEachActiveGainRecord,
  gainBaseLevel,
  gainLevelDelta,
} from "./gain-common.js";

const AT5_ERROR_GAIN_NGC_RANGE = 0x115;
const AT5_ERROR_GAIN_IDLEV_RANGE = 0x116;
const AT5_ERROR_GAIN_IDLOC_RANGE = 0x117;
const AT5_ERROR_GAIN_IDLEV_DUP = 0x118;
const AT5_ERROR_GAIN_IDLOC_ORDER = 0x119;

export const AT5_GAIN_ERROR_CODES = {
  NGC_RANGE: AT5_ERROR_GAIN_NGC_RANGE,
  IDLEV_RANGE: AT5_ERROR_GAIN_IDLEV_RANGE,
  IDLOC_RANGE: AT5_ERROR_GAIN_IDLOC_RANGE,
  IDLEV_DUP: AT5_ERROR_GAIN_IDLEV_DUP,
  IDLOC_ORDER: AT5_ERROR_GAIN_IDLOC_ORDER,
};

export { AT5_GAIN_RECORDS, clearAt5GainRecords };

/**
 * Allocate the unpacked ATRAC3plus gain-control payload for one channel.
 */
export function createAt5GainChannelState(channelIndex, block0 = null) {
  return {
    channelIndex: channelIndex >>> 0,
    block0: block0 ?? null,
    blockErrorCode: 0,
    gain: {
      hasData: 0,
      hasDeltaFlag: 0,
      activeCount: 0,
      uniqueCount: 0,
      ngcMode: 0,
      idlevMode: 0,
      idlocMode: 0,
      n0: 0,
      n1: 0,
      idlevWidth: 0,
      idlevBase: 0,
      idlocStep: 0,
      idlocBase: 0,
      idlevFlags: new Uint32Array(AT5_GAIN_RECORDS),
      idlocFlags: new Uint32Array(AT5_GAIN_RECORDS),
      records: Array.from({ length: AT5_GAIN_RECORDS }, () => createAt5GainRecord()),
    },
  };
}

function setGainBlockError(channel, code) {
  channel.blockErrorCode = code >>> 0;
}

function validateGainNgc(records) {
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    if ((records[recordIndex].entries | 0) >= 8) {
      return AT5_ERROR_GAIN_NGC_RANGE;
    }
  }
  return 0;
}

function validateGainIdlev(records) {
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    const entries = record.entries | 0;

    for (let levelIndex = 0; levelIndex < AT5_GAIN_ENTRIES; levelIndex += 1) {
      if (record.levels[levelIndex] >>> 0 > 0x0f) {
        return AT5_ERROR_GAIN_IDLEV_RANGE;
      }
    }

    for (let levelIndex = 1; levelIndex < entries; levelIndex += 1) {
      if (record.levels[levelIndex - 1] >>> 0 === record.levels[levelIndex] >>> 0) {
        return AT5_ERROR_GAIN_IDLEV_DUP;
      }
    }
  }
  return 0;
}

function validateGainIdloc(records) {
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    const entries = record.entries | 0;

    for (let locationIndex = 0; locationIndex < AT5_GAIN_ENTRIES; locationIndex += 1) {
      if (record.locations[locationIndex] >>> 0 > 0x1f) {
        return AT5_ERROR_GAIN_IDLOC_RANGE;
      }
    }

    for (let locationIndex = 1; locationIndex < entries; locationIndex += 1) {
      if (record.locations[locationIndex] >>> 0 <= record.locations[locationIndex - 1] >>> 0) {
        return AT5_ERROR_GAIN_IDLOC_ORDER;
      }
    }
  }
  return 0;
}

function resetDecodedGainState(channel) {
  const gain = channel.gain;
  channel.blockErrorCode = 0;
  clearAt5GainRecords(channel);
  gain.idlevFlags.fill(0);
  gain.idlocFlags.fill(0);
  gain.n0 = 0;
  gain.n1 = 0;
  gain.idlevWidth = 0;
  gain.idlevBase = 0;
  gain.idlocStep = 0;
  gain.idlocBase = 0;
}

function setRecordValues(target, count, readValue) {
  for (let index = 0; index < count; index += 1) {
    target[index] = readValue(index) >>> 0;
  }
}

function setGainEntries(channel, readEntry) {
  forEachActiveGainRecord(channel, (record, index, records) => {
    record.entries = readEntry(record, index, records) >>> 0;
  });
}

function decodeIdlevLevelDeltas(levels, entries, frame, bitState) {
  if (entries === 0) {
    return;
  }

  levels[0] = at5DecodeSym(AT5_HC_GC_IDLEV[0], frame, bitState);
  for (let index = 1; index < entries; index += 1) {
    const delta = at5DecodeSym(AT5_HC_GC_IDLEV[1], frame, bitState);
    levels[index] = (levels[index - 1] + delta) & 0xf;
  }
}

function decodeIdlevAgainstBase(record, baseRecord, table, frame, bitState) {
  const entries = record.entries >>> 0;
  if (entries === 0) {
    return;
  }

  for (let index = 0; index < entries; index += 1) {
    record.levels[index] =
      (at5DecodeSym(table, frame, bitState) + gainBaseLevel(baseRecord, index)) & 0xf;
  }
}

function copyIdlevFromBase(record, baseRecord) {
  const entries = record.entries >>> 0;
  for (let index = 0; index < entries; index += 1) {
    record.levels[index] = gainBaseLevel(baseRecord, index);
  }
}

function unpackGainIdlev0(channel, frame, bitState) {
  forEachActiveGainRecord(channel, (record) => {
    setRecordValues(record.levels, record.entries >>> 0, () => at5ReadBits(frame, bitState, 4));
  });
}

function unpackGainIdlev1(channel, frame, bitState) {
  forEachActiveGainRecord(channel, (record) => {
    decodeIdlevLevelDeltas(record.levels, record.entries >>> 0, frame, bitState);
  });
}

function unpackGainIdlev2(channel, frame, bitState) {
  const { activeCount, records } = channel.gain;
  if (activeCount >>> 0 === 0) {
    return;
  }

  decodeIdlevLevelDeltas(records[0].levels, records[0].entries >>> 0, frame, bitState);
  for (let index = 1; index < activeCount >>> 0; index += 1) {
    decodeIdlevAgainstBase(records[index], records[index - 1], AT5_HC_GC_IDLEV[2], frame, bitState);
  }
}

function unpackGainIdlev3(channel, frame, bitState) {
  const width = at5ReadBits(frame, bitState, 2);
  const base = at5ReadBits(frame, bitState, 4);
  channel.gain.idlevWidth = width;
  channel.gain.idlevBase = base;

  forEachActiveGainRecord(channel, (record) => {
    setRecordValues(record.levels, record.entries >>> 0, () =>
      width > 0 ? at5ReadBits(frame, bitState, width) + base : base
    );
  });
}

function unpackGainIdlev4(channel, frame, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  forEachActiveGainRecord(channel, (record, index) => {
    decodeIdlevAgainstBase(record, baseRecords[index], AT5_HC_GC_IDLEV[3], frame, bitState);
  });
}

function unpackGainIdlev5(channel, frame, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  forEachActiveGainRecord(channel, (record, index) => {
    const entries = record.entries >>> 0;
    if (entries === 0) {
      return;
    }

    const flag = at5ReadBits(frame, bitState, 1);
    channel.gain.idlevFlags[index] = flag;
    if (flag !== 0) {
      decodeIdlevLevelDeltas(record.levels, entries, frame, bitState);
      return;
    }

    copyIdlevFromBase(record, baseRecords[index]);
  });
}

function unpackGainIdlev6(channel) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  forEachActiveGainRecord(channel, (record, index) => {
    copyIdlevFromBase(record, baseRecords[index]);
  });
}

const PRIMARY_IDLEV_UNPACKERS = [
  unpackGainIdlev0,
  unpackGainIdlev1,
  unpackGainIdlev2,
  unpackGainIdlev3,
];
const SECONDARY_IDLEV_UNPACKERS = [
  unpackGainIdlev0,
  unpackGainIdlev4,
  unpackGainIdlev5,
  unpackGainIdlev6,
];

export function unpackGainIdlev(channel, frame, bitState, mode) {
  const unpackMode = mode & 0x3;
  channel.gain.idlevMode = unpackMode;
  const unpackers =
    channel.channelIndex === 0 ? PRIMARY_IDLEV_UNPACKERS : SECONDARY_IDLEV_UNPACKERS;
  unpackers[unpackMode](channel, frame, bitState);
}

function idlocNextValue(frame, bitState, prev) {
  if (prev <= 0x0e) {
    return at5ReadBits(frame, bitState, 5);
  }
  if (prev <= 0x16) {
    return prev + at5ReadBits(frame, bitState, 4) + 1;
  }
  if (prev <= 0x1a) {
    return prev + at5ReadBits(frame, bitState, 3) + 1;
  }
  if (prev <= 0x1c) {
    return prev + at5ReadBits(frame, bitState, 2) + 1;
  }
  if (prev === 0x1d) {
    return prev + at5ReadBits(frame, bitState, 1) + 1;
  }
  if (prev === 0x1e) {
    return 0x1f;
  }
  return 0x1f;
}

function unpackIdlocMode0Record(record, frame, bitState, startIndex = 0) {
  const entries = record.entries >>> 0;
  if (entries === 0 || startIndex >= entries) {
    return;
  }

  const { locations } = record;
  let index = startIndex >>> 0;
  if (index === 0) {
    locations[0] = at5ReadBits(frame, bitState, 5);
    index = 1;
  }

  for (; index < entries; index += 1) {
    locations[index] = idlocNextValue(frame, bitState, locations[index - 1] >>> 0);
  }
}

function unpackIdlocDeltaRecord(record, frame, bitState) {
  const entries = record.entries >>> 0;
  if (entries === 0) {
    return;
  }

  const { levels, locations } = record;
  locations[0] = at5ReadBits(frame, bitState, 5);
  for (let index = 1; index < entries; index += 1) {
    const table = gainLevelDelta(levels, index) > 0 ? AT5_HC_GC_IDLOC[1] : AT5_HC_GC_IDLOC[0];
    locations[index] = locations[index - 1] + at5DecodeSym(table, frame, bitState);
  }
}

function unpackGainIdloc0(channel, frame, bitState) {
  forEachActiveGainRecord(channel, (record) => {
    unpackIdlocMode0Record(record, frame, bitState);
  });
}

function unpackGainIdloc1(channel, frame, bitState) {
  forEachActiveGainRecord(channel, (record) => {
    unpackIdlocDeltaRecord(record, frame, bitState);
  });
}

function unpackGainIdloc2(channel, frame, bitState) {
  const { activeCount, records } = channel.gain;
  if (activeCount >>> 0 === 0) {
    return;
  }

  unpackIdlocMode0Record(records[0], frame, bitState);
  for (let blockIndex = 1; blockIndex < activeCount >>> 0; blockIndex += 1) {
    const record = records[blockIndex];
    const entries = record.entries >>> 0;
    if (entries === 0) {
      continue;
    }

    const previousRecord = records[blockIndex - 1];
    const previousEntries = previousRecord.entries >>> 0;
    const previousLocations = previousRecord.locations;
    const { levels, locations } = record;

    const firstSymbol = at5DecodeSym(AT5_HC_GC_IDLOC[2], frame, bitState);
    locations[0] = previousEntries > 0 ? (previousLocations[0] + firstSymbol) & 0x1f : firstSymbol;

    for (let entryIndex = 1; entryIndex < entries; entryIndex += 1) {
      const useCurrentDelta = entryIndex >= previousEntries;
      const risingLevel = gainLevelDelta(levels, entryIndex) > 0;
      const table = risingLevel
        ? useCurrentDelta
          ? AT5_HC_GC_IDLOC[1]
          : AT5_HC_GC_IDLOC[3]
        : useCurrentDelta
          ? AT5_HC_GC_IDLOC[0]
          : AT5_HC_GC_IDLOC[2];
      const symbol = at5DecodeSym(table, frame, bitState);
      locations[entryIndex] = useCurrentDelta
        ? locations[entryIndex - 1] + symbol
        : (previousLocations[entryIndex] + symbol) & 0x1f;
    }
  }
}

function unpackGainIdloc3(channel, frame, bitState) {
  const step = at5ReadBits(frame, bitState, 2) + 1;
  const base = at5ReadBits(frame, bitState, 5);
  channel.gain.idlocStep = step;
  channel.gain.idlocBase = base;

  forEachActiveGainRecord(channel, (record) => {
    setRecordValues(
      record.locations,
      record.entries >>> 0,
      (index) => at5ReadBits(frame, bitState, step) + index + base
    );
  });
}

function unpackGainIdlocAgainstBase(channel, frame, bitState) {
  const { activeCount, records } = channel.gain;
  const baseRecords = (channel.block0 ?? channel).gain.records;

  for (let blockIndex = 0; blockIndex < activeCount >>> 0; blockIndex += 1) {
    const record = records[blockIndex];
    const entries = record.entries >>> 0;
    if (entries === 0) {
      continue;
    }

    const baseRecord = baseRecords[blockIndex];
    const baseEntries = baseRecord?.entries >>> 0;
    const baseLocations = baseRecord?.locations ?? record.locations;
    const { levels, locations } = record;

    const firstSymbol = at5DecodeSym(AT5_HC_GC_IDLOC[4], frame, bitState);
    locations[0] = baseEntries > 0 ? (baseLocations[0] + firstSymbol) & 0x1f : firstSymbol;

    for (let entryIndex = 1; entryIndex < entries; entryIndex += 1) {
      const hasBaseLocation = entryIndex < baseEntries;
      const risingLevel = gainLevelDelta(levels, entryIndex) > 0;
      if (risingLevel && hasBaseLocation) {
        if (at5ReadBits(frame, bitState, 1) === 0) {
          locations[entryIndex] = baseLocations[entryIndex];
        } else {
          locations[entryIndex] = idlocNextValue(frame, bitState, locations[entryIndex - 1] >>> 0);
        }
        continue;
      }

      const table = risingLevel
        ? AT5_HC_GC_IDLOC[1]
        : hasBaseLocation
          ? AT5_HC_GC_IDLOC[4]
          : AT5_HC_GC_IDLOC[0];
      const symbol = at5DecodeSym(table, frame, bitState);
      locations[entryIndex] = hasBaseLocation
        ? (baseLocations[entryIndex] + symbol) & 0x1f
        : locations[entryIndex - 1] + symbol;
    }
  }
}

function unpackGainIdlocWithReuseFlags(channel, frame, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  forEachActiveGainRecord(channel, (record, index) => {
    const entries = record.entries >>> 0;
    if (entries === 0) {
      return;
    }

    if (entries <= baseRecords[index]?.entries >>> 0) {
      const flag = at5ReadBits(frame, bitState, 1);
      channel.gain.idlocFlags[index] = flag;
      if (flag === 0) {
        copyGainLocationPrefix(record, baseRecords[index]);
        return;
      }
    }

    unpackIdlocDeltaRecord(record, frame, bitState);
  });
}

function unpackGainIdlocTailAfterBasePrefix(channel, frame, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  forEachActiveGainRecord(channel, (record, index) => {
    const entries = record.entries >>> 0;
    if (entries === 0) {
      return;
    }

    const copied = copyGainLocationPrefix(record, baseRecords[index]);
    if (copied < entries) {
      unpackIdlocMode0Record(record, frame, bitState, copied);
    }
  });
}

const PRIMARY_IDLOC_UNPACKERS = [
  unpackGainIdloc0,
  unpackGainIdloc1,
  unpackGainIdloc2,
  unpackGainIdloc3,
];
const SECONDARY_IDLOC_UNPACKERS = [
  unpackGainIdloc0,
  unpackGainIdlocAgainstBase,
  unpackGainIdlocWithReuseFlags,
  unpackGainIdlocTailAfterBasePrefix,
];

export function unpackGainIdloc(channel, frame, bitState, mode) {
  const unpackMode = mode & 0x3;
  channel.gain.idlocMode = unpackMode;
  const unpackers =
    channel.channelIndex === 0 ? PRIMARY_IDLOC_UNPACKERS : SECONDARY_IDLOC_UNPACKERS;
  unpackers[unpackMode](channel, frame, bitState);
}

function unpackGainNgc0(channel, frame, bitState) {
  setGainEntries(channel, () => at5ReadBits(frame, bitState, 3));
}

function unpackGainNgc1(channel, frame, bitState) {
  const table = AT5_HC_GC_NGC[0];
  setGainEntries(channel, () => at5DecodeSym(table, frame, bitState));
}

function unpackGainNgc2(channel, frame, bitState) {
  const { activeCount, records } = channel.gain;
  if (activeCount >>> 0 === 0) {
    return;
  }

  records[0].entries = at5DecodeSym(AT5_HC_GC_NGC[0], frame, bitState);
  for (let index = 1; index < activeCount >>> 0; index += 1) {
    const delta = at5DecodeSym(AT5_HC_GC_NGC[1], frame, bitState);
    records[index].entries = (delta + records[index - 1].entries) & 0x7;
  }
}

function unpackGainNgc3(channel, frame, bitState) {
  const n0 = at5ReadBits(frame, bitState, 2);
  const n1 = at5ReadBits(frame, bitState, 3);
  channel.gain.n0 = n0;
  channel.gain.n1 = n1;

  setGainEntries(channel, () => (n0 > 0 ? at5ReadBits(frame, bitState, n0) + n1 : n1));
}

function unpackGainNgc4(channel, frame, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  const table = AT5_HC_GC_NGC[1];
  setGainEntries(
    channel,
    (_, index) => (at5DecodeSym(table, frame, bitState) + (baseRecords[index]?.entries ?? 0)) & 0x7
  );
}

function unpackGainNgc5(channel) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  setGainEntries(channel, (_, index) => baseRecords[index]?.entries ?? 0);
}

const PRIMARY_NGC_UNPACKERS = [unpackGainNgc0, unpackGainNgc1, unpackGainNgc2, unpackGainNgc3];
const SECONDARY_NGC_UNPACKERS = [unpackGainNgc0, unpackGainNgc1, unpackGainNgc4, unpackGainNgc5];

export function unpackGainNgc(channel, frame, bitState, mode) {
  const unpackMode = mode & 0x3;
  channel.gain.ngcMode = unpackMode;
  const unpackers = channel.channelIndex === 0 ? PRIMARY_NGC_UNPACKERS : SECONDARY_NGC_UNPACKERS;
  unpackers[unpackMode](channel, frame, bitState);
}

function unpackGainHeader(channel, frame, bitState) {
  const gain = channel.gain;
  gain.hasData = at5ReadBits(frame, bitState, 1) >>> 0;
  if (gain.hasData === 0) {
    gain.activeCount = 0;
    gain.uniqueCount = 0;
    gain.hasDeltaFlag = 0;
    return false;
  }

  gain.activeCount = (at5ReadBits(frame, bitState, 4) + 1) >>> 0;
  gain.hasDeltaFlag = at5ReadBits(frame, bitState, 1) >>> 0;
  gain.uniqueCount =
    gain.hasDeltaFlag !== 0 ? (at5ReadBits(frame, bitState, 4) + 1) >>> 0 : gain.activeCount;
  return true;
}

const GAIN_UNPACK_STAGES = [
  { unpack: unpackGainNgc, validate: validateGainNgc },
  { unpack: unpackGainIdlev, validate: validateGainIdlev },
  { unpack: unpackGainIdloc, validate: validateGainIdloc },
];

function unpackValidatedGainStages(channel, frame, bitState) {
  for (const stage of GAIN_UNPACK_STAGES) {
    const mode = at5ReadBits(frame, bitState, 2) >>> 0;
    stage.unpack(channel, frame, bitState, mode);
    const errorCode = stage.validate(channel.gain.records);
    if (errorCode !== 0) {
      setGainBlockError(channel, errorCode);
      return false;
    }
  }
  return true;
}

function repeatSharedGainRecords(channel) {
  const gain = channel.gain;
  const activeCount = gain.activeCount >>> 0;
  const uniqueCount = gain.uniqueCount >>> 0;
  if (gain.hasDeltaFlag === 0 || activeCount === 0 || activeCount >= uniqueCount) {
    return;
  }

  const source = gain.records[activeCount - 1];
  for (let index = activeCount; index < uniqueCount; index += 1) {
    copyGainRecord(gain.records[index], source);
  }
}

/**
 * Decode the ATRAC3plus per-channel gain-control payload from the bitstream.
 */
export function unpackGainRecords(channel, frame, bitState) {
  resetDecodedGainState(channel);
  if (!unpackGainHeader(channel, frame, bitState)) {
    return true;
  }

  if (!unpackValidatedGainStages(channel, frame, bitState)) {
    return false;
  }

  repeatSharedGainRecords(channel);
  return true;
}
