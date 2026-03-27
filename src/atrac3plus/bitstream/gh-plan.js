/**
 * GH encode-side bit planning helpers.
 *
 * Split out from `gh-internal.js` so that packing and planning are easier to
 * reason about independently.
 */
import { AT5_HC_GHPC } from "../tables/unpack.js";
import { ghBitWidth } from "./gh-util.js";

const AT5_GH_MAX_BANDS = 16;
const AT5_GH_BITS_INVALID = 0x4000;

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

function hcBitlen(desc, sym) {
  const codes = desc?.codes;
  const idx = ((sym >>> 0) * 4 + 2) | 0;
  if (!(codes instanceof Uint8Array) || idx < 0 || idx >= codes.length) {
    return 0;
  }
  return codes[idx] | 0;
}

function i32Abs(v) {
  const x = v | 0;
  return x < 0 ? -x : x;
}

function selectBestGhMode(candidates) {
  let mode = 0;
  let bits = candidates[0] | 0;
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index] | 0;
    if (candidate < bits) {
      mode = index;
      bits = candidate;
    }
  }
  return { mode, bits };
}

function initGhChannelPresence(channel, header, entryCount) {
  const present = channel?.gh?.presentFlags;
  if (!(present instanceof Uint32Array)) {
    return null;
  }

  const limit = Math.max(0, Math.min(entryCount | 0, AT5_GH_MAX_BANDS, present.length | 0));
  present.fill(0);

  if (((channel?.channelIndex ?? 0) & 1) === 0) {
    present.fill(1, 0, limit);
    return present;
  }

  const joint = header?.c6Array;
  for (let i = 0; i < limit; i += 1) {
    present[i] = (joint?.[i] ?? 0) === 0 ? 1 : 0;
  }
  return present;
}

function ghHeaderBoolArrayBits(header, enableKey, modeKey, arrayKey, entryCount) {
  const n = entryCount | 0;
  if (n <= 0) {
    header[enableKey] = 0;
    header[modeKey] = 0;
    return 1;
  }

  const array = header?.[arrayKey];
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += (array?.[i] ?? 0) | 0;
  }

  if (sum === 0) {
    header[enableKey] = 0;
    header[modeKey] = 0;
    return 1;
  }

  header[enableKey] = 1;
  if (sum === n) {
    header[modeKey] = 0;
    return 2;
  }

  header[modeKey] = 1;
  return (n + 2) | 0;
}

function ghSwapEntriesForStereo(header, ch0, ch1, entryCount, shared) {
  const n = entryCount | 0;
  const ea = header?.eaArray;
  const slot0 = currentSlot(ch0, shared);
  const slot1 = currentSlot(ch1, shared);
  if (!slot0 || !slot1 || !Array.isArray(slot0.entries) || !Array.isArray(slot1.entries)) {
    return;
  }

  for (let i = 0; i < n && i < AT5_GH_MAX_BANDS; i += 1) {
    const entry0 = slot0.entries[i];
    const entry1 = slot1.entries[i];
    const shouldSwap = (entry0?.entryCount | 0) === 0 && (entry1?.entryCount | 0) > 0;
    if (ea && i < (ea.length | 0)) {
      ea[i] = shouldSwap ? 1 : 0;
    }
    if (!shouldSwap) {
      continue;
    }

    const tmp = {
      idlocFlag0: entry0.idlocFlag0 | 0,
      idlocFlag1: entry0.idlocFlag1 | 0,
      idlocValue0: entry0.idlocValue0 | 0,
      idlocValue1: entry0.idlocValue1 | 0,
      entryCount: entry0.entryCount | 0,
      entries: entry0.entries,
    };

    entry0.idlocFlag0 = entry1.idlocFlag0 | 0;
    entry0.idlocFlag1 = entry1.idlocFlag1 | 0;
    entry0.idlocValue0 = entry1.idlocValue0 | 0;
    entry0.idlocValue1 = entry1.idlocValue1 | 0;
    entry0.entryCount = entry1.entryCount | 0;
    entry0.entries = entry1.entries;

    entry1.idlocFlag0 = tmp.idlocFlag0;
    entry1.idlocFlag1 = tmp.idlocFlag1;
    entry1.idlocValue0 = tmp.idlocValue0;
    entry1.idlocValue1 = tmp.idlocValue1;
    entry1.entryCount = tmp.entryCount;
    entry1.entries = tmp.entries;
  }
}

