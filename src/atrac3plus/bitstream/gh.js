/**
 * Generalized-harmonic bitstream state and unpacking.
 *
 * Keeping the GH transport helpers at the bitstream root matches the other
 * stateful block payloads (`gain`, `idct`, `idsf`, `idwl`) and removes one
 * needless level of nesting from the ATRAC3plus tree.
 */
import { at5DecodeSym, at5ReadBits, at5SignExtend3Bit, at5SignExtend5Bit } from "./bitstream.js";
import { AT5_HC_GHPC } from "../tables/unpack.js";
import { ghBitWidth } from "./gh-util.js";

const AT5_GH_BANDS = 16;
const AT5_GH_ITEMS_PER_BAND = 16;
const AT5_GH_ITEM_MAP_COUNT = 0x30;
const AT5_GH_TOTAL_ITEMS_LIMIT = 0x30;
const AT5_ERROR_GH_TOO_MANY_ENTRIES = 0x11a;

const AT5_GH_IDLOC_VALUE0_DISABLED = 0xffffffff >>> 0;
const AT5_GH_IDLOC_VALUE1_DISABLED = 0x20;

function createAt5GhItem() {
  return {
    sftIndex: 0,
    ampIndex: 0,
    phaseBase: 0,
    step: 0,
  };
}

function createAt5GhSynthCtx() {
  return {
    hasLeftFade: 0,
    hasRightFade: 0,
    leftIndex: 0,
    rightIndex: 0,
    idlocFlag0: 0,
    idlocFlag1: 0,
    idlocValue0: 0,
    idlocValue1: 0,
    entryCount: 0,
    entries: Array.from({ length: AT5_GH_ITEMS_PER_BAND }, () => createAt5GhItem()),
  };
}

function createAt5GhSlot() {
  return {
    entries: Array.from({ length: AT5_GH_BANDS }, () => createAt5GhSynthCtx()),
  };
}

function createAt5GhHeader() {
  return {
    enabled: 0,
    mode: 0,
    bandCount: 0,
    allocCount: 0,
    c4Enable: 0,
    c5Mode: 0,
    c6Array: new Uint32Array(AT5_GH_BANDS),
    d6Enable: 0,
    d7Mode: 0,
    d8Array: new Uint32Array(AT5_GH_BANDS),
    e8Enable: 0,
    e9Mode: 0,
    eaArray: new Uint32Array(AT5_GH_BANDS),
  };
}

export function createAt5GhSharedState(channelCount) {
  return {
    channelCount: channelCount >>> 0,
    slotIndex: 1,
    itemMap: new Int32Array(AT5_GH_ITEM_MAP_COUNT),
    headers: [createAt5GhHeader(), createAt5GhHeader()],
  };
}

export function createAt5GhChannelState(channelIndex, block0 = null, shared = null) {
  return {
    channelIndex: channelIndex >>> 0,
    block0: block0 ?? null,
    blockErrorCode: 0,
    shared: shared ?? null,
    gh: {
      modeIdloc: 0,
      modeNwavs: 0,
      modeFreq: 0,
      modeIdsf: 0,
      modeIdam: 0,
      presentFlags: new Uint32Array(AT5_GH_BANDS),
      freqFlags: new Uint32Array(AT5_GH_BANDS),
      slots: [createAt5GhSlot(), createAt5GhSlot()],
    },
  };
}

function activeSlotIndex(shared) {
  return (shared.slotIndex >>> 0) & 1;
}

function currentSlot(channel, shared) {
  return channel.gh.slots[activeSlotIndex(shared)];
}

function previousSlot(channel, shared) {
  return channel.gh.slots[activeSlotIndex(shared) ^ 1];
}

function baseCurrentSlot(channel, shared) {
  const base = channel.block0 ?? channel;
  return currentSlot(base, shared);
}

function setBlockError(channel, code) {
  channel.blockErrorCode = code >>> 0;
}

