/**
 * Internal gain-control bitstream helpers.
 *
 * Public gain callers only need channel-state builders, error codes, and
 * unpacking. Encode-side packers stay here.
 */
import { AT5_HC_GC_IDLEV, AT5_HC_GC_IDLOC, AT5_HC_GC_NGC } from "../tables/unpack.js";
import { at5PackStoreFromMsb, at5PackSym } from "./bitstream.js";
import { forEachActiveGainRecord, gainBaseLevel, gainLevelDelta } from "./gain-common.js";

export {
  AT5_GAIN_ERROR_CODES,
  AT5_GAIN_RECORDS,
  clearAt5GainRecords,
  createAt5GainChannelState,
  unpackGainIdlev,
  unpackGainIdloc,
  unpackGainNgc,
  unpackGainRecords,
} from "./gain.js";

function forEachGainRecordEntry(record, visit) {
  const entryCount = record?.entries >>> 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (visit(entryIndex, record) === false) {
      return false;
    }
  }
  return true;
}

function packLevelDeltaRecord(record, dst, bitState) {
  const entryCount = record?.entries >>> 0;
  if (entryCount === 0) {
    return true;
  }

  const { levels } = record;
  if (!at5PackSym(AT5_HC_GC_IDLEV[0], levels[0] & 0xf, dst, bitState)) {
    return false;
  }

  for (let entryIndex = 1; entryIndex < entryCount; entryIndex += 1) {
    if (
      !at5PackSym(
        AT5_HC_GC_IDLEV[1],
        (levels[entryIndex] - levels[entryIndex - 1]) & 0xf,
        dst,
        bitState
      )
    ) {
      return false;
    }
  }

  return true;
}

function packLevelDeltasAgainstBase(record, baseRecord, table, dst, bitState) {
  return forEachGainRecordEntry(record, (entryIndex, currentRecord) =>
    at5PackSym(
      table,
      ((((currentRecord?.levels?.[entryIndex] ?? 0) | 0) -
        (gainBaseLevel(baseRecord, entryIndex) | 0)) &
        0xf) >>>
        0,
      dst,
      bitState
    )
  );
}

export function at5PackGainIdlev0(channel, dst, bitState) {
  return forEachActiveGainRecord(channel, (record) =>
    forEachGainRecordEntry(record, (entryIndex, currentRecord) =>
      at5PackStoreFromMsb((currentRecord?.levels?.[entryIndex] ?? 0) & 0xf, 4, dst, bitState)
    )
  );
}

export function at5PackGainIdlev1(channel, dst, bitState) {
  return forEachActiveGainRecord(channel, (record) => packLevelDeltaRecord(record, dst, bitState));
}

export function at5PackGainIdlev2(channel, dst, bitState) {
  const activeCount = channel.gain.activeCount >>> 0;
  if (activeCount === 0) {
    return true;
  }

  const records = channel.gain.records;
  if (!packLevelDeltaRecord(records[0], dst, bitState)) {
    return false;
  }

  for (let recordIndex = 1; recordIndex < activeCount; recordIndex += 1) {
    if (
      !packLevelDeltasAgainstBase(
        records[recordIndex],
        records[recordIndex - 1],
        AT5_HC_GC_IDLEV[2],
        dst,
        bitState
      )
    ) {
      return false;
    }
  }

  return true;
}

export function at5PackGainIdlev3(channel, dst, bitState) {
  const { idlevWidth: bitWidth, idlevBase: baseLevel } = channel.gain;
  if (
    !at5PackStoreFromMsb(bitWidth & 0x3, 2, dst, bitState) ||
    !at5PackStoreFromMsb(baseLevel & 0xf, 4, dst, bitState)
  ) {
    return false;
  }

  if (bitWidth >>> 0 === 0) {
    return true;
  }

  return forEachActiveGainRecord(channel, (record) =>
    forEachGainRecordEntry(record, (entryIndex, currentRecord) =>
      at5PackStoreFromMsb(
        (((currentRecord?.levels?.[entryIndex] ?? 0) | 0) - (baseLevel | 0)) >>> 0,
        bitWidth | 0,
        dst,
        bitState
      )
    )
  );
}

