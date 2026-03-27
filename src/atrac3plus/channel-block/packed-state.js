import {
  AT5_IDWL_CONFIG_BAND_COUNT,
  AT5_IDWL_CONFIG_EXTRA_WORD,
  AT5_IDWL_CONFIG_GROUP,
  AT5_IDWL_CONFIG_ROW,
  AT5_IDWL_CONFIG_WL,
  calcNbitsForIdwlChAt5,
  calcNbitsForIdwlChInitAt5,
  idwlScratchConfigForSlot,
  idwlWorkMode1Base,
  idwlWorkMode1Lead,
  idwlWorkMode1Width,
  idwlWorkMode2PairFlag,
  idwlWorkMode2ShapeBase,
  idwlWorkMode2ShapeShift,
  idwlWorkMode2SymbolsView,
  updateAt5PresenceTableBits,
} from "../bitstream/internal.js";
import { readAt5RebitallocMirrorConfig } from "../rebitalloc-layout.js";
import { sharedMapSegmentCount } from "../shared-fields.js";
import {
  at5BandLimitFallsInReservedGap,
  AT5_BANDS_MAX,
  AT5_EXPANDED_BAND_LIMIT,
  AT5_EXPANDED_MAP_COUNT,
} from "./constants.js";

const AT5_IDWL_VALUE_COUNT = 32;
const IDWL_MODE_SELECTOR_BITS_PER_CHANNEL = 2;
const DISABLED_IDWL_BITS_PER_BAND = 3;

/**
 * Computes the current IDWL payload size for either the initial planner state
 * or the incremental update path, and seeds the disabled-IDWL scratch when the
 * stream omits IDWL entirely.
 */
export function computeIdwlBitsAt5(
  hdr,
  channels,
  blocks,
  channelCount,
  targetMode = 0,
  coeffIndex = 0
) {
  const count = channelCount | 0;
  if (count <= 0) {
    return 0;
  }

  const channelEntries = channels ?? [];
  const channelBlocks = blocks ?? [];
  let idwlBits = (count * IDWL_MODE_SELECTOR_BITS_PER_CHANNEL) | 0;
  if ((hdr?.idwlEnabled ?? 0) === 0) {
    const bandLimit = (channelEntries?.[0]?.shared?.bandLimit ?? 0) | 0;
    for (let ch = 0; ch < count; ch += 1) {
      const scratch = channelBlocks[ch].idwlScratch;
      scratch.bestConfigSlot = 0;
      scratch.slot0Config.fill(0);
      scratch.slot0Config[AT5_IDWL_CONFIG_BAND_COUNT] = bandLimit | 0;
      idwlBits = (idwlBits + bandLimit * DISABLED_IDWL_BITS_PER_BAND) | 0;
    }
    return idwlBits;
  }

  const useIncrementalMeasurement = (hdr?.idwlInitialized ?? 0) !== 0;
  if (!useIncrementalMeasurement) {
    hdr.idwlInitialized = 1;
  }

  const targetModeIndex = targetMode | 0;
  const coeffOffset = coeffIndex | 0;
  for (let ch = 0; ch < count; ch += 1) {
    idwlBits =
      (idwlBits +
        (useIncrementalMeasurement
          ? calcNbitsForIdwlChAt5(
              channelEntries[ch],
              channelBlocks[ch].idwlScratch,
              targetModeIndex,
              coeffOffset
            )
          : calcNbitsForIdwlChInitAt5(channelEntries[ch], channelBlocks[ch].idwlScratch))) |
      0;
  }
  return idwlBits;
}

function copySelectedIdwlConfigToChannel(channel, scratch) {
  const packMode = scratch?.bestConfigSlot & 3;
  const selectedConfig = idwlScratchConfigForSlot(scratch, packMode);
  if (!channel || !selectedConfig) {
    return -1;
  }

  const idwl = channel.idwl;
  channel.idwlPackMode = packMode;
  idwl.wl = selectedConfig[AT5_IDWL_CONFIG_WL] | 0;
  idwl.mode = selectedConfig[AT5_IDWL_CONFIG_GROUP] | 0;
  idwl.count = selectedConfig[AT5_IDWL_CONFIG_BAND_COUNT] | 0;
  idwl.extra = selectedConfig[AT5_IDWL_CONFIG_EXTRA_WORD] | 0;
  idwl.wlc = selectedConfig[AT5_IDWL_CONFIG_ROW] | 0;

  const rowSeq = scratch.rowSeq?.[idwl.wlc | 0] ?? null;
  if (rowSeq instanceof Int32Array) {
    const encodeValues =
      idwl.encodeValues instanceof Int32Array && idwl.encodeValues.length >= AT5_IDWL_VALUE_COUNT
        ? idwl.encodeValues
        : (idwl.encodeValues = new Int32Array(AT5_IDWL_VALUE_COUNT));
    encodeValues.set(rowSeq.subarray(0, AT5_IDWL_VALUE_COUNT));
  }

  return packMode;
}

