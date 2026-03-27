/**
 * Internal GH bitstream helpers.
 *
 * Public GH callers only need state builders, error codes, and unpacking.
 * Encode-side packers stay here, while the bit planner lives in `gh-plan.js`.
 */
import { at5PackStoreFromMsb, at5PackSym } from "./bitstream.js";
import { AT5_HC_GHPC } from "../tables/unpack.js";
import { ghBitWidth } from "./gh-util.js";

export {
  AT5_GH_ERROR_CODES,
  clearAt5GhSlot,
  createAt5GhChannelState,
  createAt5GhSharedState,
  unpackGh,
} from "./gh.js";

const AT5_GH_MAX_BANDS = 16;
const AT5_GH_BITS_INVALID = 0x4000;
const AT5_GH_IDLOC_VALUE0_DISABLED = 0xffffffff >>> 0;
const AT5_GH_IDLOC_VALUE1_DISABLED = 0x20;

function activeSlotIndex(shared) {
  return (shared?.slotIndex ?? 0) & 1;
}

function currentSlot(channel, shared) {
  const idx = activeSlotIndex(shared);
  return channel?.gh?.slots?.[idx] ?? null;
}

function baseCurrentSlot(channel, shared) {
  const base = channel?.block0 ?? channel;
  return currentSlot(base, shared);
}

function packGhHeaderBoolArray(header, enableKey, modeKey, arrayKey, count, dst, bitState) {
  const enable = header?.[enableKey] & 1;
  if (!at5PackStoreFromMsb(enable, 1, dst, bitState)) {
    return false;
  }
  if (enable === 0) {
    return true;
  }

  const mode = header?.[modeKey] & 1;
  if (!at5PackStoreFromMsb(mode, 1, dst, bitState)) {
    return false;
  }
  if (mode === 0) {
    return true;
  }

  const array = header?.[arrayKey];
  const n = Math.max(0, count | 0);
  if (!array || (array.length | 0) < n) {
    return false;
  }

  for (let i = 0; i < n; i += 1) {
    if (!at5PackStoreFromMsb(array[i] & 1, 1, dst, bitState)) {
      return false;
    }
  }
  return true;
}

function packGhIdloc0(channel, shared, bandCount, dst, bitState) {
  const present = channel?.gh?.presentFlags;
  const slot = currentSlot(channel, shared);
  const entries = slot?.entries;
  if (!present || !entries) {
    return false;
  }

  const lim = Math.max(0, Math.min(bandCount | 0, AT5_GH_MAX_BANDS));
  for (let i = 0; i < lim; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }

    const entry = entries[i];
    const flag0 = entry?.idlocFlag0 & 1;
    if (!at5PackStoreFromMsb(flag0, 1, dst, bitState)) {
      return false;
    }
    if (flag0 !== 0) {
      const v0 = entry?.idlocValue0 ?? AT5_GH_IDLOC_VALUE0_DISABLED;
      if (!at5PackStoreFromMsb(v0 >>> 0, 5, dst, bitState)) {
        return false;
      }
    }

    const flag1 = entry?.idlocFlag1 & 1;
    if (!at5PackStoreFromMsb(flag1, 1, dst, bitState)) {
      return false;
    }
    if (flag1 !== 0) {
      const v1 = entry?.idlocValue1 ?? AT5_GH_IDLOC_VALUE1_DISABLED;
      if (!at5PackStoreFromMsb(v1 >>> 0, 5, dst, bitState)) {
        return false;
      }
    }
  }

  return true;
}