export function at5PackGainIdlev4(channel, dst, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  return forEachActiveGainRecord(channel, (record, recordIndex) =>
    packLevelDeltasAgainstBase(record, baseRecords[recordIndex], AT5_HC_GC_IDLEV[3], dst, bitState)
  );
}

export function at5PackGainIdlev5(channel, dst, bitState) {
  const flags = channel.gain.idlevFlags;
  return forEachActiveGainRecord(channel, (record, recordIndex) => {
    if (record?.entries >>> 0 === 0) {
      return true;
    }

    const flag = (flags?.[recordIndex] ?? 0) & 1;
    if (!at5PackStoreFromMsb(flag, 1, dst, bitState)) {
      return false;
    }
    return flag === 0 || packLevelDeltaRecord(record, dst, bitState);
  });
}

export function at5PackGainNgc0(channel, dst, bitState) {
  return forEachActiveGainRecord(channel, (record) =>
    at5PackStoreFromMsb((record?.entries ?? 0) & 0x7, 3, dst, bitState)
  );
}

export function at5PackGainNgc1(channel, dst, bitState) {
  const table = AT5_HC_GC_NGC[0];
  return forEachActiveGainRecord(channel, (record) =>
    at5PackSym(table, (record?.entries ?? 0) & 0x7, dst, bitState)
  );
}

export function at5PackGainNgc2Ch0(channel, dst, bitState) {
  const activeCount = channel.gain.activeCount >>> 0;
  if (activeCount === 0) {
    return true;
  }

  const records = channel.gain.records;
  let previous = (records[0]?.entries ?? 0) & 0x7;
  if (!at5PackSym(AT5_HC_GC_NGC[0], previous, dst, bitState)) {
    return false;
  }

  for (let recordIndex = 1; recordIndex < activeCount; recordIndex += 1) {
    const current = (records[recordIndex]?.entries ?? 0) & 0x7;
    if (!at5PackSym(AT5_HC_GC_NGC[1], (current - previous) & 0x7, dst, bitState)) {
      return false;
    }
    previous = current;
  }

  return true;
}

export function at5PackGainNgc3Ch0(channel, dst, bitState) {
  const { n0: bitWidth, n1: baseCount } = channel.gain;
  if (
    !at5PackStoreFromMsb(bitWidth & 0x3, 2, dst, bitState) ||
    !at5PackStoreFromMsb(baseCount & 0x7, 3, dst, bitState)
  ) {
    return false;
  }

  if (bitWidth >>> 0 === 0) {
    return true;
  }

  return forEachActiveGainRecord(channel, (record) =>
    at5PackStoreFromMsb(
      ((record?.entries ?? 0) - (baseCount | 0)) >>> 0,
      bitWidth | 0,
      dst,
      bitState
    )
  );
}

export function at5PackGainNgc4Ch1(channel, dst, bitState) {
  const table = AT5_HC_GC_NGC[1];
  const baseRecords = (channel.block0 ?? channel).gain.records;
  return forEachActiveGainRecord(channel, (record, recordIndex) =>
    at5PackSym(
      table,
      (((record?.entries ?? 0) & 0x7) - ((baseRecords[recordIndex]?.entries ?? 0) & 0x7)) & 0x7,
      dst,
      bitState
    )
  );
}