function loadMode1IdwlWorkIntoState(idwl, work) {
  idwl.lead = idwlWorkMode1Lead(work);
  idwl.width = idwlWorkMode1Width(work);
  idwl.base = idwlWorkMode1Base(work);
}

function loadMode2IdwlWorkIntoState(channel, idwl, work) {
  const mode = idwl.mode | 0;
  idwl.shapeShift = idwlWorkMode2ShapeShift(work, mode);
  idwl.shapeBase = idwlWorkMode2ShapeBase(work, mode);
  idwl.pairFlag = idwlWorkMode2PairFlag(work);

  const encodeSymbols =
    idwl.encodeSymbols instanceof Uint32Array && idwl.encodeSymbols.length >= AT5_IDWL_VALUE_COUNT
      ? idwl.encodeSymbols
      : (idwl.encodeSymbols = new Uint32Array(AT5_IDWL_VALUE_COUNT));
  encodeSymbols.set(idwlWorkMode2SymbolsView(work, mode));

  const sharedIdwlState = channel.idwlState?.shared ?? channel.block0?.idwlState?.shared;
  const pairFlags = sharedIdwlState?.pairFlags ?? null;
  if (!(pairFlags instanceof Uint32Array)) {
    return;
  }

  const pairCount = idwl.count >>> 1;
  sharedIdwlState.pairCount = pairCount >>> 0;
  pairFlags.fill(0);
  for (let pairIndex = 0; pairIndex < Math.min(pairCount, pairFlags.length); pairIndex += 1) {
    const symbolIndex = pairIndex << 1;
    pairFlags[pairIndex] = Number(
      (encodeSymbols[symbolIndex] | encodeSymbols[symbolIndex + 1]) === 0
    );
  }
}

/**
 * Copies the selected IDWL packing configuration from block scratch into the
 * runtime channel state that later packers consume.
 */
export function at5CopyIdwlState(blocks, channels, channelCount) {
  for (let ch = 0; ch < (channelCount | 0); ch += 1) {
    const channel = channels?.[ch] ?? null;
    const scratch = blocks?.[ch]?.idwlScratch ?? null;
    const packMode = copySelectedIdwlConfigToChannel(channel, scratch);
    if (packMode < 0) {
      continue;
    }

    const idwl = channel.idwl;
    if (ch !== 0) {
      continue;
    }

    const work = blocks?.[ch]?.idwlWork;
    if (!(work instanceof Uint8Array)) {
      continue;
    }

    if (packMode === 1) {
      loadMode1IdwlWorkIntoState(idwl, work);
      continue;
    }
    if (packMode === 2) {
      loadMode2IdwlWorkIntoState(channel, idwl, work);
    }
  }
}

/**
 * Resets packed main-data fields after validation rejects the current solve.
 *
 * The shared block state stays explicit here so callers do not need the older
 * extracted convention of reaching through `channels[0].shared`.
 */
export function resetAt5MainData(shared, channels, channelCount, hdr) {
  const count = channelCount | 0;
  if (!shared || !Array.isArray(channels) || count <= 0 || !hdr) {
    return;
  }

  const bandLimit = (shared.bandLimit ?? 0) >>> 0;
  const channelMapCount = sharedMapSegmentCount(shared);

  shared.idsfCount = shared.mapCount = 0;
  shared.zeroSpectraFlag = 1;

  hdr.bitsIdwl = (((bandLimit * 3 + 2) * count) >>> 0) & 0xffff;
  hdr.bitsIdsf = 0;
  hdr.bitsIdct = 0;
  hdr.bitsStereoMaps = 0;
  hdr.bitsChannelMaps = 0;

  for (let i = 0; i < count; i += 1) {
    const channel = channels[i] ?? null;
    if (channel) {
      channel.idwlPackMode = 0;
      channel.idwl?.values?.fill(0);
      channel.scratchSpectra?.fill(0);
    }
    hdr.bitsChannelMaps =
      (hdr.bitsChannelMaps +
        (updateAt5PresenceTableBits(channel?.channelPresence ?? null, channelMapCount) | 0)) &
      0xffff;
  }

  if (count === 2) {
    for (const table of [shared.stereoSwapPresence, shared.stereoFlipPresence]) {
      hdr.bitsStereoMaps =
        (hdr.bitsStereoMaps + (updateAt5PresenceTableBits(table ?? null, 0) | 0)) & 0xffff;
    }
  }

  let totalBase = 0;
  for (const bits of [
    hdr.bitsGain,
    hdr.bitsFixed,
    hdr.bitsIdsf,
    hdr.bitsIdwl,
    hdr.bitsChannelMaps,
    hdr.bitsGha,
    hdr.bitsIdct,
    hdr.bitsMisc,
  ]) {
    totalBase = (totalBase + ((bits ?? 0) & 0xffff)) & 0xffff;
  }
  hdr.bitsTotalBase = totalBase;
  hdr.bitsTotal = ((hdr.bitsTotalBase | 0) + ((hdr.bitsStereoMaps ?? 0) & 0xffff)) & 0xffff;
}