function clearSynthCtx(ctx) {
  ctx.hasLeftFade = 0;
  ctx.hasRightFade = 0;
  ctx.leftIndex = 0;
  ctx.rightIndex = 0;
  ctx.idlocFlag0 = 0;
  ctx.idlocFlag1 = 0;
  ctx.idlocValue0 = 0;
  ctx.idlocValue1 = AT5_GH_IDLOC_VALUE1_DISABLED;
  ctx.entryCount = 0;

  const entries = ctx.entries;
  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i];
    item.sftIndex = 0;
    item.ampIndex = 0;
    item.phaseBase = 0;
    item.step = 0;
  }
}

export function clearAt5GhSlot(slot) {
  const bands = slot.entries;
  for (let i = 0; i < bands.length; i += 1) {
    clearSynthCtx(bands[i]);
  }
}

function copyItem(dst, src) {
  dst.sftIndex = src.sftIndex;
  dst.ampIndex = src.ampIndex;
  dst.phaseBase = src.phaseBase;
  dst.step = src.step;
}

function copySynthCtx(dst, src) {
  dst.hasLeftFade = src.hasLeftFade;
  dst.hasRightFade = src.hasRightFade;
  dst.leftIndex = src.leftIndex;
  dst.rightIndex = src.rightIndex;
  dst.idlocFlag0 = src.idlocFlag0;
  dst.idlocFlag1 = src.idlocFlag1;
  dst.idlocValue0 = src.idlocValue0;
  dst.idlocValue1 = src.idlocValue1;
  dst.entryCount = src.entryCount;

  const dstEntries = dst.entries;
  const srcEntries = src.entries;
  for (let i = 0; i < AT5_GH_ITEMS_PER_BAND; i += 1) {
    copyItem(dstEntries[i], srcEntries[i]);
  }
}

function copyIdlocFields(dst, src) {
  dst.idlocFlag0 = src.idlocFlag0;
  dst.idlocFlag1 = src.idlocFlag1;
  dst.idlocValue0 = src.idlocValue0;
  dst.idlocValue1 = src.idlocValue1;
}

function swapSynthCtx(left, right) {
  const temp = createAt5GhSynthCtx();
  copySynthCtx(temp, right);
  copySynthCtx(right, left);
  copySynthCtx(left, temp);
}

function at5SignExtend8Bit(value) {
  const v = value & 0xff;
  return (v & 0x80) !== 0 ? v | ~0xff : v;
}

function unpackHeaderBoolArray(header, enableKey, modeKey, arrayKey, count, frame, bitState) {
  const array = header[arrayKey];
  array.fill(0);

  const enable = at5ReadBits(frame, bitState, 1);
  header[enableKey] = enable;
  if (enable === 0) {
    header[modeKey] = 0;
    return;
  }

  const mode = at5ReadBits(frame, bitState, 1);
  header[modeKey] = mode;
  if (mode === 0) {
    array.fill(1, 0, count);
    return;
  }

  for (let i = 0; i < count; i += 1) {
    array[i] = at5ReadBits(frame, bitState, 1);
  }
}

function unpackGhIdloc(channel, shared, frame, bitState, bandCount, mode) {
  const present = channel.gh.presentFlags;
  const entries = currentSlot(channel, shared).entries;
  const baseEntries = (mode & 1) === 0 ? null : baseCurrentSlot(channel, shared).entries;

  for (let i = 0; i < bandCount; i += 1) {
    if (present[i] === 0) {
      continue;
    }

    const entry = entries[i];
    if (baseEntries) {
      copyIdlocFields(entry, baseEntries[i]);
      continue;
    }

    const flag0 = at5ReadBits(frame, bitState, 1);
    entry.idlocFlag0 = flag0;
    entry.idlocValue0 =
      flag0 === 0 ? AT5_GH_IDLOC_VALUE0_DISABLED : at5ReadBits(frame, bitState, 5);

    const flag1 = at5ReadBits(frame, bitState, 1);
    entry.idlocFlag1 = flag1;
    entry.idlocValue1 =
      flag1 === 0 ? AT5_GH_IDLOC_VALUE1_DISABLED : at5ReadBits(frame, bitState, 5);
  }
}