function packGhNwavs(channel, shared, bandCount, mode, dst, bitState) {
  const present = channel?.gh?.presentFlags;
  const slot = currentSlot(channel, shared);
  const entries = slot?.entries;
  if (!present || !entries) {
    return false;
  }

  const modeId = mode >>> 0;
  if (modeId > 3) {
    return false;
  }

  const table = modeId === 1 ? AT5_HC_GHPC.NWAVS_A : AT5_HC_GHPC.NWAVS_B;
  const baseEntries = modeId >= 2 ? baseCurrentSlot(channel, shared)?.entries : null;
  if (modeId >= 2 && !baseEntries) {
    return false;
  }

  const lim = Math.max(0, Math.min(bandCount | 0, AT5_GH_MAX_BANDS));
  for (let i = 0; i < lim; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }

    if (modeId === 0) {
      const count = entries[i]?.entryCount ?? 0;
      if (!at5PackStoreFromMsb(count >>> 0, 4, dst, bitState)) {
        return false;
      }
    } else if (modeId === 1) {
      const sym = entries[i]?.entryCount | 0;
      if (sym < 0 || sym >= 8) {
        return false;
      }
      if (!at5PackSym(table, sym >>> 0, dst, bitState)) {
        return false;
      }
    } else if (modeId === 2) {
      const value = entries[i]?.entryCount ?? 0;
      const baseValue = baseEntries[i]?.entryCount ?? 0;
      const delta = (value | 0) - (baseValue | 0);
      if ((delta + 4) >>> 0 >= 8) {
        return false;
      }
      const sym = delta & 0x7;
      if (!at5PackSym(table, sym >>> 0, dst, bitState)) {
        return false;
      }
    } else if ((entries[i]?.entryCount | 0) !== (baseEntries[i]?.entryCount | 0)) {
      return false;
    }
  }

  return true;
}

function ghFreqBitsFromPrev(prev) {
  const value = prev & 0x3ff;
  const bits = ghBitWidth(0x3ff - value);
  return { bits, add: ((value >>> bits) << bits) >>> 0 };
}

function ghFreqBitsFromNext(nextValue) {
  return ghBitWidth(nextValue);
}

function packGhFreqUpward(entry, dst, bitState) {
  const count = entry?.entryCount | 0;
  if (count <= 0) {
    return true;
  }

  const items = entry?.entries;
  if (!items || items.length < count) {
    return false;
  }

  if (!at5PackStoreFromMsb(items[0]?.step ?? 0, 10, dst, bitState)) {
    return false;
  }

  for (let i = 1; i < count; i += 1) {
    const prev = items[i - 1]?.step ?? 0;
    const { bits, add } = ghFreqBitsFromPrev(prev);
    const raw = ((items[i]?.step ?? 0) - add) >>> 0;
    if (!at5PackStoreFromMsb(raw, bits, dst, bitState)) {
      return false;
    }
  }

  return true;
}

function packGhFreqReverse(entry, dst, bitState) {
  const count = entry?.entryCount | 0;
  if (count <= 0) {
    return true;
  }

  const items = entry?.entries;
  if (!items || items.length < count) {
    return false;
  }

  const last = count - 1;
  if (!at5PackStoreFromMsb(items[last]?.step ?? 0, 10, dst, bitState)) {
    return false;
  }

  for (let i = last - 1; i >= 0; i -= 1) {
    const next = items[i + 1]?.step ?? 0;
    const bits = ghFreqBitsFromNext(next);
    if (!at5PackStoreFromMsb(items[i]?.step ?? 0, bits, dst, bitState)) {
      return false;
    }
  }

  return true;
}