function ghClearSwapFlags(header, entryCount) {
  const ea = header?.eaArray;
  if (!(ea instanceof Uint32Array)) {
    return;
  }
  ea.fill(0, 0, Math.max(0, Math.min(entryCount | 0, ea.length | 0)));
}

function bitsIdlocMode0(entries, present, entryCount) {
  let bits = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }
    const entry = entries[i];
    bits += 2;
    if (entry?.idlocFlag0 >>> 0 !== 0) {
      bits += 5;
    }
    if (entry?.idlocFlag1 >>> 0 !== 0) {
      bits += 5;
    }
  }
  return bits | 0;
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

function bitsNwavsMode0(present, entryCount) {
  let bits = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (present[i] >>> 0 !== 0) {
      bits += 4;
    }
  }
  return bits | 0;
}

function bitsNwavsMode1(entries, present, entryCount) {
  let bits = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }

    const count = entries[i]?.entryCount | 0;
    if (count < 0 || count >= 8) {
      bits += AT5_GH_BITS_INVALID;
      continue;
    }
    bits += hcBitlen(AT5_HC_GHPC.NWAVS_A, count >>> 0);
  }
  return bits | 0;
}

function bitsNwavsMode2Delta(entries, baseEntries, present, entryCount) {
  let bits = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }

    const delta = (entries[i]?.entryCount | 0) - (baseEntries[i]?.entryCount | 0);
    if (((delta + 4) >>> 0 >= 8) | 0) {
      bits += AT5_GH_BITS_INVALID;
      continue;
    }
    bits += hcBitlen(AT5_HC_GHPC.NWAVS_B, (delta & 7) >>> 0);
  }
  return bits | 0;
}

function bitsNwavsMode3Copy(entries, baseEntries, present, entryCount) {
  let bits = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }
    if ((entries[i]?.entryCount | 0) !== (baseEntries[i]?.entryCount | 0)) {
      bits += AT5_GH_BITS_INVALID;
    }
  }
  return bits | 0;
}

function bitsFreqMode1Delta(entries, baseEntries, present, entryCount) {
  let bits = 0;

  for (let i = 0; i < entryCount; i += 1) {
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
    const items = entry?.entries;
    const baseItems = base?.entries;

    let entryBits = 0;
    for (let j = 0; j < count; j += 1) {
      let baseFreq = 0;
      if (j < baseCount) {
        baseFreq = baseItems?.[j]?.step ?? 0;
      } else if (baseCount > 0) {
        baseFreq = baseItems?.[baseCount - 1]?.step ?? 0;
      }

      const curFreq = items?.[j]?.step ?? 0;
      const delta = (curFreq | 0) - (baseFreq | 0);
      if ((delta + 0x80) >>> 0 > 0xff) {
        entryBits = AT5_GH_BITS_INVALID;
        break;
      }

      entryBits += hcBitlen(AT5_HC_GHPC.FREQ_A, (delta & 0xff) >>> 0);
    }

    bits += entryBits;
  }

  return bits | 0;
}

function buildItemMap(shared, entries, baseEntries, present, entryCount) {
  const mapDst = shared?.itemMap;
  if (!(mapDst instanceof Int32Array)) {
    return;
  }

  let mapIndex = 0;

  forEachPresentGhEntry(entries, present, entryCount, (entry, count, band) => {
    if (count <= 0) {
      return;
    }

    const base = baseEntries[band];
    const baseCount = Math.min(base?.entryCount | 0, AT5_GH_MAX_BANDS);
    const baseItems = base?.entries;
    const items = entry?.entries;

    for (let j = 0; j < count; j += 1) {
      if (baseCount <= 0) {
        mapDst[mapIndex + j] = -1;
        continue;
      }

      let bestIdx = 0;
      let bestDiff = 0x400;

      const curFreq = items?.[j]?.step ?? 0;
      for (let k = 0; k < baseCount; k += 1) {
        const diff = i32Abs((curFreq | 0) - ((baseItems?.[k]?.step ?? 0) | 0));
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = k | 0;
        }
      }

      let mapped = -1;
      if (bestDiff <= 7) {
        mapped = bestIdx | 0;
      } else if (j < baseCount) {
        mapped = j | 0;
      }
      mapDst[mapIndex + j] = mapped | 0;
    }

    mapIndex += count;
  });
}

