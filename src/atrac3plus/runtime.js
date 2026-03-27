import { createAt5RegularBlockState } from "./bitstream/internal.js";
import { createAtrac3plusEncodeHandle } from "./encode-handle.js";
import { createAt5SigprocAux, createAt5Time2freqState } from "./sigproc/internal.js";
import { createAt5EncodeBufBlock } from "./time2freq/internal.js";
import { CodecError } from "../common/errors.js";

const AT5_BANDS_MAX = 16;
const AT5_MDCT_SAMPLES = 128;
const AT5_SLOT_RING_LENGTH = 5;
const AT5_GHWAVE_MAX_TOTAL_ENTRIES = 48;
const ATX_BLOCK_TABLE0_GROUP_STRIDE = 0x21;
const ATX_BLOCK_TABLE1_GROUP_STRIDE = 0x20;
const ATX_BLOCK_TABLE4_WORDS_PER_GROUP = 0x40;
const ATX_GAIN_POINT_HISTORY_BAND_BYTES = 0x1800;
const ATX_GAIN_POINT_HISTORY_BYTES = AT5_BANDS_MAX * ATX_GAIN_POINT_HISTORY_BAND_BYTES;

/**
 * Mutable per-block mode metadata mirrored into every runtime channel entry.
 *
 * @typedef {object} At5RuntimeBlockState
 * @property {number} blockIndex Index of the regular block within the frame layout.
 * @property {number} encodeMode Core encode mode used by sigproc/time2freq analysis.
 * @property {number} isMode4Block Whether this block uses the mode-4 bypass pipeline.
 * @property {number} sinusoidEncodeFlag Whether GH extraction stays enabled for the block.
 */

/**
 * Creates one per-band GH analysis record used by the slot ring.
 *
 * These records carry both the accepted entry range and the gating window
 * chosen during generalized-harmonic analysis for one band.
 */
function createAt5AnalysisCtx() {
  return {
    hasStart: 0,
    hasEnd: 0,
    start: 0,
    end: 0,
    gateStartValid: 0,
    gateEndValid: 0,
    gateStartIdx: 0,
    gateEndIdx: 0x20,
    count: 0,
    entries: null,
  };
}

/**
 * Creates the slot-shared GH analysis payload reused across all channels.
 */
function createAt5AnalysisGlobal() {
  return {
    enabled: 0,
    flag: 0,
    bandCount: 1,
    jointFlags: new Int32Array(AT5_BANDS_MAX),
    mixFlags: new Int32Array(AT5_BANDS_MAX),
    entriesU32: new Uint32Array(AT5_GHWAVE_MAX_TOTAL_ENTRIES * 4),
  };
}

/**
 * Creates one channel-local view over a slot-shared GH analysis payload.
 */
function createAt5AnalysisSlot(sharedPtr) {
  return {
    sharedPtr,
    records: Array.from({ length: AT5_BANDS_MAX }, () => createAt5AnalysisCtx()),
  };
}

function createSeededBandTable(stride, tailValue = 4.0) {
  const table = new Float32Array(AT5_BANDS_MAX * stride).fill(4.0);
  if (tailValue === 4.0) {
    return table;
  }

  for (let offset = stride - 1; offset < table.length; offset += stride) {
    table[offset] = tailValue;
  }
  return table;
}

/**
 * Attaches encoder-only scratch, gain buffers, and history tables to one
 * regular-block channel entry.
 */