function packGhFreq(channel, shared, bandCount, mode, dst, bitState) {
  const present = channel?.gh?.presentFlags;
  const entries = currentSlot(channel, shared)?.entries;
  if (!present || !entries) {
    return false;
  }

  const modeId = mode >>> 0;
  if (modeId > 1) {
    return false;
  }

  if (modeId === 0) {
    const flags = channel?.gh?.freqFlags;
    if (!flags) {
      return false;
    }

    const lim = Math.max(0, Math.min(bandCount | 0, AT5_GH_MAX_BANDS));
    for (let i = 0; i < lim; i += 1) {
      if (present[i] >>> 0 === 0) {
        continue;
      }

      const entry = entries[i];
      const count = entry?.entryCount | 0;
      const flag = flags[i] & 1;
      if (count > 1 && !at5PackStoreFromMsb(flag, 1, dst, bitState)) {
        return false;
      }

      if (flag === 0) {
        if (!packGhFreqUpward(entry, dst, bitState)) {
          return false;
        }
      } else if (!packGhFreqReverse(entry, dst, bitState)) {
        return false;
      }
    }

    return true;
  }

  const baseEntries = baseCurrentSlot(channel, shared)?.entries;
  if (!baseEntries) {
    return false;
  }

  const table = AT5_HC_GHPC.FREQ_A;
  const lim = Math.max(0, Math.min(bandCount | 0, AT5_GH_MAX_BANDS));
  for (let i = 0; i < lim; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }

    const entry = entries[i];
    const count = entry?.entryCount | 0;
    if (count <= 0) {
      continue;
    }

    const base = baseEntries[i];
    const baseCount = base?.entryCount | 0;

    for (let j = 0; j < count; j += 1) {
      const curVal = entry?.entries?.[j]?.step ?? 0;

      let baseVal = 0;
      if (j < baseCount) {
        baseVal = base?.entries?.[j]?.step ?? 0;
      } else if (baseCount > 0) {
        baseVal = base?.entries?.[baseCount - 1]?.step ?? 0;
      }

      const delta = (curVal | 0) - (baseVal | 0);
      if ((delta + 0x80) >>> 0 > 0xff) {
        return false;
      }
      const sym = delta & 0xff;
      if (!at5PackSym(table, sym >>> 0, dst, bitState)) {
        return false;
      }
    }
  }

  return true;
}

function forEachPresentGhBand(channel, shared, bandCount, visit) {
  const present = channel?.gh?.presentFlags;
  const entries = currentSlot(channel, shared)?.entries;
  if (!present || !entries) {
    return false;
  }

  const limit = Math.max(0, Math.min(bandCount | 0, AT5_GH_MAX_BANDS));
  for (let band = 0; band < limit; band += 1) {
    if (present[band] >>> 0 === 0) {
      continue;
    }

    if (visit(entries[band], band) === false) {
      return false;
    }
  }

  return true;
}

function packGhEntryItems(entry, count, visit) {
  for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
    if (visit(entry?.entries?.[itemIndex], itemIndex) === false) {
      return false;
    }
  }

  return true;
}

function forEachMappedGhItem(channel, shared, bandCount, visit) {
  const baseEntries = baseCurrentSlot(channel, shared)?.entries;
  if (!baseEntries) {
    return false;
  }

  const map = shared?.itemMap;
  if (!(map instanceof Int32Array)) {
    return false;
  }

  let mapIndex = 0;

  return forEachPresentGhBand(channel, shared, bandCount, (entry, band) => {
    const count = entry?.entryCount | 0;
    if (count <= 0) {
      return true;
    }

    const ok = packGhEntryItems(entry, count, (item, itemIndex) =>
      (mapIndex + itemIndex) >>> 0 >= map.length
        ? false
        : visit(item, baseEntries[band], map[mapIndex + itemIndex] | 0)
    );
    if (!ok) {
      return false;
    }

    mapIndex += count;
    return true;
  });
}