function forEachPresentGhEntry(entries, present, entryCount, visit) {
  for (let band = 0; band < entryCount; band += 1) {
    if (present[band] >>> 0 === 0) {
      continue;
    }

    const entry = entries[band];
    visit(entry, entry?.entryCount | 0, band);
  }
}

function sumPresentGhEntryBits(entries, present, entryCount, calcEntryBits) {
  let bits = 0;

  forEachPresentGhEntry(entries, present, entryCount, (entry, count, band) => {
    if (count > 0) {
      bits += calcEntryBits(entry, count, band);
    }
  });

  return bits | 0;
}

function sumMappedGhEntryBits(shared, entries, baseEntries, present, entryCount, calcEntryBits) {
  let bits = 0;
  const map = shared?.itemMap;
  let mapIndex = 0;

  forEachPresentGhEntry(entries, present, entryCount, (entry, count, band) => {
    if (count > 0) {
      bits += calcEntryBits(entry, count, baseEntries[band], map, mapIndex);
      mapIndex += count;
    }
  });

  return bits | 0;
}

function countPresentGhItems(entries, present, entryCount, bitsPerItem) {
  return sumPresentGhEntryBits(
    entries,
    present,
    entryCount,
    (_, count) => (count * bitsPerItem) | 0
  );
}

function bitsIdsfMode0(entries, headerMode, present, entryCount) {
  return headerMode >>> 0 === 0
    ? sumPresentGhEntryBits(entries, present, entryCount, () => 6)
    : countPresentGhItems(entries, present, entryCount, 6);
}

function bitsIdsfMode1(entries, headerMode, present, entryCount) {
  return sumPresentGhEntryBits(entries, present, entryCount, (entry, count) => {
    const items = entry?.entries;

    if (headerMode >>> 0 === 0) {
      const sym = (((items?.[0]?.sftIndex ?? 0) >>> 0) - 0x18) >>> 0;
      return sym >= 0x20 ? AT5_GH_BITS_INVALID : hcBitlen(AT5_HC_GHPC.IDSF_AA, sym);
    }

    let entryBits = 0;
    for (let j = 0; j < count; j += 1) {
      const sym = (((items?.[j]?.sftIndex ?? 0) >>> 0) - 0x14) >>> 0;
      if (sym >= 0x20) {
        return AT5_GH_BITS_INVALID;
      }
      entryBits += hcBitlen(AT5_HC_GHPC.IDSF_AB, sym);
    }

    return entryBits;
  });
}

function bitsIdsfMode2Delta(shared, entries, baseEntries, headerMode, present, entryCount) {
  if (headerMode >>> 0 === 0) {
    return sumPresentGhEntryBits(entries, present, entryCount, (entry, _count, band) => {
      const curVal = entry?.entries?.[0]?.sftIndex ?? 0;
      const base = baseEntries[band];
      const baseValue = (base?.entryCount | 0) > 0 ? (base?.entries?.[0]?.sftIndex ?? 0) : 0x2c;
      const delta = (curVal | 0) - (baseValue | 0);
      return (((delta + 0x10) >>> 0 >= 0x20) | 0) !== 0
        ? AT5_GH_BITS_INVALID
        : hcBitlen(AT5_HC_GHPC.IDSF_B, (delta & 0x1f) >>> 0);
    });
  }

  return sumMappedGhEntryBits(
    shared,
    entries,
    baseEntries,
    present,
    entryCount,
    (entry, count, base, map, mapIndex) => {
      const items = entry?.entries;
      const baseItems = base?.entries;
      let entryBits = 0;

      for (let j = 0; j < count; j += 1) {
        const idx = map?.[mapIndex + j] ?? -1;
        const curVal = items?.[j]?.sftIndex ?? 0;
        const baseValue = (idx | 0) < 0 ? 0x22 : (baseItems?.[idx]?.sftIndex ?? 0);
        const delta = (curVal | 0) - (baseValue | 0);
        if (((delta + 0x10) >>> 0 >= 0x20) | 0) {
          return AT5_GH_BITS_INVALID;
        }
        entryBits += hcBitlen(AT5_HC_GHPC.IDSF_B, (delta & 0x1f) >>> 0);
      }

      return entryBits;
    }
  );
}

