import { createAt5RebitallocScratch } from "../rebitalloc-layout.js";
import { AT5_BANDS_MAX } from "./constants.js";

const AT5_QUANT_SCRATCH_SIZE = 128;
const AT5_IDWL_WORK_BYTES = 0x290;
const AT5_HCSPEC_CONTEXT_COUNT = 2;
const AT5_HCSPEC_COSTS_PER_BAND = 8;
const AT5_IDWL_SLOT_COUNT = 4;
const AT5_IDWL_SLOT_WORDS = 5;
const AT5_IDWL_ROW_COUNT = 4;
const AT5_IDWL_ROW_WIDTH = 32;

/**
 * Cached HCSPEC scoring tables for one channel/context pair.
 *
 * The solver reuses these per-band costs while probing bitalloc offsets and
 * rebitalloc choices so unchanged bands do not need to be requantized.
 *
 * @typedef {object} At5HcspecWork
 * @property {Int32Array} bestIndexByBand Cheapest HCSPEC selector chosen for each band.
 * @property {Uint16Array} costsByBand Eight candidate HCSPEC costs packed band-by-band.
 */

/**
 * Temporary quantization buffers reused while one channel block is being
 * scored and requantized.
 *
 * @typedef {object} At5QuantScratch
 * @property {Int16Array} quantBufI16 Signed scalar quantization output.
 * @property {Uint8Array} quantBufBytes Byte view over `quantBufI16` for pack helpers.
 * @property {Uint16Array} groupedMode1U16 Grouped mode-1 staging buffer.
 * @property {Uint16Array} groupedMode2U16 Grouped mode-2 staging buffer.
 * @property {Uint16Array} groupedMode4U16 Grouped mode-4 staging buffer.
 * @property {Uint16Array} absBufU16 Absolute-value staging buffer.
 * @property {Uint8Array} absBufBytes Byte view over `absBufU16`.
 * @property {Uint16Array} absGroupedMode2U16 Absolute grouped mode-2 staging buffer.
 * @property {Uint16Array} absGroupedMode4U16 Absolute grouped mode-4 staging buffer.
 */

/**
 * Per-channel IDWL planning scratch reused across bootstrap scoring and the
 * later pack-mode repacks.
 *
 * @typedef {object} At5IdwlScratch
 * @property {number} bestConfigSlot Winning slot among the four candidate pack layouts.
 * @property {Int32Array} costs Bit cost for each candidate slot.
 * @property {Int32Array} slot0Config Candidate config words for slot 0:
 * width level, group, band count, extra word, row.
 * @property {Int32Array} slot1Config Candidate config words for slot 1:
 * width level, group, band count, extra word, row.
 * @property {Int32Array} slot2Config Candidate config words for slot 2:
 * width level, group, band count, extra word, row.
 * @property {Int32Array} slot3Config Candidate config words for slot 3:
 * width level, group, band count, extra word, row.
 * @property {Int32Array} rowEnabled Row enable flags used by the planner.
 * @property {Uint8Array|null} work Shared raw IDWL work area borrowed from block 0.
 * @property {Int32Array[]} rowSeq Row-local staged mode values.
 * @property {Int32Array} bandCountBySlot Cached band counts for mapped slot groups.
 * @property {Int32Array} mappedGroupBySlot Cached mapped group index for each slot entry.
 * @property {Int32Array} extraWordByIndex Extra per-row words charged by the selected plan.
 */

/**
 * Shared mutable header state for one ATRAC3plus regular block during encode.
 *
 * This object owns the block-level mode selectors, late rebitalloc sweep
 * bounds, accumulated bit totals, and the active/probe HCSPEC caches mirrored
 * out of each per-channel block state.
 *
 * @typedef {object} At5BitallocHeader
 * @property {number} tblIndex Active gain/bitalloc table family.
 * @property {Int32Array} idsfValues Shared mode-3 difference scalefactors.
 * @property {number} idwlEnabled Whether IDWL payloads stay enabled for this solve.
 * @property {number} idwlInitialized Whether the initial IDWL pack state has been seeded.
 * @property {number} idsfModeWord Shared IDSF packing mode selector.
 * @property {number} baseBits Fixed header base-bit field written into the block.
 * @property {Uint16Array} mode3BandMask Bands where stereo mode 3 reuses channel 0 data.
 * @property {Uint16Array} mode3DeltaFlags Bands where mode-3 reuse fell back to delta coding.
 * @property {number} cbIterLimit Maximum downward rebitalloc sweeps after bootstrap.
 * @property {number} cbStartBand First band where the late rebitalloc sweep is allowed to start.
 * @property {number} bitsFixed Fixed header bit count.
 * @property {number} bitsIdwl IDWL payload bit count.
 * @property {number} bitsIdsf IDSF payload bit count.
 * @property {number} bitsIdct IDCT payload bit count.
 * @property {number} bitsStereoMaps Stereo map payload bit count.
 * @property {number} bitsChannelMaps Channel presence payload bit count.
 * @property {number} bitsGain Gain payload bit count.
 * @property {number} bitsGha GH payload bit count.
 * @property {number} bitsMisc Miscellaneous payload bit count.
 * @property {number} bitsTotalBase Total before live HCSPEC/IDCT solve updates.
 * @property {number} bitsTotal Current solved total bit count.
 * @property {number|null} debugSecondBitOffset Optional debug trace of the
 * multiblock second-bit allocation offset.
 * @property {(At5HcspecWork|null)[]} hcspecTblA Active HCSPEC costs for each channel.
 * @property {(At5HcspecWork|null)[]} hcspecTblB Alternate HCSPEC costs used while probing.
 */