function packGhIdsf(channel, shared, headerMode, bandCount, mode, dst, bitState) {
  const modeId = mode >>> 0;
  if (modeId > 3) {
    return false;
  }

  if (modeId < 2) {
    return forEachPresentGhBand(channel, shared, bandCount, (entry) => {
      const count = entry?.entryCount | 0;
      if (count <= 0) {
        return true;
      }

      if ((headerMode | 0) === 0) {
        const value = entry?.entries?.[0]?.sftIndex ?? 0;
        return modeId === 0
          ? at5PackStoreFromMsb(value >>> 0, 6, dst, bitState)
          : at5PackSym(AT5_HC_GHPC.IDSF_AA, ((value | 0) - 0x18) >>> 0, dst, bitState);
      }

      return packGhEntryItems(entry, count, (item) => {
        const value = item?.sftIndex ?? 0;
        return modeId === 0
          ? at5PackStoreFromMsb(value >>> 0, 6, dst, bitState)
          : at5PackSym(AT5_HC_GHPC.IDSF_AB, ((value | 0) - 0x14) >>> 0, dst, bitState);
      });
    });
  }

  if ((headerMode | 0) === 0) {
    const baseEntries = baseCurrentSlot(channel, shared)?.entries;
    if (!baseEntries) {
      return false;
    }

    return forEachPresentGhBand(channel, shared, bandCount, (entry, band) => {
      if ((entry?.entryCount | 0) <= 0) {
        return true;
      }

      const currentValue = entry?.entries?.[0]?.sftIndex ?? 0;
      const baseEntry = baseEntries[band];
      const baseValue =
        (baseEntry?.entryCount | 0) > 0 ? (baseEntry?.entries?.[0]?.sftIndex ?? 0) : 0x2c;
      if (modeId === 3) {
        const expected =
          (baseEntry?.entryCount | 0) > 0 ? (baseEntry?.entries?.[0]?.sftIndex ?? 0x31) : 0x31;
        return currentValue >>> 0 === expected >>> 0;
      }

      const delta = (currentValue | 0) - (baseValue | 0);
      if ((delta + 0x10) >>> 0 >= 0x20) {
        return false;
      }
      return at5PackSym(AT5_HC_GHPC.IDSF_B, (delta & 0x1f) >>> 0, dst, bitState);
    });
  }

  if (modeId === 3) {
    return forEachMappedGhItem(channel, shared, bandCount, (item, baseEntry, index) => {
      const currentValue = item?.sftIndex ?? 0;
      const expected = index < 0 ? 0x20 : (baseEntry?.entries?.[index]?.sftIndex ?? 0);
      return currentValue >>> 0 === expected >>> 0;
    });
  }

  return forEachMappedGhItem(channel, shared, bandCount, (item, baseEntry, index) => {
    const currentValue = item?.sftIndex ?? 0;
    const baseValue = index < 0 ? 0x22 : (baseEntry?.entries?.[index]?.sftIndex ?? 0);
    const delta = (currentValue | 0) - (baseValue | 0);
    if ((delta + 0x10) >>> 0 >= 0x20) {
      return false;
    }
    return at5PackSym(AT5_HC_GHPC.IDSF_B, (delta & 0x1f) >>> 0, dst, bitState);
  });
}

function packGhIdam(channel, shared, bandCount, mode, dst, bitState) {
  const modeId = mode >>> 0;
  if (modeId > 3) {
    return false;
  }

  if (modeId === 0) {
    return forEachPresentGhBand(channel, shared, bandCount, (entry) => {
      const count = entry?.entryCount | 0;
      return count <= 0
        ? true
        : packGhEntryItems(entry, count, (item) =>
            at5PackStoreFromMsb((item?.ampIndex ?? 0) >>> 0, 4, dst, bitState)
          );
    });
  }

  if (modeId === 1) {
    return forEachPresentGhBand(channel, shared, bandCount, (entry) => {
      const count = entry?.entryCount | 0;
      if (count <= 0) {
        return true;
      }

      if (count === 1) {
        return at5PackSym(
          AT5_HC_GHPC.IDAM_AA,
          (entry?.entries?.[0]?.ampIndex ?? 0) >>> 0,
          dst,
          bitState
        );
      }

      return packGhEntryItems(entry, count, (item) =>
        at5PackSym(AT5_HC_GHPC.IDAM_AB, (item?.ampIndex ?? 0) >>> 0, dst, bitState)
      );
    });
  }

  if (modeId === 3) {
    return forEachMappedGhItem(channel, shared, bandCount, (item, baseEntry, index) => {
      const currentValue = item?.ampIndex ?? 0;
      const expected = index < 0 ? 0x0e : (baseEntry?.entries?.[index]?.ampIndex ?? 0);
      return currentValue >>> 0 === expected >>> 0;
    });
  }

  return forEachMappedGhItem(channel, shared, bandCount, (item, baseEntry, index) => {
    const currentValue = item?.ampIndex ?? 0;
    const baseValue = index < 0 ? 0x0c : (baseEntry?.entries?.[index]?.ampIndex ?? 0);
    const delta = (currentValue | 0) - (baseValue | 0);
    if ((delta + 4) >>> 0 >= 8) {
      return false;
    }
    return at5PackSym(AT5_HC_GHPC.IDAM_C, (delta & 0x7) >>> 0, dst, bitState);
  });
}