function seedRuntimeChannelEntry(entry, aux, blockState, analysisGlobals) {
  const curBuf = createAt5EncodeBufBlock();
  const prevBuf = createAt5EncodeBufBlock();

  Object.assign(entry, {
    sharedAux: aux,
    blockState,
    curBuf,
    prevBuf,
    bufA: curBuf,
    bufB: prevBuf,
    slots: analysisGlobals.map(createAt5AnalysisSlot),
    gainActiveCount: 0,
    table0: createSeededBandTable(ATX_BLOCK_TABLE0_GROUP_STRIDE, 0.0),
    table1: createSeededBandTable(ATX_BLOCK_TABLE1_GROUP_STRIDE),
    peakIndexHistory: new Uint32Array(AT5_BANDS_MAX * 2),
    peakValueHistory: new Float32Array(AT5_BANDS_MAX * 2),
    windowAbsHistory: new Float32Array(AT5_BANDS_MAX * ATX_BLOCK_TABLE4_WORDS_PER_GROUP),
    windowScaleHistory: new Float32Array(AT5_BANDS_MAX * ATX_BLOCK_TABLE4_WORDS_PER_GROUP).fill(
      1.0
    ),
    trailingWindowPeakHistory: new Float32Array(AT5_BANDS_MAX),
    duplicatePointCountHistory: new Uint32Array(AT5_BANDS_MAX),
    pointGroupCountHistory: new Uint32Array(AT5_BANDS_MAX * 2),
    disabledPointCountHistory: new Uint32Array(AT5_BANDS_MAX * 2),
    gainLevelBoundsHistory: new Uint32Array(AT5_BANDS_MAX * 2),
    gainPointHistoryBytes: new Uint8Array(ATX_GAIN_POINT_HISTORY_BYTES),
    stereoBandEnergyHistory: new Float32Array(AT5_BANDS_MAX),
    stereoBandEnergyRatioHistory: new Float32Array(AT5_BANDS_MAX).fill(1.0),
  });
}

/**
 * Extends one regular-block decode layout with the encoder scratch needed by
 * sigproc, time2freq, gain, and channel-block solve stages.
 */
function createRuntimeBlock(handle, blockConfig) {
  const channels = blockConfig.channelsInBlock | 0;
  const block = createAt5RegularBlockState(channels);
  const { shared, channels: channelEntries } = block;
  const aux = createAt5SigprocAux();
  const blockState = {
    blockIndex: blockConfig.blockIndex | 0,
    encodeMode: blockConfig.encodeMode | 0,
    isMode4Block: blockConfig.isMode4Block | 0,
    sinusoidEncodeFlag: blockConfig.sinusoidEncodeFlag | 0,
  };
  const analysisGlobals = Array.from({ length: AT5_SLOT_RING_LENGTH }, () =>
    createAt5AnalysisGlobal()
  );

  Object.assign(shared, {
    coreMode: blockConfig.coreMode | 0,
    encodeFlags: 0,
    encodeFlagCc: blockConfig.encodeFlagCc | 0,
    encodeFlagD0: blockConfig.encodeFlagD0 | 0,
    sampleRateHz: handle.sampleRate | 0,
    channels,
    idsfCount: 0,
    codedBandLimit: 0,
    bandCount: 0,
    mapSegmentCount: 0,
    channelPresenceMapCount: 0,
    swapMap:
      shared.stereoSwapPresence?.flags instanceof Uint32Array
        ? shared.stereoSwapPresence.flags
        : (shared.swapMap ?? new Uint32Array(AT5_BANDS_MAX)),
  });

  for (const entry of channelEntries) {
    seedRuntimeChannelEntry(entry, aux, blockState, analysisGlobals);
  }

  return {
    ...block,
    ...blockConfig,
    channelEntries,
    timeStates: Array.from({ length: channels }, () => createAt5Time2freqState()),
    quantizedSpectraByChannel: Array.from(
      { length: channels },
      () => new Float32Array(AT5_BANDS_MAX * AT5_MDCT_SAMPLES)
    ),
    bitallocSpectraByChannel: Array.from(
      { length: channels },
      () => new Float32Array(AT5_BANDS_MAX * AT5_MDCT_SAMPLES)
    ),
    shared,
    aux,
    blockState,
    analysisGlobals,
  };
}

function isFinitePositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isFiniteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isAt5EncodeHandleBlock(block) {
  return (
    block &&
    typeof block === "object" &&
    typeof block.ready === "boolean" &&
    isFiniteNonNegativeInteger(block.blockIndex) &&
    (block.channelsInBlock === 1 || block.channelsInBlock === 2) &&
    isFinitePositiveInteger(block.bitsForBlock) &&
    isFinitePositiveInteger(block.bandwidthHz) &&
    isFinitePositiveInteger(block.ispsIndex) &&
    isFiniteNonNegativeInteger(block.coreMode) &&
    isFiniteNonNegativeInteger(block.encodeMode)
  );
}

function isAtrac3plusEncodeHandle(handle) {
  const blocks = handle?.blocks;
  return (
    handle &&
    typeof handle === "object" &&
    isFinitePositiveInteger(handle.sampleRate) &&
    isFinitePositiveInteger(handle.mode) &&
    isFinitePositiveInteger(handle.streamChannels) &&
    isFinitePositiveInteger(handle.frameBytes) &&
    isFinitePositiveInteger(handle.inputChannels) &&
    isFinitePositiveInteger(handle.bitrateKbps) &&
    isFiniteNonNegativeInteger(handle.encodeMode) &&
    handle.configBytes instanceof Uint8Array &&
    handle.configBytes.length >= 2 &&
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    blocks.every(isAt5EncodeHandleBlock) &&
    isFiniteNonNegativeInteger(handle.delayFramesRemaining) &&
    isFiniteNonNegativeInteger(handle.flushFramesRemaining)
  );
}

function isAtrac3plusRuntimeChannelEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    entry.curBuf &&
    typeof entry.curBuf === "object" &&
    entry.prevBuf &&
    typeof entry.prevBuf === "object" &&
    entry.table0 instanceof Float32Array &&
    entry.table0.length > 0 &&
    entry.table1 instanceof Float32Array &&
    entry.table1.length > 0 &&
    entry.peakIndexHistory instanceof Uint32Array &&
    entry.peakValueHistory instanceof Float32Array &&
    entry.gainPointHistoryBytes instanceof Uint8Array
  );
}

function isAtrac3plusRuntimeBlock(block, handle) {
  const channels = block?.channelsInBlock | 0;
  const expectedSpectraLength = AT5_BANDS_MAX * AT5_MDCT_SAMPLES;
  if (!block || typeof block !== "object") {
    return false;
  }
  if (!isFiniteNonNegativeInteger(block.blockIndex)) {
    return false;
  }
  if (channels !== 1 && channels !== 2) {
    return false;
  }

  const shared = block.shared;
  if (!shared || typeof shared !== "object") {
    return false;
  }
  if ((shared.sampleRateHz | 0) !== (handle.sampleRate | 0)) {
    return false;
  }
  if ((shared.channels | 0) !== channels) {
    return false;
  }
  if (!(shared.swapMap instanceof Uint32Array) || shared.swapMap.length < AT5_BANDS_MAX) {
    return false;
  }

  if (!block.aux || typeof block.aux !== "object") {
    return false;
  }
  if (!block.blockState || typeof block.blockState !== "object") {
    return false;
  }
  if (!isFiniteNonNegativeInteger(block.blockState.blockIndex)) {
    return false;
  }
  if (!Array.isArray(block.timeStates) || block.timeStates.length < channels) {
    return false;
  }

  if (!Array.isArray(block.channelEntries) || block.channelEntries.length < channels) {
    return false;
  }
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    if (!isAtrac3plusRuntimeChannelEntry(block.channelEntries[channelIndex])) {
      return false;
    }
  }

  if (
    !Array.isArray(block.quantizedSpectraByChannel) ||
    block.quantizedSpectraByChannel.length < channels
  ) {
    return false;
  }
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const spectra = block.quantizedSpectraByChannel[channelIndex];
    if (!(spectra instanceof Float32Array) || spectra.length < expectedSpectraLength) {
      return false;
    }
  }

  if (
    !Array.isArray(block.bitallocSpectraByChannel) ||
    block.bitallocSpectraByChannel.length < channels
  ) {
    return false;
  }
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const spectra = block.bitallocSpectraByChannel[channelIndex];
    if (!(spectra instanceof Float32Array) || spectra.length < expectedSpectraLength) {
      return false;
    }
  }

  if (
    !Array.isArray(block.analysisGlobals) ||
    block.analysisGlobals.length < AT5_SLOT_RING_LENGTH
  ) {
    return false;
  }
  return true;
}