function unpackGhNwavs(channel, shared, frame, bitState, bandCount, mode) {
  const present = channel.gh.presentFlags;
  const entries = currentSlot(channel, shared).entries;
  const modeId = mode & 3;
  const baseEntries = modeId < 2 ? null : baseCurrentSlot(channel, shared).entries;

  for (let i = 0; i < bandCount; i += 1) {
    if (present[i] === 0) {
      continue;
    }

    if (modeId === 0) {
      entries[i].entryCount = at5ReadBits(frame, bitState, 4);
    } else if (modeId === 1) {
      entries[i].entryCount = at5DecodeSym(AT5_HC_GHPC.NWAVS_A, frame, bitState);
    } else if (modeId === 2) {
      const delta = at5SignExtend3Bit(at5DecodeSym(AT5_HC_GHPC.NWAVS_B, frame, bitState));
      entries[i].entryCount = (baseEntries[i].entryCount + delta) & 0x0f;
    } else {
      entries[i].entryCount = baseEntries[i].entryCount;
    }
  }
}

function ghFreqBitsFromPrev(prev) {
  const value = prev & 0x3ff;
  const bits = ghBitWidth(0x3ff - value);
  return { bits, add: ((value >>> bits) << bits) >>> 0 };
}

function ghFreqBitsFromNext(nextValue) {
  return ghBitWidth(nextValue);
}

function decodeGhFreqUpward(entry, frame, bitState) {
  const count = entry.entryCount | 0;
  if (count <= 0) {
    return;
  }

  const items = entry.entries;
  items[0].step = at5ReadBits(frame, bitState, 10);

  for (let i = 1; i < count; i += 1) {
    const prev = items[i - 1].step >>> 0;
    const { bits, add } = ghFreqBitsFromPrev(prev);
    items[i].step = at5ReadBits(frame, bitState, bits) + add;
  }
}

function decodeGhFreqReverse(entry, frame, bitState) {
  const count = entry.entryCount | 0;
  if (count <= 0) {
    return;
  }

  const items = entry.entries;
  const last = count - 1;
  items[last].step = at5ReadBits(frame, bitState, 10);

  for (let i = last - 1; i >= 0; i -= 1) {
    const next = items[i + 1].step >>> 0;
    const bits = ghFreqBitsFromNext(next);
    items[i].step = at5ReadBits(frame, bitState, bits);
  }
}

function unpackGhFreq(channel, shared, frame, bitState, bandCount, mode) {
  const present = channel.gh.presentFlags;
  const flags = channel.gh.freqFlags;
  const entries = currentSlot(channel, shared).entries;
  const baseEntries = (mode & 1) === 0 ? null : baseCurrentSlot(channel, shared).entries;

  for (let i = 0; i < bandCount; i += 1) {
    if (present[i] === 0) {
      continue;
    }

    const entry = entries[i];
    const count = entry.entryCount | 0;
    if (!baseEntries) {
      const flag = count > 1 ? at5ReadBits(frame, bitState, 1) : 0;
      flags[i] = flag;

      if (flag === 0) {
        decodeGhFreqUpward(entry, frame, bitState);
      } else {
        decodeGhFreqReverse(entry, frame, bitState);
      }
      continue;
    }

    if (count <= 0) {
      continue;
    }

    const base = baseEntries[i];
    const baseCount = base.entryCount | 0;

    for (let j = 0; j < count; j += 1) {
      const delta = at5SignExtend8Bit(at5DecodeSym(AT5_HC_GHPC.FREQ_A, frame, bitState));

      let baseValue = 0;
      if (j < baseCount) {
        baseValue = base.entries[j].step | 0;
      } else if (baseCount > 0) {
        baseValue = base.entries[baseCount - 1].step | 0;
      }

      entry.entries[j].step = (baseValue + delta) & 0x3ff;
    }
  }
}

