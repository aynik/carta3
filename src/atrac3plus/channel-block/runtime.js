import { AT5_ISPS, at5MapCountForBandCount } from "../tables/unpack.js";

const AT5_SPECTRUM_WORDS = 0x800;
const AT5_SWAP_SEGMENT_SAMPLES = 0x200 / 4; // 0x200 bytes per swap segment / 4 bytes per float
const gSwapAdjustedScratchByBlock = new WeakMap();

function getSwapAdjustedSpectraScratch(
  runtimeBlock,
  quantizedLeft,
  quantizedRight,
  bitallocLeft,
  bitallocRight
) {
  const key = runtimeBlock && typeof runtimeBlock === "object" ? runtimeBlock : null;
  if (!key) {
    return {
      quantizedSpectraByChannel: [
        new Float32Array(quantizedLeft),
        new Float32Array(quantizedRight),
      ],
      bitallocSpectraByChannel: [new Float32Array(bitallocLeft), new Float32Array(bitallocRight)],
    };
  }

  let scratch = gSwapAdjustedScratchByBlock.get(key);
  if (!scratch) {
    scratch = {
      quantizedSpectraByChannel: [
        new Float32Array(quantizedLeft.length),
        new Float32Array(quantizedRight.length),
      ],
      bitallocSpectraByChannel: [
        new Float32Array(bitallocLeft.length),
        new Float32Array(bitallocRight.length),
      ],
    };
    gSwapAdjustedScratchByBlock.set(key, scratch);
  }

  const quantizedSpectraByChannel = scratch.quantizedSpectraByChannel;
  const bitallocSpectraByChannel = scratch.bitallocSpectraByChannel;

  if (
    !(quantizedSpectraByChannel?.[0] instanceof Float32Array) ||
    quantizedSpectraByChannel[0].length !== quantizedLeft.length
  ) {
    quantizedSpectraByChannel[0] = new Float32Array(quantizedLeft.length);
  }
  if (
    !(quantizedSpectraByChannel?.[1] instanceof Float32Array) ||
    quantizedSpectraByChannel[1].length !== quantizedRight.length
  ) {
    quantizedSpectraByChannel[1] = new Float32Array(quantizedRight.length);
  }
  if (
    !(bitallocSpectraByChannel?.[0] instanceof Float32Array) ||
    bitallocSpectraByChannel[0].length !== bitallocLeft.length
  ) {
    bitallocSpectraByChannel[0] = new Float32Array(bitallocLeft.length);
  }
  if (
    !(bitallocSpectraByChannel?.[1] instanceof Float32Array) ||
    bitallocSpectraByChannel[1].length !== bitallocRight.length
  ) {
    bitallocSpectraByChannel[1] = new Float32Array(bitallocRight.length);
  }

  return scratch;
}

/**
 * Returns the live runtime analysis buffer for the current frame, accepting the
 * original `bufA` naming used by older extracted paths.
 */
export function runtimeCurrentBuffer(runtimeChannel) {
  return runtimeChannel?.curBuf ?? runtimeChannel?.bufA ?? null;
}

/**
 * Returns the previous runtime analysis buffer, accepting the original `bufB`
 * naming used by older extracted paths.
 */
export function runtimePreviousBuffer(runtimeChannel) {
  return runtimeChannel?.prevBuf ?? runtimeChannel?.bufB ?? null;
}

/**
 * Swaps one stereo swap-map segment between two working spectra in place.
 */
export function swapSpectrumSegmentInPlace(specA, specB, segmentIndex) {
  const start = (segmentIndex | 0) * AT5_SWAP_SEGMENT_SAMPLES;
  if (
    !(specA instanceof Float32Array) ||
    !(specB instanceof Float32Array) ||
    start < 0 ||
    start >= AT5_SPECTRUM_WORDS
  ) {
    return;
  }

  const end = Math.min(
    start + AT5_SWAP_SEGMENT_SAMPLES,
    AT5_SPECTRUM_WORDS,
    specA.length,
    specB.length
  );
  for (let i = start; i < end; i += 1) {
    const tmp = specA[i];
    specA[i] = specB[i];
    specB[i] = tmp;
  }
}

/**
 * Applies the runtime stereo swap map to the paired quantized/bitalloc working
 * spectra in place and reports whether any segment was swapped.
 */