function isAtrac3plusEncodeRuntime(context) {
  if (!context || typeof context !== "object" || !isFiniteNonNegativeInteger(context.frameIndex)) {
    return false;
  }

  const handle = context.handle;
  if (!isAtrac3plusEncodeHandle(handle)) {
    return false;
  }

  if (!Array.isArray(context.blocks) || context.blocks.length === 0) {
    return false;
  }

  const expectedBlocks = handle.blocks.filter((block) => block.ready).length;
  if (context.blocks.length !== expectedBlocks) {
    return false;
  }

  let channelSum = 0;
  for (const block of context.blocks) {
    if (!isAtrac3plusRuntimeBlock(block, handle)) {
      return false;
    }
    channelSum += block.channelsInBlock | 0;
  }

  return channelSum === (handle.streamChannels | 0);
}

/**
 * Build encoder runtime blocks from the static handle topology.
 *
 * Runtime blocks extend the regular-block decode layout with encoder-only
 * scratch while keeping the legacy `bufA`/`bufB` aliases wired to the current
 * and previous gain buffers.
 *
 * @param {object} handle ATRAC3plus encode handle returned by `createAtrac3plusEncodeHandle`.
 * @returns {{handle: object, blocks: object[], frameIndex: number}}
 */
export function createAtrac3plusEncodeRuntime(handle) {
  const blockTable = Array.isArray(handle?.blocks) ? handle.blocks : null;
  if (!blockTable) {
    throw new TypeError("invalid ATRAC3plus encode handle");
  }

  const activeConfigs = blockTable.filter((block) => block?.ready);
  return {
    handle,
    blocks: activeConfigs.map((config) => createRuntimeBlock(handle, config)),
    frameIndex: 0,
  };
}

/**
 * Reuses a complete ATRAC3plus runtime or creates one from authored transport settings.
 */
export function normalizeAtrac3plusEncodeRuntime(
  context,
  { bitrateKbps, frameBytes, mode, sampleRate, inputChannels, encodeMode = 0 }
) {
  if (isAtrac3plusEncodeRuntime(context)) {
    const handle = context.handle;
    const mismatch =
      handle.sampleRate !== sampleRate ||
      handle.mode !== mode ||
      handle.frameBytes !== frameBytes ||
      handle.inputChannels !== inputChannels ||
      handle.encodeMode !== encodeMode ||
      handle.bitrateKbps !== bitrateKbps;

    if (mismatch) {
      throw new CodecError(
        `ATRAC3plus encode context mismatch: ` +
          `expected bitrate=${bitrateKbps} channels=${inputChannels} sampleRate=${sampleRate} ` +
          `mode=${mode} frameBytes=${frameBytes} encodeMode=${encodeMode}, ` +
          `got bitrate=${handle.bitrateKbps} channels=${handle.inputChannels} sampleRate=${handle.sampleRate} ` +
          `mode=${handle.mode} frameBytes=${handle.frameBytes} encodeMode=${handle.encodeMode}`
      );
    }

    return context;
  }

  return createAtrac3plusEncodeRuntime(
    createAtrac3plusEncodeHandle({
      sampleRate,
      mode,
      frameBytes,
      inputChannels,
      bitrateKbps,
      encodeMode,
    })
  );
}