/**
 * Mutable per-channel ATRAC3plus block state owned by the channel-block solve
 * pipeline.
 *
 * The bootstrap stage seeds spectrum statistics and initial mode guesses here,
 * then the late solver mutates the same object through IDWL, HCSPEC,
 * rebitalloc, SPC-level, and requantization passes.
 *
 * @typedef {object} At5ChannelBlock
 * @property {number} baseMaxQuantMode Core-mode quant ceiling before per-band shaping.
 * @property {Int16Array} maxQuantModeByBand Late quant ceiling for each band.
 * @property {number} bitallocMode Selected bitalloc heuristic family for this channel.
 * @property {number} gainRecordRangeFlag Packed gain-record range classification.
 * @property {Uint16Array} bitDeltaByCtx Cached HCSPEC bit totals for the two work contexts.
 * @property {Int32Array} quantUnitsByBand Quantized coefficient count per band.
 * @property {Int32Array} quantOffsetByBand Late rebitalloc offset per band.
 * @property {Int32Array} quantModeByBand Current solved IDWL mode per band.
 * @property {Float32Array} quantModeBaseByBand Floating bootstrap mode target per band.
 * @property {Float32Array} normalizedBandPeaks Per-band peaks after IDSF normalization.
 * @property {Float32Array} bandPeaks Raw per-band peaks from runtime staging.
 * @property {Float32Array} bitallocBandPeaks Peaks measured from the bitalloc spectrum.
 * @property {Float32Array} bandLevels Derived scalefactor levels used by heuristics.
 * @property {number} bitallocScale Shared scale applied to quant-unit heuristics.
 * @property {number} avgBandLevel Average paired-band level used by low-band heuristics.
 * @property {number} wideGainBoostFlag Whether wide first-record gain boosts are allowed.
 * @property {At5IdwlScratch} idwlScratch Per-channel IDWL planning scratch.
 * @property {Uint8Array} idwlWork Shared raw IDWL planner workspace.
 * @property {object} rebitallocScratch Rebitalloc pack/refine scratch tables.
 * @property {At5HcspecWork[]} hcspecWorkByCtx Per-context HCSPEC caches owned by this block.
 * @property {At5BitallocHeader|null} bitallocHeader Shared block header currently attached.
 * @property {object|null} blockState Runtime block-state view copied from the codec pipeline.
 * @property {Float32Array|null} quantizedSpectrum Live quantized spectrum being solved in place.
 * @property {At5QuantScratch} quantScratch Reusable quantization scratch for band scoring.
 */

/**
 * Creates the shared per-block header used throughout the ATRAC3plus
 * channel-block encode pipeline.
 *
 * @param {number} channelCount Number of channels in the regular block.
 * @returns {At5BitallocHeader}
 */
export function createBitallocHeader(channelCount) {
  const channels = channelCount | 0;
  const hcspecChannelCount = Math.max(0, Math.min(channels, AT5_HCSPEC_CONTEXT_COUNT));
  return {
    tblIndex: 0,
    idsfValues: new Int32Array(AT5_BANDS_MAX),
    idwlEnabled: 1,
    idwlInitialized: 0,
    idsfModeWord: 1,
    baseBits: 4,
    mode3BandMask: new Uint16Array(AT5_BANDS_MAX),
    mode3DeltaFlags: new Uint16Array(AT5_BANDS_MAX),
    cbIterLimit: 0,
    cbStartBand: 0,
    bitsFixed: 0,
    bitsIdwl: 0,
    bitsIdsf: 0,
    bitsIdct: 0,
    bitsStereoMaps: 0,
    bitsChannelMaps: 0,
    bitsGain: 0,
    bitsGha: 0,
    bitsMisc: 0,
    bitsTotalBase: 0,
    bitsTotal: 0,
    debugSecondBitOffset: null,
    hcspecTblA: Array.from({ length: hcspecChannelCount }, () => null),
    hcspecTblB: Array.from({ length: hcspecChannelCount }, () => null),
  };
}