function bitsIdsfMode3Copy(shared, entries, baseEntries, headerMode, present, entryCount) {
  if (headerMode >>> 0 === 0) {
    return sumPresentGhEntryBits(entries, present, entryCount, (entry, _count, band) => {
      const base = baseEntries[band];
      const expected = (base?.entryCount | 0) > 0 ? (base?.entries?.[0]?.sftIndex ?? 0x31) : 0x31;
      return (entry?.entries?.[0]?.sftIndex ?? 0) >>> 0 === expected >>> 0
        ? 0
        : AT5_GH_BITS_INVALID;
    });
  }

  return sumMappedGhEntryBits(
    shared,
    entries,
    baseEntries,
    present,
    entryCount,
    (entry, count, base, map, mapIndex) => {
      const items = entry?.entries;
      const baseItems = base?.entries;

      for (let j = 0; j < count; j += 1) {
        const idx = map?.[mapIndex + j] ?? -1;
        const expected = (idx | 0) < 0 ? 0x20 : (baseItems?.[idx]?.sftIndex ?? 0);
        if ((items?.[j]?.sftIndex ?? 0) >>> 0 !== expected >>> 0) {
          return AT5_GH_BITS_INVALID;
        }
      }

      return 0;
    }
  );
}

function bitsIdamMode0(entries, present, entryCount) {
  return countPresentGhItems(entries, present, entryCount, 4);
}

function bitsIdamMode1(entries, present, entryCount) {
  return sumPresentGhEntryBits(entries, present, entryCount, (entry, count) => {
    const items = entry?.entries;
    if (count === 1) {
      return hcBitlen(AT5_HC_GHPC.IDAM_AA, (items?.[0]?.ampIndex ?? 0) >>> 0);
    }

    let entryBits = 0;
    for (let j = 0; j < count; j += 1) {
      entryBits += hcBitlen(AT5_HC_GHPC.IDAM_AB, (items?.[j]?.ampIndex ?? 0) >>> 0);
    }

    return entryBits;
  });
}

function bitsIdamMode2Delta(shared, entries, baseEntries, present, entryCount) {
  return sumMappedGhEntryBits(
    shared,
    entries,
    baseEntries,
    present,
    entryCount,
    (entry, count, base, map, mapIndex) => {
      const items = entry?.entries;
      const baseItems = base?.entries;
      let entryBits = 0;

      for (let j = 0; j < count; j += 1) {
        const idx = map?.[mapIndex + j] ?? -1;
        const curVal = (items?.[j]?.ampIndex ?? 0) >>> 0;

        if ((idx | 0) < 0) {
          if ((curVal - 8) >>> 0 > 7) {
            return AT5_GH_BITS_INVALID;
          }
          entryBits += hcBitlen(AT5_HC_GHPC.IDAM_C, ((curVal | 0) - 0x0c) & 7);
          continue;
        }

        const delta = (curVal | 0) - ((baseItems?.[idx]?.ampIndex ?? 0) | 0);
        if (((delta + 4) >>> 0 >= 8) | 0) {
          return AT5_GH_BITS_INVALID;
        }
        entryBits += hcBitlen(AT5_HC_GHPC.IDAM_C, (delta & 7) >>> 0);
      }

      return entryBits;
    }
  );
}

function bitsIdamMode3Copy(shared, entries, baseEntries, present, entryCount) {
  return sumMappedGhEntryBits(
    shared,
    entries,
    baseEntries,
    present,
    entryCount,
    (entry, count, base, map, mapIndex) => {
      const items = entry?.entries;
      const baseItems = base?.entries;

      for (let j = 0; j < count; j += 1) {
        const idx = map?.[mapIndex + j] ?? -1;
        const expected = (idx | 0) < 0 ? 0x0e : (baseItems?.[idx]?.ampIndex ?? 0);
        if ((items?.[j]?.ampIndex ?? 0) >>> 0 !== expected >>> 0) {
          return AT5_GH_BITS_INVALID;
        }
      }

      return 0;
    }
  );
}

function bitsItemsIdlev(entries, present, entryCount) {
  return countPresentGhItems(entries, present, entryCount, 5);
}