export function applySwapMapToSpectraInPlace(
  quantizedSpectraByChannel,
  bitallocSpectraByChannel,
  swapMap,
  segmentCount
) {
  const [leftQuantizedSpectrum, rightQuantizedSpectrum] = quantizedSpectraByChannel ?? [];
  const [leftBitallocSpectrum, rightBitallocSpectrum] = bitallocSpectraByChannel ?? [];
  if (
    !(
      leftQuantizedSpectrum instanceof Float32Array &&
      rightQuantizedSpectrum instanceof Float32Array &&
      leftBitallocSpectrum instanceof Float32Array &&
      rightBitallocSpectrum instanceof Float32Array
    )
  ) {
    return false;
  }

  let swappedAnySegment = false;
  for (
    let segment = 0, swapLimit = Math.min(segmentCount | 0, swapMap?.length | 0);
    segment < swapLimit;
    segment += 1
  ) {
    if ((swapMap[segment] | 0) === 0) {
      continue;
    }

    swappedAnySegment = true;
    swapSpectrumSegmentInPlace(leftQuantizedSpectrum, rightQuantizedSpectrum, segment);
    swapSpectrumSegmentInPlace(leftBitallocSpectrum, rightBitallocSpectrum, segment);
  }

  return swappedAnySegment;
}

/**
 * Clears staged IDWL, IDSF, and scratch spectra from the given band onward.
 */
export function clearBandTail(channel, startBand) {
  channel.idwl.values.fill(0, startBand);
  channel.idsf.values.fill(0, startBand);
  const start = AT5_ISPS[startBand] ?? 2048;
  channel.scratchSpectra.fill(0, start);
}

function copyNormalizedGainRecord(dstRecord, srcRecord) {
  dstRecord.entries = 0;
  dstRecord.locations.fill(0);
  dstRecord.levels.fill(0);

  const limit = Math.max(0, Math.min(srcRecord?.entries | 0, 7));
  let prevLoc = -1;
  for (let i = 0; i < limit; i += 1) {
    const srcLoc = Math.min(0x1f, Math.max(0, srcRecord?.locations?.[i] | 0));
    const loc = Math.max(prevLoc + 1, srcLoc);
    if (loc > 0x1f) {
      break;
    }

    const entry = dstRecord.entries;
    dstRecord.locations[entry] = loc >>> 0;
    dstRecord.levels[entry] = Math.min(0x0f, Math.max(0, srcRecord?.levels?.[i] | 0)) >>> 0;
    dstRecord.entries = (entry + 1) >>> 0;
    prevLoc = loc;
  }

  return dstRecord.entries | 0;
}

/**
 * Copies the current runtime gain records into the temporary channel state,
 * normalizing locations and clearing stale encoder-side metadata.
 */
export function copyGainRecordsFromRuntime(channel, runtimeChannel, recordCount) {
  const gain = channel.gain;
  const srcRecords = runtimeCurrentBuffer(runtimeChannel)?.records;
  const count = Math.max(0, Math.min(recordCount | 0, gain.records.length));
  let active = 0;

  for (let i = 0; i < gain.records.length; i += 1) {
    if (copyNormalizedGainRecord(gain.records[i], i < count ? srcRecords?.[i] : null) !== 0) {
      active = i + 1;
    }
  }

  gain.hasData = active === 0 ? 0 : 1;
  gain.activeCount = active >>> 0;
  gain.uniqueCount = active >>> 0;
  gain.hasDeltaFlag = 0;
  gain.ngcMode = 0;
  gain.idlevMode = 0;
  gain.idlocMode = 0;
}

function setPresenceTableFlags(table, count, srcFlags, srcRecords = null) {
  table.flags.fill(0);

  let enabledCount = 0;
  for (let i = 0; i < count; i += 1) {
    const flag = (srcFlags?.[i] ?? srcRecords?.[i]?.tlevFlag ?? 0) !== 0 ? 1 : 0;
    table.flags[i] = flag;
    enabledCount += flag;
  }

  table.enabled = enabledCount !== 0 ? 1 : 0;
  table.mixed = enabledCount !== 0 && enabledCount !== count ? 1 : 0;
}

/**
 * Copies the runtime per-segment presence flags into the temporary block
 * channel, preferring the dedicated copied flag row when it exists.
 */
export function copyPresenceFromRuntime(channel, runtimeChannel, count) {
  const table = channel.channelPresence;
  const curBuf = runtimeCurrentBuffer(runtimeChannel);
  setPresenceTableFlags(
    table,
    Math.max(0, Math.min(count | 0, table.flags.length)),
    curBuf?.tlevFlagsCopy,
    curBuf?.records
  );
}