function packGhIdlev(channel, shared, bandCount, dst, bitState) {
  return forEachPresentGhBand(channel, shared, bandCount, (entry) => {
    const count = entry?.entryCount | 0;
    return count <= 0
      ? true
      : packGhEntryItems(entry, count, (item) =>
          at5PackStoreFromMsb((item?.phaseBase ?? 0) >>> 0, 5, dst, bitState)
        );
  });
}

function packGhHeader(header, dst, bitState) {
  const enabled = header?.enabled & 1;
  if (!at5PackStoreFromMsb(enabled, 1, dst, bitState)) {
    return { ok: false, enabled: 0, mode: 0, bandCount: 0 };
  }
  if (enabled === 0) {
    return { ok: true, enabled, mode: 0, bandCount: 0 };
  }

  const mode = header?.mode & 1;
  if (!at5PackStoreFromMsb(mode, 1, dst, bitState)) {
    return { ok: false, enabled, mode, bandCount: 0 };
  }

  const bandCount = header?.bandCount | 0;
  if (bandCount <= 0 || bandCount > AT5_GH_MAX_BANDS) {
    return { ok: false, enabled, mode, bandCount };
  }
  if (!at5PackSym(AT5_HC_GHPC.NBANDS, ((bandCount - 1) & 0x1f) >>> 0, dst, bitState)) {
    return { ok: false, enabled, mode, bandCount };
  }

  return { ok: true, enabled, mode, bandCount };
}