function ghCtxOverheadBits(ctxMode, headerMode) {
  const cm = ctxMode >>> 0;
  const hm = headerMode >>> 0;
  if (cm === 0) {
    return hm === 0 ? 3 : 2;
  }
  return hm === 0 ? 8 : 6;
}

function ghFreqBitsForPrev(prev) {
  return ghBitWidth(0x3ff - (prev & 0x3ff));
}

function ghFreqBitsForNext(nextVal) {
  return ghBitWidth(nextVal);
}

function ghFreqBitsUpward(items, count) {
  let bits = 10;
  for (let i = 1; i < count; i += 1) {
    const prev = items?.[i - 1]?.step ?? 0;
    bits += ghFreqBitsForPrev(prev >>> 0);
  }
  return bits | 0;
}

function ghFreqBitsReverse(items, count) {
  let bits = 10;
  for (let i = count - 2; i >= 0; i -= 1) {
    const nextVal = items?.[i + 1]?.step ?? 0;
    bits += ghFreqBitsForNext(nextVal >>> 0);
  }
  return bits | 0;
}

function calcNbitsForGhFreq0At5(channel, shared, entryCount) {
  const present = channel?.gh?.presentFlags;
  const slot = currentSlot(channel, shared);
  const entries = slot?.entries;
  const flags = channel?.gh?.freqFlags;
  if (!present || !entries || !flags) {
    return 0;
  }

  const n = Math.max(0, Math.min(entryCount | 0, AT5_GH_MAX_BANDS));
  let totalBits = 0;

  for (let i = 0; i < n; i += 1) {
    if (present[i] >>> 0 === 0) {
      continue;
    }

    const entry = entries[i];
    const groupCount = entry?.entryCount | 0;
    if (groupCount <= 0) {
      continue;
    }

    const items = entry?.entries;
    const bitsUp = ghFreqBitsUpward(items, groupCount);
    if (groupCount > 1) {
      const bitsRev = ghFreqBitsReverse(items, groupCount);
      const useReverse = bitsUp > bitsRev ? 1 : 0;
      flags[i] = useReverse >>> 0;
      totalBits += (useReverse !== 0 ? bitsRev : bitsUp) + 1;
    } else {
      totalBits += bitsUp;
    }
  }

  return totalBits | 0;
}

function calcExplicitGhPayloadBits(channel, shared, headerMode, entries, present, entryCount) {
  channel.gh.modeIdloc = 0;
  channel.gh.modeNwavs = 0;
  channel.gh.modeFreq = 0;
  channel.gh.modeIdsf = 0;
  channel.gh.modeIdam = 0;

  const bitsIdam = (headerMode | 0) === 0 ? bitsIdamMode0(entries, present, entryCount) : 0;
  return (
    bitsIdlocMode0(entries, present, entryCount) +
    bitsNwavsMode0(present, entryCount) +
    calcNbitsForGhFreq0At5(channel, shared, entryCount) +
    bitsIdsfMode0(entries, headerMode >>> 0, present, entryCount) +
    bitsIdam +
    bitsItemsIdlev(entries, present, entryCount)
  );
}

function selectCopyMode(bits0, bits1) {
  return bits1 < bits0 ? { mode: 1, bits: bits1 } : { mode: 0, bits: bits0 };
}