function buildGhItemMap(channel, shared, bandCount) {
  if (channel.channelIndex >>> 0 !== 1 || bandCount === 0) {
    return;
  }

  const present = channel.gh.presentFlags;
  const currentEntries = currentSlot(channel, shared).entries;
  const baseEntries = baseCurrentSlot(channel, shared).entries;
  const map = shared.itemMap;

  let outIndex = 0;
  for (let entry = 0; entry < bandCount; entry += 1) {
    if (present[entry] === 0) {
      continue;
    }

    const curCtx = currentEntries[entry];
    const curCount = curCtx.entryCount | 0;
    if (curCount <= 0) {
      continue;
    }

    const baseCtx = baseEntries[entry];
    const baseCount = Math.min(baseCtx.entryCount | 0, AT5_GH_ITEMS_PER_BAND);

    for (let i = 0; i < curCount; i += 1) {
      if (outIndex >= map.length) {
        return;
      }

      if (baseCount <= 0) {
        map[outIndex] = -1;
        outIndex += 1;
        continue;
      }

      let bestIndex = 0;
      let bestDiff = 0x400;

      const curFreq = curCtx.entries[i].step | 0;
      for (let j = 0; j < baseCount; j += 1) {
        const diff = Math.abs(curFreq - (baseCtx.entries[j].step | 0));
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIndex = j;
        }
      }

      map[outIndex] = bestDiff > 7 ? (i < baseCount ? i : -1) : bestIndex;
      outIndex += 1;
    }
  }
}

function forEachPresentGhBand(channel, shared, bandCount, visit) {
  const present = channel.gh.presentFlags;
  const entries = currentSlot(channel, shared).entries;

  for (let band = 0; band < bandCount; band += 1) {
    if (present[band] === 0) {
      continue;
    }

    const entry = entries[band];
    visit(entry, entry.entryCount | 0, band);
  }
}

function forEachGhItem(entry, count, visit) {
  for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
    visit(entry.entries[itemIndex], itemIndex);
  }
}

function fillGhItems(entry, count, field, value) {
  forEachGhItem(entry, count, (item) => {
    item[field] = value;
  });
}

function forEachMappedGhItem(channel, shared, bandCount, visit) {
  const baseEntries = baseCurrentSlot(channel, shared).entries;
  const itemMap = shared.itemMap;
  let mapIndex = 0;

  forEachPresentGhBand(channel, shared, bandCount, (entry, count, band) => {
    const itemCount = count > 0 ? count : 0;
    if (itemCount > 0) {
      const base = baseEntries[band];
      forEachGhItem(entry, itemCount, (item, itemIndex) => {
        visit(item, base, itemMap[mapIndex + itemIndex]);
      });
    }
    mapIndex += itemCount;
  });
}

function unpackGhIdsf(channel, shared, headerMode, frame, bitState, bandCount, mode) {
  const modeId = mode & 3;

  if (modeId < 2) {
    forEachPresentGhBand(channel, shared, bandCount, (entry, count) => {
      if (count <= 0) {
        return;
      }

      if (headerMode === 0) {
        const value =
          modeId === 0
            ? at5ReadBits(frame, bitState, 6)
            : at5DecodeSym(AT5_HC_GHPC.IDSF_AA, frame, bitState) + 0x18;
        fillGhItems(entry, count, "sftIndex", value);
        return;
      }

      forEachGhItem(entry, count, (item) => {
        item.sftIndex =
          modeId === 0
            ? at5ReadBits(frame, bitState, 6)
            : at5DecodeSym(AT5_HC_GHPC.IDSF_AB, frame, bitState) + 0x14;
      });
    });
    return;
  }

  const copyOnly = modeId === 3;
  const baseEntries = baseCurrentSlot(channel, shared).entries;

  if (headerMode === 0) {
    forEachPresentGhBand(channel, shared, bandCount, (entry, count, band) => {
      if (count <= 0) {
        return;
      }

      const base = baseEntries[band];
      const baseCount = base.entryCount | 0;
      const baseValue = baseCount > 0 ? base.entries[0].sftIndex | 0 : copyOnly ? 0x31 : 0x2c;
      const value = copyOnly
        ? baseValue >>> 0
        : (baseValue + at5SignExtend5Bit(at5DecodeSym(AT5_HC_GHPC.IDSF_B, frame, bitState))) & 0x3f;
      fillGhItems(entry, count, "sftIndex", value);
    });
    return;
  }

  forEachMappedGhItem(channel, shared, bandCount, (item, base, map) => {
    if (copyOnly) {
      item.sftIndex = map >= 0 ? base.entries[map].sftIndex >>> 0 : 0x20;
      return;
    }

    const delta = at5SignExtend5Bit(at5DecodeSym(AT5_HC_GHPC.IDSF_B, frame, bitState));
    const baseValue = map < 0 ? 0x22 : base.entries[map].sftIndex | 0;
    item.sftIndex = (baseValue + delta) & 0x3f;
  });
}