function bandsContainOutOfRangeValue(values, maxValue) {
  const limit = Math.min(values?.length ?? 0, AT5_BANDS_MAX);
  for (let band = 0; band < limit; band += 1) {
    const value = values[band] | 0;
    if (value < 0 || value > maxValue) {
      return true;
    }
  }
  return false;
}

function hasInvalidMainDataState(channel, isPrimaryChannel, bandLimit, idsfCount, idctLimit) {
  const idwl = channel?.idwl ?? null;
  const mirror = readAt5RebitallocMirrorConfig(channel?.rebitallocMirrorBytes);
  const idwlPackMode = channel?.idwlPackMode | 0;
  const packedBandCount = idwl?.count | 0;
  const idwlMode = idwl?.mode | 0;

  if (
    bandsContainOutOfRangeValue(idwl?.values, 7) ||
    bandsContainOutOfRangeValue(channel?.idsf?.values, 0x3f) ||
    bandsContainOutOfRangeValue(channel?.idct?.values, idctLimit - 1)
  ) {
    return true;
  }

  if (isPrimaryChannel && idwlPackMode === 1 && packedBandCount > 0) {
    const mode1LeadBands = idwl?.lead | 0;
    if (mode1LeadBands < 0 || mode1LeadBands > packedBandCount) {
      return true;
    }
  }

  if ((idwlPackMode !== 0 || idwlMode !== 0) && packedBandCount > (bandLimit | 0)) {
    return true;
  }

  if (idwlMode === 3) {
    const extraBands = idwl?.extra | 0;
    // Mode-3 stores the tail boundary from opposite sides on the primary and
    // secondary channels, so each side has its own valid open/closed bounds.
    const mode3TailBoundary = isPrimaryChannel
      ? (bandLimit | 0) - extraBands
      : packedBandCount + extraBands;
    if (
      isPrimaryChannel
        ? mode3TailBoundary < packedBandCount || mode3TailBoundary >= (bandLimit | 0)
        : mode3TailBoundary <= packedBandCount || mode3TailBoundary > (bandLimit | 0)
    ) {
      return true;
    }
  }

  if (isPrimaryChannel && (idwl?.metaFlag | 0) === 1) {
    const metaA = idwl?.metaA | 0;
    const metaB = idwl?.metaB | 0;
    const metaMode = idwl?.metaMode | 0;
    if (metaA < 0 || metaA > (idsfCount | 0) || (metaMode !== 3 && metaB > 6)) {
      return true;
    }
  }

  if (mirror && mirror.flag !== 0 && (!isPrimaryChannel || mirror.mode < 3)) {
    const mirrorBandCount = mirror.bandCount | 0;
    if (mirrorBandCount < 0 || mirrorBandCount > (idsfCount | 0)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates the packed main-data state and resets it when the solve lands on a
 * reserved or out-of-range coding configuration.
 */
export function validateOrResetAt5MainData(shared, channels, channelCount, hdr) {
  const count = channelCount | 0;
  if (!shared || !hdr || !Array.isArray(channels) || count <= 0) {
    return false;
  }

  const bandLimit = (shared.bandLimit ?? 0) | 0;
  if (at5BandLimitFallsInReservedGap(bandLimit)) {
    shared.bandLimit = AT5_EXPANDED_BAND_LIMIT;
    shared.channelPresenceMapCount = AT5_EXPANDED_MAP_COUNT;
    resetAt5MainData(shared, channels, count, hdr);
    return false;
  }

  const idsfCount = (shared.idsfCount ?? 0) | 0;
  const idctLimit = (shared.gainModeFlag ?? 0) === 0 ? 4 : 8;
  for (let ch = 0; ch < count; ch += 1) {
    if (hasInvalidMainDataState(channels[ch] ?? null, ch === 0, bandLimit, idsfCount, idctLimit)) {
      resetAt5MainData(shared, channels, count, hdr);
      return false;
    }
  }

  return true;
}