function selectGhAdaptivePayloadBits(
  channel,
  shared,
  headerMode,
  ctxMode,
  entries,
  baseEntries,
  present,
  entryCount
) {
  const gh = channel.gh;

  const idloc0 = bitsIdlocMode0(entries, present, entryCount);
  const idloc =
    ctxMode !== 0 && baseEntries
      ? selectCopyMode(idloc0, bitsIdlocMode1Copy(entries, baseEntries, present, entryCount))
      : { mode: 0, bits: idloc0 };
  gh.modeIdloc = idloc.mode >>> 0;

  const nwavs0 = bitsNwavsMode0(present, entryCount);
  const nwavs =
    ctxMode === 0
      ? selectCopyMode(nwavs0, bitsNwavsMode1(entries, present, entryCount))
      : baseEntries
        ? selectBestGhMode([
            nwavs0,
            bitsNwavsMode1(entries, present, entryCount),
            bitsNwavsMode2Delta(entries, baseEntries, present, entryCount),
            bitsNwavsMode3Copy(entries, baseEntries, present, entryCount),
          ])
        : { mode: 0, bits: nwavs0 };
  gh.modeNwavs = nwavs.mode >>> 0;

  const freq0 = calcNbitsForGhFreq0At5(channel, shared, entryCount);
  const freq =
    ctxMode !== 0 && baseEntries
      ? selectCopyMode(freq0, bitsFreqMode1Delta(entries, baseEntries, present, entryCount))
      : { mode: 0, bits: freq0 };
  gh.modeFreq = freq.mode >>> 0;

  if (ctxMode !== 0 && baseEntries) {
    buildItemMap(shared, entries, baseEntries, present, entryCount);
  }

  const idsf0 = bitsIdsfMode0(entries, headerMode >>> 0, present, entryCount);
  const idsf =
    ctxMode === 0
      ? selectCopyMode(idsf0, bitsIdsfMode1(entries, headerMode >>> 0, present, entryCount))
      : baseEntries
        ? selectBestGhMode([
            idsf0,
            bitsIdsfMode1(entries, headerMode >>> 0, present, entryCount),
            bitsIdsfMode2Delta(shared, entries, baseEntries, headerMode >>> 0, present, entryCount),
            bitsIdsfMode3Copy(shared, entries, baseEntries, headerMode >>> 0, present, entryCount),
          ])
        : { mode: 0, bits: idsf0 };
  gh.modeIdsf = idsf.mode >>> 0;

  let idam = { mode: 0, bits: 0 };
  if ((headerMode | 0) === 0) {
    const idam0 = bitsIdamMode0(entries, present, entryCount);
    idam =
      ctxMode === 0
        ? selectCopyMode(idam0, bitsIdamMode1(entries, present, entryCount))
        : baseEntries
          ? selectBestGhMode([
              idam0,
              bitsIdamMode1(entries, present, entryCount),
              bitsIdamMode2Delta(shared, entries, baseEntries, present, entryCount),
              bitsIdamMode3Copy(shared, entries, baseEntries, present, entryCount),
            ])
          : { mode: 0, bits: idam0 };
  }
  gh.modeIdam = idam.mode >>> 0;

  return (
    idloc.bits +
    nwavs.bits +
    freq.bits +
    idsf.bits +
    idam.bits +
    bitsItemsIdlev(entries, present, entryCount)
  );
}

function calcNbitsForGhaAt5(block, flag = 1) {
  const channels = block?.channels;
  const shared = block?.ghShared;
  if (!Array.isArray(channels) || !shared) {
    return 0;
  }

  const nblocks = Math.max(0, Math.min(channels.length | 0, 2));
  if (nblocks <= 0) {
    return 0;
  }

  const header = shared.headers?.[activeSlotIndex(shared)] ?? null;
  if (!header || (header.enabled | 0) === 0) {
    return 1;
  }

  const entryCount = Math.max(0, Math.min(header.bandCount | 0, AT5_GH_MAX_BANDS));
  if (nblocks === 2 && channels[1]) {
    ghSwapEntriesForStereo(header, channels[0], channels[1], entryCount, shared);
  } else {
    ghClearSwapFlags(header, entryCount);
  }

  let totalBits = 0;
  totalBits += 2 + hcBitlen(AT5_HC_GHPC.NBANDS, ((entryCount - 1) & 0x1f) >>> 0);

  if (nblocks === 2) {
    totalBits += ghHeaderBoolArrayBits(header, "c4Enable", "c5Mode", "c6Array", entryCount);
    totalBits += ghHeaderBoolArrayBits(header, "d6Enable", "d7Mode", "d8Array", entryCount);
    totalBits += ghHeaderBoolArrayBits(header, "e8Enable", "e9Mode", "eaArray", entryCount);
  }

  const headerMode = header.mode & 1;

  for (let ch = 0; ch < nblocks; ch += 1) {
    const channel = channels[ch];
    if (!channel) {
      continue;
    }

    const ctxMode = (channel.channelIndex ?? ch) & 1;
    const present = initGhChannelPresence(channel, header, entryCount);
    if (!present) {
      continue;
    }

    const slot = currentSlot(channel, shared);
    const entries = slot?.entries;
    const baseSlot = baseCurrentSlot(channel, shared);
    const baseEntries = baseSlot?.entries;
    if (!entries) {
      continue;
    }

    const overheadBits = ghCtxOverheadBits(ctxMode >>> 0, headerMode >>> 0);

    let payloadBits = 0;

    if ((flag | 0) !== 1) {
      payloadBits = calcExplicitGhPayloadBits(
        channel,
        shared,
        headerMode,
        entries,
        present,
        entryCount
      );
    } else {
      payloadBits = selectGhAdaptivePayloadBits(
        channel,
        shared,
        headerMode,
        ctxMode,
        entries,
        baseEntries,
        present,
        entryCount
      );
    }

    totalBits = (totalBits + overheadBits + payloadBits) | 0;
  }

  return totalBits | 0;
}