function packMode0IdlocRecord(record, dst, bitState, startIndex = 0) {
  const entryCount = record?.entries >>> 0;
  let entryIndex = startIndex >>> 0;
  if (entryCount <= entryIndex) {
    return true;
  }

  const { locations } = record;
  if (entryIndex === 0) {
    if (!at5PackStoreFromMsb(locations[0] & 0x1f, 5, dst, bitState)) {
      return false;
    }
    entryIndex = 1;
  }

  for (; entryIndex < entryCount; entryIndex += 1) {
    const previous = locations[entryIndex - 1] >>> 0;
    const current = locations[entryIndex] >>> 0;

    if (previous <= 0x0e) {
      if (!at5PackStoreFromMsb(current & 0x1f, 5, dst, bitState)) {
        return false;
      }
      continue;
    }

    const delta = Math.max(0, (current - previous - 1) | 0);
    if (previous <= 0x16) {
      if (!at5PackStoreFromMsb(delta & 0xf, 4, dst, bitState)) {
        return false;
      }
    } else if (previous <= 0x1a) {
      if (!at5PackStoreFromMsb(delta & 0x7, 3, dst, bitState)) {
        return false;
      }
    } else if (previous <= 0x1c) {
      if (!at5PackStoreFromMsb(delta & 0x3, 2, dst, bitState)) {
        return false;
      }
    } else if (previous === 0x1d && !at5PackStoreFromMsb(delta & 0x1, 1, dst, bitState)) {
      return false;
    }
  }

  return true;
}

function packIdlocDelta(previous, current, dst, bitState) {
  const prev = previous >>> 0;
  const cur = current >>> 0;

  if (prev <= 0x0e) {
    return at5PackStoreFromMsb(cur & 0x1f, 5, dst, bitState);
  }
  if (prev <= 0x16) {
    return at5PackStoreFromMsb((cur - prev - 1) & 0xf, 4, dst, bitState);
  }
  if (prev <= 0x1a) {
    return at5PackStoreFromMsb((cur - prev - 1) & 0x7, 3, dst, bitState);
  }
  if (prev <= 0x1c) {
    return at5PackStoreFromMsb((cur - prev - 1) & 0x3, 2, dst, bitState);
  }
  if (prev === 0x1d) {
    return at5PackStoreFromMsb((cur - 0x1e) & 1, 1, dst, bitState);
  }

  return true;
}

function packDeltaIdlocRecord(record, dst, bitState) {
  const entryCount = record?.entries >>> 0;
  if (entryCount === 0) {
    return true;
  }

  const { levels, locations } = record;
  if (!at5PackStoreFromMsb(locations[0] & 0x1f, 5, dst, bitState)) {
    return false;
  }

  for (let entryIndex = 1; entryIndex < entryCount; entryIndex += 1) {
    const table = gainLevelDelta(levels, entryIndex) > 0 ? AT5_HC_GC_IDLOC[1] : AT5_HC_GC_IDLOC[0];
    if (
      !at5PackSym(table, (locations[entryIndex] - locations[entryIndex - 1]) >>> 0, dst, bitState)
    ) {
      return false;
    }
  }

  return true;
}

export function at5PackGainIdloc0(channel, dst, bitState) {
  return forEachActiveGainRecord(channel, (record) => packMode0IdlocRecord(record, dst, bitState));
}

export function at5PackGainIdloc1(channel, dst, bitState) {
  return forEachActiveGainRecord(channel, (record) => packDeltaIdlocRecord(record, dst, bitState));
}

export function at5PackGainIdloc2(channel, dst, bitState) {
  const activeCount = channel.gain.activeCount >>> 0;
  if (activeCount === 0) {
    return true;
  }

  const records = channel.gain.records;
  if (!packMode0IdlocRecord(records[0], dst, bitState)) {
    return false;
  }

  for (let recordIndex = 1; recordIndex < activeCount; recordIndex += 1) {
    const record = records[recordIndex];
    const entryCount = record?.entries >>> 0;
    if (entryCount === 0) {
      continue;
    }

    const baseRecord = records[recordIndex - 1];
    const baseEntryCount = baseRecord?.entries >>> 0;
    const baseLocations = baseRecord?.locations ?? record.locations;
    const { levels, locations } = record;

    const firstSymbol =
      baseEntryCount > 0 ? (locations[0] - baseLocations[0]) & 0x1f : locations[0] & 0x1f;
    if (!at5PackSym(AT5_HC_GC_IDLOC[2], firstSymbol >>> 0, dst, bitState)) {
      return false;
    }

    for (let entryIndex = 1; entryIndex < entryCount; entryIndex += 1) {
      const beyondBase = entryIndex >= baseEntryCount;
      const risingLevel = gainLevelDelta(levels, entryIndex) > 0;
      const table = risingLevel
        ? beyondBase
          ? AT5_HC_GC_IDLOC[1]
          : AT5_HC_GC_IDLOC[3]
        : beyondBase
          ? AT5_HC_GC_IDLOC[0]
          : AT5_HC_GC_IDLOC[2];
      const symbol = beyondBase
        ? (locations[entryIndex] - locations[entryIndex - 1]) >>> 0
        : (locations[entryIndex] - baseLocations[entryIndex]) & 0x1f;
      if (!at5PackSym(table, symbol >>> 0, dst, bitState)) {
        return false;
      }
    }
  }

  return true;
}