function unpackGhIdam(channel, shared, frame, bitState, bandCount, mode) {
  const modeId = mode & 3;

  if (modeId === 0) {
    forEachPresentGhBand(channel, shared, bandCount, (entry, count) => {
      forEachGhItem(entry, count, (item) => {
        item.ampIndex = at5ReadBits(frame, bitState, 4);
      });
    });
    return;
  }

  if (modeId === 1) {
    forEachPresentGhBand(channel, shared, bandCount, (entry, count) => {
      if (count <= 0) {
        return;
      }

      if (count === 1) {
        entry.entries[0].ampIndex = at5DecodeSym(AT5_HC_GHPC.IDAM_AA, frame, bitState);
        return;
      }

      forEachGhItem(entry, count, (item) => {
        item.ampIndex = at5DecodeSym(AT5_HC_GHPC.IDAM_AB, frame, bitState);
      });
    });
    return;
  }

  const copyOnly = modeId === 3;
  forEachMappedGhItem(channel, shared, bandCount, (item, base, map) => {
    if (copyOnly) {
      item.ampIndex = map >= 0 ? base.entries[map].ampIndex >>> 0 : 0x0e;
      return;
    }

    const delta = at5SignExtend3Bit(at5DecodeSym(AT5_HC_GHPC.IDAM_C, frame, bitState));
    const baseValue = map < 0 ? 0x0c : base.entries[map].ampIndex | 0;
    item.ampIndex = (baseValue + delta) & 0x0f;
  });
}

function unpackGhIdlev(channel, shared, frame, bitState, bandCount) {
  forEachPresentGhBand(channel, shared, bandCount, (entry, count) => {
    forEachGhItem(entry, count, (item) => {
      item.phaseBase = at5ReadBits(frame, bitState, 5);
    });
  });
}

function applyStereoFixes(channels, shared, header, bandCount) {
  const left = channels[0];
  const right = channels[1];

  const leftSlot0 = previousSlot(left, shared).entries;
  const rightSlot0 = previousSlot(right, shared).entries;
  const leftSlot1 = currentSlot(left, shared).entries;
  const rightSlot1 = currentSlot(right, shared).entries;

  for (let entry = 0; entry < bandCount; entry += 1) {
    if (header.c6Array[entry] !== 0) {
      copySynthCtx(rightSlot1[entry], leftSlot1[entry]);
      copyIdlocFields(rightSlot0[entry], leftSlot0[entry]);
    }

    if (header.eaArray[entry] !== 0) {
      swapSynthCtx(leftSlot1[entry], rightSlot1[entry]);
    }
  }
}

function resetGhHeader(header) {
  header.c6Array.fill(0);
  header.d8Array.fill(0);
  header.eaArray.fill(0);
  header.c4Enable = 0;
  header.c5Mode = 0;
  header.d6Enable = 0;
  header.d7Mode = 0;
  header.e8Enable = 0;
  header.e9Mode = 0;
  header.allocCount = 0;
}

function resetGhRuntime(channel) {
  const gh = channel.gh;
  gh.modeIdloc = 0;
  gh.modeNwavs = 0;
  gh.modeFreq = 0;
  gh.modeIdsf = 0;
  gh.modeIdam = 0;
  gh.presentFlags.fill(0);
  gh.freqFlags.fill(0);
}

function resetGhBlockRuntime(channels, shared) {
  for (const channel of channels) {
    resetGhRuntime(channel);
    clearAt5GhSlot(currentSlot(channel, shared));
  }
}