function fillWithZero(view) {
  view?.fill?.(0);
}

function clearArrayPrefix(array, count, value = null) {
  if (!Array.isArray(array)) {
    return;
  }

  for (let index = 0; index < count; index += 1) {
    array[index] = value;
  }
}

function clearHeaderSpecTables(header, channelCount) {
  const count = Math.max(0, Math.min(channelCount | 0, AT5_HCSPEC_CONTEXT_COUNT));
  clearArrayPrefix(header?.hcspecTblA, count);
  clearArrayPrefix(header?.hcspecTblB, count);
}

/**
 * Allocates the per-channel IDWL planning scratch.
 *
 * The four slot configs correspond to the candidate pack-mode slots scored by
 * the IDWL cost planner, while the per-row/group tables cache the band counts
 * and extra words reused across those candidate passes.
 *
 * @param {Uint8Array|null} [work=null] Shared raw work area borrowed from block 0.
 * @returns {At5IdwlScratch}
 */
export function createAt5IdwlScratch(work = null) {
  return {
    bestConfigSlot: 0,
    costs: new Int32Array(AT5_IDWL_SLOT_COUNT),
    slot0Config: new Int32Array(AT5_IDWL_SLOT_WORDS),
    slot1Config: new Int32Array(AT5_IDWL_SLOT_WORDS),
    slot2Config: new Int32Array(AT5_IDWL_SLOT_WORDS),
    slot3Config: new Int32Array(AT5_IDWL_SLOT_WORDS),
    rowEnabled: new Int32Array(AT5_IDWL_ROW_COUNT),
    work,
    rowSeq: Array.from({ length: AT5_IDWL_ROW_COUNT }, () => new Int32Array(AT5_IDWL_ROW_WIDTH)),
    bandCountBySlot: new Int32Array(16),
    mappedGroupBySlot: new Int32Array(16),
    extraWordByIndex: new Int32Array(AT5_IDWL_ROW_COUNT),
  };
}

/** @returns {At5HcspecWork} */
function createAt5HcspecWork() {
  return {
    bestIndexByBand: new Int32Array(AT5_BANDS_MAX),
    costsByBand: new Uint16Array(AT5_BANDS_MAX * AT5_HCSPEC_COSTS_PER_BAND),
  };
}

/** @returns {At5QuantScratch} */
function createAt5QuantScratch() {
  const quantBufI16 = new Int16Array(AT5_QUANT_SCRATCH_SIZE);
  const absBufU16 = new Uint16Array(AT5_QUANT_SCRATCH_SIZE);

  return {
    quantBufI16,
    quantBufBytes: new Uint8Array(quantBufI16.buffer),
    groupedMode1U16: new Uint16Array(AT5_QUANT_SCRATCH_SIZE),
    groupedMode2U16: new Uint16Array(AT5_QUANT_SCRATCH_SIZE),
    groupedMode4U16: new Uint16Array(AT5_QUANT_SCRATCH_SIZE),
    absBufU16,
    absBufBytes: new Uint8Array(absBufU16.buffer),
    absGroupedMode2U16: new Uint16Array(AT5_QUANT_SCRATCH_SIZE),
    absGroupedMode4U16: new Uint16Array(AT5_QUANT_SCRATCH_SIZE),
  };
}

/**
 * Creates the mutable per-channel solve state used by the ATRAC3plus regular
 * block encoder.
 *
 * @returns {At5ChannelBlock}
 */
export function createChannelBlock() {
  return {
    baseMaxQuantMode: 0,
    maxQuantModeByBand: new Int16Array(AT5_BANDS_MAX),
    bitallocMode: 0,
    gainRecordRangeFlag: 0,
    bitDeltaByCtx: new Uint16Array(2),
    quantUnitsByBand: new Int32Array(AT5_BANDS_MAX),
    quantOffsetByBand: new Int32Array(AT5_BANDS_MAX),
    quantModeByBand: new Int32Array(AT5_BANDS_MAX),
    quantModeBaseByBand: new Float32Array(AT5_BANDS_MAX),
    normalizedBandPeaks: new Float32Array(AT5_BANDS_MAX),
    bandPeaks: new Float32Array(AT5_BANDS_MAX),
    bitallocBandPeaks: new Float32Array(AT5_BANDS_MAX),
    bandLevels: new Float32Array(AT5_BANDS_MAX),
    bitallocScale: 0.0,
    avgBandLevel: 0.0,
    wideGainBoostFlag: 0,
    idwlScratch: createAt5IdwlScratch(),
    idwlWork: new Uint8Array(AT5_IDWL_WORK_BYTES),
    rebitallocScratch: createAt5RebitallocScratch(),
    hcspecWorkByCtx: Array.from({ length: AT5_HCSPEC_CONTEXT_COUNT }, () => createAt5HcspecWork()),
    bitallocHeader: null,
    blockState: null,
    quantizedSpectrum: null,
    quantScratch: createAt5QuantScratch(),
  };
}