/**
 * Builds stereo swap-adjusted working spectra for the temporary basic-block
 * analysis path. `quantizedSpectraByChannel` remains the quantized view and
 * `bitallocSpectraByChannel` remains the bitalloc view; when no swap segments
 * are active the original runtime arrays are returned unchanged.
 */
export function buildSwapAdjustedSpectra(runtimeBlock, channelCount, bandLimit) {
  const quantizedSpectraByChannel = runtimeBlock?.quantizedSpectraByChannel;
  const bitallocSpectraByChannel = runtimeBlock?.bitallocSpectraByChannel;
  const runtimeShared = runtimeBlock?.shared ?? null;
  if (
    !Array.isArray(quantizedSpectraByChannel) ||
    !Array.isArray(bitallocSpectraByChannel) ||
    (channelCount | 0) !== 2
  ) {
    return { quantizedSpectraByChannel, bitallocSpectraByChannel };
  }

  const [quantizedLeft, quantizedRight] = quantizedSpectraByChannel;
  const [bitallocLeft, bitallocRight] = bitallocSpectraByChannel;
  if (
    !(
      quantizedLeft instanceof Float32Array &&
      quantizedRight instanceof Float32Array &&
      bitallocLeft instanceof Float32Array &&
      bitallocRight instanceof Float32Array
    )
  ) {
    return { quantizedSpectraByChannel, bitallocSpectraByChannel };
  }

  const swapMap = ArrayBuffer.isView(runtimeShared?.swapMap) ? runtimeShared.swapMap : null;
  const swapSegmentCount = at5MapCountForBandCount(Math.max(0, Math.min(bandLimit | 0, 32))) | 0;
  if (!swapMap || swapSegmentCount === 0) {
    return { quantizedSpectraByChannel, bitallocSpectraByChannel };
  }

  let hasMappedStereoSwapSegment = false;
  for (let segment = 0; segment < swapSegmentCount; segment += 1) {
    if ((swapMap[segment] | 0) !== 0) {
      hasMappedStereoSwapSegment = true;
      break;
    }
  }
  if (!hasMappedStereoSwapSegment) {
    return { quantizedSpectraByChannel, bitallocSpectraByChannel };
  }

  const scratch = getSwapAdjustedSpectraScratch(
    runtimeBlock,
    quantizedLeft,
    quantizedRight,
    bitallocLeft,
    bitallocRight
  );
  const swapAdjustedQuantizedSpectra = scratch.quantizedSpectraByChannel;
  const swapAdjustedBitallocSpectra = scratch.bitallocSpectraByChannel;
  swapAdjustedQuantizedSpectra[0].set(quantizedLeft);
  swapAdjustedQuantizedSpectra[1].set(quantizedRight);
  swapAdjustedBitallocSpectra[0].set(bitallocLeft);
  swapAdjustedBitallocSpectra[1].set(bitallocRight);
  applySwapMapToSpectraInPlace(
    swapAdjustedQuantizedSpectra,
    swapAdjustedBitallocSpectra,
    swapMap,
    swapSegmentCount
  );

  return {
    quantizedSpectraByChannel: swapAdjustedQuantizedSpectra,
    bitallocSpectraByChannel: swapAdjustedBitallocSpectra,
  };
}

/**
 * Mirrors the runtime stereo swap map into the packed presence-table view used
 * later by the channel-block bitstream passes.
 */
export function applyRuntimeStereoSwapPresence(block, runtimeBlock) {
  const shared = block?.shared;
  const runtimeShared = runtimeBlock?.shared ?? null;
  const swapPresence = shared?.stereoSwapPresence;
  const flipPresence = shared?.stereoFlipPresence;
  if (!swapPresence || !flipPresence) {
    return;
  }

  setPresenceTableFlags(flipPresence, 0, null);

  if ((shared.channels | 0) !== 2) {
    setPresenceTableFlags(swapPresence, 0, null);
    return;
  }

  const count = Math.max(0, Math.min(shared.mapCount | 0, swapPresence.flags.length));
  if (!ArrayBuffer.isView(runtimeShared?.swapMap) || count === 0) {
    setPresenceTableFlags(swapPresence, 0, null);
    return;
  }

  setPresenceTableFlags(swapPresence, count, runtimeShared.swapMap);
}