function readGhHeader(header, frame, bitState) {
  const enabled = at5ReadBits(frame, bitState, 1);
  header.enabled = enabled;
  if (enabled === 0) {
    header.mode = 0;
    header.bandCount = 0;
    return 0;
  }

  header.mode = at5ReadBits(frame, bitState, 1);
  header.bandCount = at5DecodeSym(AT5_HC_GHPC.NBANDS, frame, bitState) + 1;
  return header.bandCount >>> 0;
}

export function unpackGh(block, frame, bitState) {
  if (!block || !Array.isArray(block.channels) || !block.ghShared) {
    throw new TypeError("invalid AT5 GH unpack block");
  }

  const channels = block.channels;
  const channelCount = channels.length >>> 0;
  if (channelCount < 1 || channelCount > 2) {
    return true;
  }

  const shared = block.ghShared;
  const slotIndex = activeSlotIndex(shared);
  const header = shared.headers[slotIndex];

  resetGhHeader(header);
  resetGhBlockRuntime(channels, shared);

  const bandCount = readGhHeader(header, frame, bitState);
  if (bandCount === 0) {
    return true;
  }

  if (channelCount === 2) {
    unpackHeaderBoolArray(header, "c4Enable", "c5Mode", "c6Array", bandCount, frame, bitState);
    unpackHeaderBoolArray(header, "e8Enable", "e9Mode", "eaArray", bandCount, frame, bitState);
    unpackHeaderBoolArray(header, "d6Enable", "d7Mode", "d8Array", bandCount, frame, bitState);
  }

  for (const channel of channels) {
    const isPrimary = channel.channelIndex >>> 0 === 0;
    const gh = channel.gh;
    const present = gh.presentFlags;
    present.fill(0);

    if (isPrimary) {
      present.fill(1, 0, bandCount);
    } else {
      for (let i = 0; i < bandCount; i += 1) {
        present[i] = header.c6Array[i] === 0 ? 1 : 0;
      }
    }

    gh.modeIdloc = isPrimary ? 0 : at5ReadBits(frame, bitState, 1);
    unpackGhIdloc(channel, shared, frame, bitState, bandCount, gh.modeIdloc);

    gh.modeNwavs = at5ReadBits(frame, bitState, isPrimary ? 1 : 2);
    unpackGhNwavs(channel, shared, frame, bitState, bandCount, gh.modeNwavs);

    let combinedEntryCount = 0;
    const slotBands = currentSlot(channel, shared).entries;
    for (let band = 0; band < bandCount; band += 1) {
      combinedEntryCount += slotBands[band].entryCount >>> 0;
    }
    if (!isPrimary) {
      const baseBands = baseCurrentSlot(channel, shared).entries;
      for (let band = 0; band < bandCount; band += 1) {
        combinedEntryCount += baseBands[band].entryCount >>> 0;
      }
    }
    if (combinedEntryCount > AT5_GH_TOTAL_ITEMS_LIMIT) {
      setBlockError(channel, AT5_ERROR_GH_TOO_MANY_ENTRIES);
      return false;
    }

    gh.modeFreq = isPrimary ? 0 : at5ReadBits(frame, bitState, 1);
    unpackGhFreq(channel, shared, frame, bitState, bandCount, gh.modeFreq);
    buildGhItemMap(channel, shared, bandCount);

    gh.modeIdsf = at5ReadBits(frame, bitState, isPrimary ? 1 : 2);
    unpackGhIdsf(channel, shared, header.mode >>> 0, frame, bitState, bandCount, gh.modeIdsf);

    if ((header.mode | 0) !== 0) {
      gh.modeIdam = 0;
    } else {
      gh.modeIdam = at5ReadBits(frame, bitState, isPrimary ? 1 : 2);
      unpackGhIdam(channel, shared, frame, bitState, bandCount, gh.modeIdam);
    }

    unpackGhIdlev(channel, shared, frame, bitState, bandCount);
  }

  if (channelCount === 2) {
    applyStereoFixes(channels, shared, header, bandCount);
  }

  return true;
}

export const AT5_GH_ERROR_CODES = {
  TOO_MANY_ENTRIES: AT5_ERROR_GH_TOO_MANY_ENTRIES,
};