function resetIdwlScratch(idwlScratch) {
  if (!idwlScratch) {
    return;
  }

  idwlScratch.bestConfigSlot = 0;
  fillWithZero(idwlScratch.costs);
  fillWithZero(idwlScratch.slot0Config);
  fillWithZero(idwlScratch.slot1Config);
  fillWithZero(idwlScratch.slot2Config);
  fillWithZero(idwlScratch.slot3Config);
  fillWithZero(idwlScratch.rowEnabled);
  if (Array.isArray(idwlScratch.rowSeq)) {
    for (const row of idwlScratch.rowSeq) {
      fillWithZero(row);
    }
  }
  fillWithZero(idwlScratch.bandCountBySlot);
  fillWithZero(idwlScratch.mappedGroupBySlot);
  fillWithZero(idwlScratch.extraWordByIndex);
  idwlScratch.work = null;
}

function resetRebitallocScratch(rebitallocScratch) {
  if (!rebitallocScratch) {
    return;
  }

  fillWithZero(rebitallocScratch.bytes);
  fillWithZero(rebitallocScratch.specIndexByBand);
  if (rebitallocScratch.baseSpecIndexWord instanceof Uint32Array) {
    rebitallocScratch.baseSpecIndexWord[0] = 0;
  }
}

function resetHcspecWorkByCtx(hcspecWorkByCtx) {
  if (!Array.isArray(hcspecWorkByCtx)) {
    return;
  }

  for (const work of hcspecWorkByCtx) {
    fillWithZero(work?.bestIndexByBand);
    fillWithZero(work?.costsByBand);
  }
}

/**
 * Resets a reusable shared block header without replacing its allocated
 * scoring tables or work arrays.
 *
 * @param {At5BitallocHeader|null} hdr
 * @param {number} channelCount
 */
export function resetBitallocHeader(hdr, channelCount) {
  if (!hdr) {
    return;
  }

  Object.assign(hdr, {
    tblIndex: 0,
    idwlEnabled: 1,
    idwlInitialized: 0,
    idsfModeWord: 1,
    baseBits: 0,
    cbIterLimit: 0,
    cbStartBand: 0,
    bitsFixed: 0,
    bitsIdwl: 0,
    bitsIdsf: 0,
    bitsIdct: 0,
    bitsStereoMaps: 0,
    bitsChannelMaps: 0,
    bitsGain: 0,
    bitsGha: 0,
    bitsMisc: 0,
    bitsTotalBase: 0,
    bitsTotal: 0,
    debugSecondBitOffset: null,
  });

  fillWithZero(hdr.idsfValues);
  fillWithZero(hdr.mode3BandMask);
  fillWithZero(hdr.mode3DeltaFlags);
  clearHeaderSpecTables(hdr, channelCount);
}

/**
 * Resets a reusable per-channel block solve state while preserving its
 * allocated scratch views.
 *
 * @param {At5ChannelBlock|null} block
 */
export function resetChannelBlockEncodeState(block) {
  if (!block) {
    return;
  }

  Object.assign(block, {
    baseMaxQuantMode: 0,
    bitallocMode: 0,
    gainRecordRangeFlag: 0,
    bitallocScale: 0.0,
    avgBandLevel: 0.0,
    wideGainBoostFlag: 0,
    bitallocHeader: null,
    blockState: null,
    quantizedSpectrum: null,
  });

  fillWithZero(block.maxQuantModeByBand);
  fillWithZero(block.bitDeltaByCtx);
  fillWithZero(block.quantUnitsByBand);
  fillWithZero(block.quantOffsetByBand);
  fillWithZero(block.quantModeByBand);
  fillWithZero(block.quantModeBaseByBand);
  fillWithZero(block.normalizedBandPeaks);
  fillWithZero(block.bandPeaks);
  fillWithZero(block.bitallocBandPeaks);
  fillWithZero(block.bandLevels);
  resetIdwlScratch(block.idwlScratch ?? null);
  fillWithZero(block.idwlWork);
  resetRebitallocScratch(block.rebitallocScratch ?? null);
  resetHcspecWorkByCtx(block.hcspecWorkByCtx ?? null);
}