export function at5PackGainIdloc3(channel, dst, bitState) {
  const { idlocStep: bitWidth, idlocBase: baseLocation } = channel.gain;
  if (
    !at5PackStoreFromMsb((bitWidth - 1) & 0x3, 2, dst, bitState) ||
    !at5PackStoreFromMsb(baseLocation & 0x1f, 5, dst, bitState)
  ) {
    return false;
  }

  return forEachActiveGainRecord(channel, (record) =>
    forEachGainRecordEntry(record, (entryIndex, currentRecord) =>
      at5PackStoreFromMsb(
        (((currentRecord?.locations?.[entryIndex] ?? 0) | 0) -
          (entryIndex | 0) -
          (baseLocation | 0)) >>>
          0,
        bitWidth | 0,
        dst,
        bitState
      )
    )
  );
}

export function at5PackGainIdloc4(channel, dst, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  return forEachActiveGainRecord(channel, (record, recordIndex) => {
    const entryCount = record?.entries >>> 0;
    if (entryCount === 0) {
      return true;
    }

    const baseRecord = baseRecords[recordIndex];
    const baseEntryCount = baseRecord?.entries >>> 0;
    const { levels, locations } = record;
    const baseLocations = baseRecord?.locations ?? locations;

    const firstSymbol =
      baseEntryCount > 0 ? (locations[0] - baseLocations[0]) & 0x1f : locations[0] & 0x1f;
    if (!at5PackSym(AT5_HC_GC_IDLOC[4], firstSymbol >>> 0, dst, bitState)) {
      return false;
    }

    for (let entryIndex = 1; entryIndex < entryCount; entryIndex += 1) {
      const risingLevel = gainLevelDelta(levels, entryIndex) > 0;
      if (entryIndex < baseEntryCount) {
        const baseDelta = (locations[entryIndex] - baseLocations[entryIndex]) & 0x1f;
        if (!risingLevel) {
          if (!at5PackSym(AT5_HC_GC_IDLOC[4], baseDelta >>> 0, dst, bitState)) {
            return false;
          }
          continue;
        }

        if (baseDelta === 0) {
          if (!at5PackStoreFromMsb(0, 1, dst, bitState)) {
            return false;
          }
          continue;
        }

        if (
          !at5PackStoreFromMsb(1, 1, dst, bitState) ||
          !packIdlocDelta(locations[entryIndex - 1], locations[entryIndex], dst, bitState)
        ) {
          return false;
        }
        continue;
      }

      const table = risingLevel ? AT5_HC_GC_IDLOC[1] : AT5_HC_GC_IDLOC[0];
      if (
        !at5PackSym(table, (locations[entryIndex] - locations[entryIndex - 1]) >>> 0, dst, bitState)
      ) {
        return false;
      }
    }

    return true;
  });
}

export function at5PackGainIdloc5(channel, dst, bitState) {
  const flags = channel.gain.idlocFlags;
  const baseRecords = (channel.block0 ?? channel).gain.records;
  return forEachActiveGainRecord(channel, (record, recordIndex) => {
    const entryCount = record?.entries >>> 0;
    if (entryCount === 0) {
      return true;
    }

    const baseEntryCount = baseRecords[recordIndex]?.entries >>> 0;
    if (entryCount <= baseEntryCount) {
      const flag = (flags?.[recordIndex] ?? 0) & 1;
      if (!at5PackStoreFromMsb(flag, 1, dst, bitState)) {
        return false;
      }
      if (flag === 0) {
        return true;
      }
    }

    return packDeltaIdlocRecord(record, dst, bitState);
  });
}