function syncGhStateFromSigprocSlotsAt5(block) {
  const channels = block?.channels;
  const shared = block?.ghShared;
  if (!Array.isArray(channels) || !shared) {
    return false;
  }

  const channelCount = Math.max(0, Math.min(channels.length | 0, 2));
  if (channelCount <= 0) {
    return false;
  }

  const idx = activeSlotIndex(shared);
  const hdr = shared.headers?.[idx];
  if (!hdr) {
    return false;
  }

  const slot0 = channels[0]?.slots?.[0] ?? null;
  const global = slot0?.sharedPtr ?? null;
  if (!global) {
    hdr.enabled = 0;
    hdr.mode = 0;
    hdr.bandCount = 0;
    return true;
  }

  hdr.enabled = (global.enabled ?? 0) & 1;
  hdr.mode = (global.flag ?? 0) & 1;
  const bandCount = global.bandCount ?? 0;
  hdr.bandCount = bandCount | 0;

  const joint = global.jointFlags ?? null;
  const mix = global.mixFlags ?? null;
  if (hdr.c6Array instanceof Uint32Array) {
    for (let i = 0; i < AT5_GH_MAX_BANDS; i += 1) {
      hdr.c6Array[i] = (joint?.[i] ?? 0) ? 1 : 0;
    }
  }
  if (hdr.d8Array instanceof Uint32Array) {
    for (let i = 0; i < AT5_GH_MAX_BANDS; i += 1) {
      hdr.d8Array[i] = (mix?.[i] ?? 0) ? 1 : 0;
    }
  }

  hdr.c4Enable = 0;
  hdr.c5Mode = 0;
  hdr.d6Enable = 0;
  hdr.d7Mode = 0;
  hdr.e8Enable = 0;
  hdr.e9Mode = 0;
  if (hdr.eaArray instanceof Uint32Array) {
    hdr.eaArray.fill(0);
  }

  for (let ch = 0; ch < channelCount; ch += 1) {
    const channel = channels[ch];
    const srcSlot = channel?.slots?.[0] ?? null;
    const srcEntries = srcSlot?.records ?? null;
    const dstSlot = channel?.gh?.slots?.[idx] ?? null;
    const dstEntries = dstSlot?.entries ?? null;
    if (!srcSlot || !srcEntries || !dstSlot || !dstEntries) {
      continue;
    }

    for (let band = 0; band < AT5_GH_MAX_BANDS; band += 1) {
      const src = srcEntries[band] ?? null;
      const dst = dstEntries[band] ?? null;
      if (!src || !dst) {
        continue;
      }

      dst.idlocFlag0 = (src.gateStartValid ?? 0) >>> 0;
      dst.idlocFlag1 = (src.gateEndValid ?? 0) >>> 0;
      dst.idlocValue0 = (src.gateStartIdx ?? 0) | 0;
      dst.idlocValue1 = (src.gateEndIdx ?? 0) | 0;

      const count = (src.count ?? 0) | 0;
      dst.entryCount = count;

      const packed = src.entries;
      if (count <= 0 || !(packed instanceof Uint32Array)) {
        continue;
      }

      const items = dst.entries;
      const maxItems = Math.max(0, Math.min(count, items?.length ?? 0));
      for (let j = 0; j < maxItems; j += 1) {
        const base = (j * 4) | 0;
        const item = items[j];
        item.sftIndex = packed[base + 0] | 0;
        item.ampIndex = packed[base + 1] | 0;
        item.phaseBase = packed[base + 2] | 0;
        item.step = packed[base + 3] | 0;
      }
    }
  }

  return true;
}

export { calcNbitsForGhFreq0At5, calcNbitsForGhaAt5, syncGhStateFromSigprocSlotsAt5 };