export function packGhAt5(block, dst, bitState) {
  const channels = block?.channels;
  const shared = block?.ghShared;
  if (!Array.isArray(channels) || !shared) {
    return at5PackStoreFromMsb(0, 1, dst, bitState);
  }

  const channelCount = Math.max(0, Math.min(channels.length | 0, 2));
  if (channelCount === 0) {
    return at5PackStoreFromMsb(0, 1, dst, bitState);
  }

  const header = shared.headers?.[activeSlotIndex(shared)];
  const packedHeader = packGhHeader(header, dst, bitState);
  if (!packedHeader.ok) {
    return false;
  }
  if (packedHeader.enabled === 0) {
    return true;
  }
  const { mode: headerMode, bandCount } = packedHeader;

  if (channelCount === 2) {
    if (!packGhHeaderBoolArray(header, "c4Enable", "c5Mode", "c6Array", bandCount, dst, bitState)) {
      return false;
    }
    if (!packGhHeaderBoolArray(header, "e8Enable", "e9Mode", "eaArray", bandCount, dst, bitState)) {
      return false;
    }
    if (!packGhHeaderBoolArray(header, "d6Enable", "d7Mode", "d8Array", bandCount, dst, bitState)) {
      return false;
    }
  }

  for (let i = 0; i < channelCount; i += 1) {
    const channel = channels[i];
    const gh = channel?.gh;
    const isPrimary = channel?.channelIndex >>> 0 === 0;

    let mode = gh?.modeIdloc ?? 0;
    if (isPrimary) {
      if (mode >>> 0 !== 0) {
        return false;
      }
    } else {
      const modeIdloc = mode >>> 0;
      if (modeIdloc > 1 || !at5PackStoreFromMsb(modeIdloc, 1, dst, bitState)) {
        return false;
      }
    }

    if (mode >>> 0 === 0) {
      if (!packGhIdloc0(channel, shared, bandCount, dst, bitState)) {
        return false;
      }
    } else {
      const present = channel?.gh?.presentFlags;
      const entries = currentSlot(channel, shared)?.entries;
      const baseEntries = baseCurrentSlot(channel, shared)?.entries;
      const lim = Math.max(0, Math.min(bandCount | 0, AT5_GH_MAX_BANDS));
      if (!present || !entries || !baseEntries) {
        return false;
      }
      if (bitsIdlocMode1Copy(entries, baseEntries, present, lim) >= AT5_GH_BITS_INVALID) {
        return false;
      }
    }

    mode = gh?.modeNwavs ?? 0;
    const modeNwavs = mode >>> 0;
    const nwavsLimit = isPrimary ? 1 : 3;
    if (modeNwavs > nwavsLimit) {
      return false;
    }
    if (!at5PackStoreFromMsb(modeNwavs, isPrimary ? 1 : 2, dst, bitState)) {
      return false;
    }
    if (!packGhNwavs(channel, shared, bandCount, modeNwavs, dst, bitState)) {
      return false;
    }

    mode = gh?.modeFreq ?? 0;
    const modeFreq = mode >>> 0;
    if (modeFreq > 1) {
      return false;
    }
    if (isPrimary) {
      if (modeFreq !== 0) {
        return false;
      }
    } else if (!at5PackStoreFromMsb(modeFreq, 1, dst, bitState)) {
      return false;
    }
    if (!packGhFreq(channel, shared, bandCount, modeFreq, dst, bitState)) {
      return false;
    }

    mode = gh?.modeIdsf ?? 0;
    const modeIdsf = mode >>> 0;
    const idsfLimit = isPrimary ? 1 : 3;
    if (modeIdsf > idsfLimit) {
      return false;
    }
    if (!at5PackStoreFromMsb(modeIdsf, isPrimary ? 1 : 2, dst, bitState)) {
      return false;
    }
    if (!packGhIdsf(channel, shared, headerMode, bandCount, modeIdsf, dst, bitState)) {
      return false;
    }

    if ((headerMode | 0) === 0) {
      mode = gh?.modeIdam ?? 0;
      const modeIdam = mode >>> 0;
      const idamLimit = isPrimary ? 1 : 3;
      if (modeIdam > idamLimit) {
        return false;
      }
      if (!at5PackStoreFromMsb(modeIdam, isPrimary ? 1 : 2, dst, bitState)) {
        return false;
      }
      if (!packGhIdam(channel, shared, bandCount, modeIdam, dst, bitState)) {
        return false;
      }
    }

    if (!packGhIdlev(channel, shared, bandCount, dst, bitState)) {
      return false;
    }
  }

  return true;
}

function bitsIdlocMode1Copy(entries, baseEntries, present, entryCount) {
  let bits = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }

    const entry = entries[i];
    const base = baseEntries[i];
    const mismatch =
      entry?.idlocFlag0 >>> 0 !== base?.idlocFlag0 >>> 0 ||
      entry?.idlocFlag1 >>> 0 !== base?.idlocFlag1 >>> 0 ||
      (entry?.idlocValue0 | 0) !== (base?.idlocValue0 | 0) ||
      (entry?.idlocValue1 | 0) !== (base?.idlocValue1 | 0);
    if (mismatch) {
      bits += AT5_GH_BITS_INVALID;
    }
  }
  return bits | 0;
}

export {
  calcNbitsForGhFreq0At5,
  calcNbitsForGhaAt5,
  syncGhStateFromSigprocSlotsAt5,
} from "./gh-plan.js";