export function at5PackGainIdloc6(channel, dst, bitState) {
  const baseRecords = (channel.block0 ?? channel).gain.records;
  return forEachActiveGainRecord(channel, (record, recordIndex) => {
    const entryCount = record?.entries >>> 0;
    if (entryCount === 0) {
      return true;
    }

    const baseEntryCount = baseRecords[recordIndex]?.entries >>> 0;
    if (baseEntryCount >= entryCount) {
      return true;
    }
    return packMode0IdlocRecord(record, dst, bitState, baseEntryCount);
  });
}

const PRIMARY_GAIN_PACKERS = {
  recordCount: [at5PackGainNgc0, at5PackGainNgc1, at5PackGainNgc2Ch0, at5PackGainNgc3Ch0],
  level: [at5PackGainIdlev0, at5PackGainIdlev1, at5PackGainIdlev2, at5PackGainIdlev3],
  location: [at5PackGainIdloc0, at5PackGainIdloc1, at5PackGainIdloc2, at5PackGainIdloc3],
};

const SECONDARY_GAIN_PACKERS = {
  recordCount: [at5PackGainNgc0, at5PackGainNgc1, at5PackGainNgc4Ch1, null],
  level: [at5PackGainIdlev0, at5PackGainIdlev4, at5PackGainIdlev5, null],
  location: [at5PackGainIdloc0, at5PackGainIdloc4, at5PackGainIdloc5, at5PackGainIdloc6],
};

function packGainMode(mode, packers, channel, dst, bitState) {
  const packer = packers[mode & 0x3] ?? null;
  return !packer || packer(channel, dst, bitState);
}

export function packGainRecords(channel, dst, bitState) {
  const gain = channel?.gain;
  if (!gain) {
    return at5PackStoreFromMsb(0, 1, dst, bitState);
  }

  const hasData = gain.hasData ? 1 : 0;
  if (!at5PackStoreFromMsb(hasData, 1, dst, bitState)) {
    return false;
  }
  if (hasData === 0) {
    return true;
  }

  const activeCount = Math.max(1, Math.min(gain.activeCount | 0, 16));
  gain.activeCount = activeCount;
  if (!at5PackStoreFromMsb((activeCount - 1) & 0xf, 4, dst, bitState)) {
    return false;
  }

  const hasDelta = gain.hasDeltaFlag ? 1 : 0;
  if (!at5PackStoreFromMsb(hasDelta, 1, dst, bitState)) {
    return false;
  }
  if (hasDelta !== 0) {
    const uniqueCount = Math.max(1, Math.min(gain.uniqueCount | 0, 16));
    if (!at5PackStoreFromMsb((uniqueCount - 1) & 0xf, 4, dst, bitState)) {
      return false;
    }
  }

  const ngcMode = gain.ngcMode & 0x3;
  const packers = channel.channelIndex >>> 0 === 0 ? PRIMARY_GAIN_PACKERS : SECONDARY_GAIN_PACKERS;
  if (
    !at5PackStoreFromMsb(ngcMode, 2, dst, bitState) ||
    !packGainMode(ngcMode, packers.recordCount, channel, dst, bitState)
  ) {
    return false;
  }

  const idlevMode = gain.idlevMode & 0x3;
  if (
    !at5PackStoreFromMsb(idlevMode, 2, dst, bitState) ||
    !packGainMode(idlevMode, packers.level, channel, dst, bitState)
  ) {
    return false;
  }

  const idlocMode = gain.idlocMode & 0x3;
  if (
    !at5PackStoreFromMsb(idlocMode, 2, dst, bitState) ||
    !packGainMode(idlocMode, packers.location, channel, dst, bitState)
  ) {
    return false;
  }

  return true;
}
