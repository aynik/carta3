/**
 * ATRAC3 SCX channel-unit packing and per-channel encode steps.
 */
import { CodecError } from "../../common/errors.js";
import { encodeMddataAt3 } from "./mddata.js";
import {
  createAt3GainControlBlocks,
  getAt3GainControlCount,
  getAt3GainControlEnd,
  getAt3GainControlGainId,
  setAt3GainControlCount,
} from "./gainc-layout.js";
import { packSpecs, packStoreFromMsb } from "./huffman.js";
import {
  at3BitsToBytesCeil,
  collectActiveSpectrumBands,
  nbitsForPackdataAt3,
  resolveComponentGroupCount,
  resolveComponentPlan,
  resolveGlobalState,
  resolveSpectrumSection,
  toInt,
} from "./pack-bits.js";
import { channelNeedsForwardTransformAt3, forwardTransformAt3 } from "./time2freq.js";

const AT3_UNIT_BYTES_MIN_THRESHOLD = 0x14;
const AT3_TIME2FREQ_BLOCKS = 4;
const AT3_BLOCK_SAMPLES = 256;
const AT3_DEFAULT_CONFIG_WORD = 3;
const AT3_DEFAULT_CONFIG_LIMIT = 0x0f;
const AT3_EMPTY_CHANNEL_GROUP_COUNT = 1;

const ZERO_GAIN_PARAMS = createAt3GainControlBlocks(AT3_TIME2FREQ_BLOCKS);

function packToneEntry(table, tone, toneStart, toneWidth, coeffs, out, bitpos) {
  bitpos = packStoreFromMsb(
    toInt(tone?.scaleFactorIndex ?? 0, "tone.scaleFactorIndex") >>> 0,
    6,
    out,
    bitpos
  );
  bitpos = packStoreFromMsb((toneStart & 0x3f) >>> 0, 6, out, bitpos);

  return packSpecs(table, coeffs, toneWidth, out, bitpos);
}

function packComponentSection(channel, out, bitpos) {
  const componentCount = toInt(channel?.mddataEntryIndex ?? 0, "mddataEntryIndex");
  bitpos = packStoreFromMsb(componentCount >>> 0, 5, out, bitpos);
  if (componentCount <= 0) {
    return bitpos;
  }

  const sectionState = resolveComponentPlan(channel, componentCount);
  if (!sectionState) {
    return -1;
  }
  const { componentMode, groupCount, resolvedEntries } = sectionState;

  bitpos = packStoreFromMsb(componentMode >>> 0, 2, out, bitpos);

  for (const resolvedEntry of resolvedEntries) {
    for (let group = 0; group < groupCount; group += 1) {
      bitpos = packStoreFromMsb(
        (toInt(resolvedEntry.entry?.groupFlags?.[group] ?? 0, "groupFlag") >>> 0) & 1,
        1,
        out,
        bitpos
      );
      if (bitpos === -1) {
        return -1;
      }
    }

    bitpos = packStoreFromMsb(resolvedEntry.twiddleId >>> 0, 3, out, bitpos);
    bitpos = packStoreFromMsb(resolvedEntry.baseIndex >>> 0, 3, out, bitpos);

    for (const { listCount, tones } of resolvedEntry.groups) {
      bitpos = packStoreFromMsb(listCount >>> 0, 3, out, bitpos);
      if (bitpos === -1) {
        return -1;
      }

      for (const componentTone of tones) {
        channel.toneCount = ((channel.toneCount | 0) + 1) | 0;
        bitpos = packToneEntry(
          resolvedEntry.table,
          componentTone.tone,
          componentTone.toneStart,
          componentTone.toneWidth,
          componentTone.coeffs,
          out,
          bitpos
        );
        if (bitpos === -1) {
          return -1;
        }
      }
    }
  }

  return bitpos;
}

function packSpectrumSection(channel, out, bitpos) {
  const spectrumSection = resolveSpectrumSection(channel, { requireQuidsf: true });
  if (!spectrumSection) {
    return -1;
  }
  const { groupCount, idwl, specTableIndex, quidsf, tables, quantSpecs } = spectrumSection;

  bitpos = packStoreFromMsb((groupCount - 1) >>> 0, 5, out, bitpos);
  bitpos = packStoreFromMsb(specTableIndex >>> 0, 1, out, bitpos);
  for (let bandIndex = 0; bandIndex < groupCount; bandIndex += 1) {
    bitpos = packStoreFromMsb(
      toInt(idwl[bandIndex] ?? 0, `idwl[${bandIndex}]`) >>> 0,
      3,
      out,
      bitpos
    );
  }
  const activeBands = collectActiveSpectrumBands(groupCount, idwl, tables, quantSpecs);
  if (!activeBands) {
    return -1;
  }

  for (const { bandIndex } of activeBands) {
    bitpos = packStoreFromMsb(
      toInt(quidsf[bandIndex] ?? 0, `quidsf[${bandIndex}]`) >>> 0,
      6,
      out,
      bitpos
    );
    if (bitpos === -1) {
      return -1;
    }
  }

  for (const band of activeBands) {
    bitpos = packSpecs(band.table, band.specs, band.specCount, out, bitpos);
    if (bitpos === -1) {
      return -1;
    }
  }

  return bitpos;
}

/**
 * Packs one SCX channel's mddata payload into the authored transport layout.
 */
export function packMddataAt3(ctx, out, bits) {
  const channel = ctx;
  if (!(out instanceof Uint8Array)) {
    throw new CodecError("out must be a Uint8Array");
  }
  const totalBits = toInt(bits, "bits");

  try {
    if (channel && typeof channel === "object") {
      channel.mddataPackError = null;
    }

    if (toInt(channel?.scratchFlag ?? 0, "scratchFlag") >>> 0 === 1) {
      return -1;
    }

    const componentGroupCount = resolveComponentGroupCount(channel);
    let bitpos = 0;
    bitpos = packStoreFromMsb(0x28, 6, out, bitpos);
    bitpos = packStoreFromMsb((componentGroupCount - 1) >>> 0, 2, out, bitpos);

    for (let group = 0; group < componentGroupCount; group += 1) {
      // Resolve and write each gain-control group in order so earlier groups
      // stay visible even if a later group fails validation.
      const gainControl = channel?.gaincParams?.[group];
      if (!gainControl) {
        return -1;
      }

      const entryCount = getAt3GainControlCount(gainControl) >>> 0;
      bitpos = packStoreFromMsb(entryCount, 3, out, bitpos);
      for (let index = 0; index < entryCount; index += 1) {
        const gainId = getAt3GainControlGainId(gainControl, index) >>> 0;
        const end = getAt3GainControlEnd(gainControl, index) >>> 0;
        bitpos = packStoreFromMsb(gainId, 4, out, bitpos);
        bitpos = packStoreFromMsb(end, 5, out, bitpos);
      }
    }

    channel.toneCount = 0;
    bitpos = packComponentSection(channel, out, bitpos);
    if (bitpos === -1) {
      return -1;
    }

    bitpos = packSpectrumSection(channel, out, bitpos);
    if (bitpos === -1) {
      return -1;
    }

    return (bitpos | 0) > totalBits ? -1 : bitpos | 0;
  } catch (error) {
    if (channel && typeof channel === "object") {
      try {
        channel.mddataPackError =
          error instanceof Error
            ? error
            : new CodecError(`SCX mddata pack error: ${String(error)}`);
      } catch {
        // Ignore failures to attach diagnostics to foreign contexts.
      }
    }
    return -1;
  }
}

/**
 * Packs one channel unit into the destination SCX frame and advances the
 * frame-local output cursor.
 */
export function putChsunitAt3(ctx, bits, outBase) {
  const channel = ctx;
  const totalBits = toInt(bits, "bits");
  if (!(outBase instanceof Uint8Array)) {
    throw new CodecError("outBase must be a Uint8Array");
  }

  const globalState = resolveGlobalState(channel);
  if (globalState === null) {
    return -1;
  }

  const nbytes = at3BitsToBytesCeil(totalBits);
  channel.packedNbytes = nbytes | 0;

  const outputOffset = toInt(globalState.outputOffset ?? 0, "outputOffset");
  if (outputOffset < 0 || outputOffset >= outBase.length) {
    return -1;
  }

  const result = packMddataAt3(channel, outBase.subarray(outputOffset), totalBits);
  if (result === -1) {
    return -1;
  }

  if (
    toInt(globalState.encodeMode ?? 0, "encodeMode") === 1 ||
    toInt(globalState.time2freqMode ?? 0, "time2freqMode") === 2
  ) {
    return -1;
  }

  globalState.outputOffset = (outputOffset + toInt(channel?.unitBytes ?? 0, "unitBytes")) | 0;
  return result | 0;
}

export function encodeScxChannelUnitAt3(channel, transformed, specs, frame) {
  let bits;
  if ((channel.unitBytes | 0) <= AT3_UNIT_BYTES_MIN_THRESHOLD) {
    channel.config.limit = AT3_DEFAULT_CONFIG_LIMIT;
    channel.config.activeWords.fill(AT3_DEFAULT_CONFIG_WORD);
    channel.componentGroupCount = AT3_EMPTY_CHANNEL_GROUP_COUNT;
    setAt3GainControlCount(channel.gaincParams[0], 0);
    channel.mddataEntryIndex = 0;
    channel.specGroupCount = AT3_EMPTY_CHANNEL_GROUP_COUNT;
    channel.specTableIndex = 0;
    channel.idwl[0] = 0;
    bits = nbitsForPackdataAt3(channel);
  } else {
    bits = encodeMddataAt3(transformed, specs, channel, channel.prevState ?? null);
  }

  return bits < 0 || putChsunitAt3(channel, bits, frame) < 0 ? -1 : 0;
}

export function encodeScxPcmChannelAt3(channel, scratch, frame) {
  const specs = scratch.spectra;
  const { mdctBlocks, noGainScratch } = scratch;
  if (channelNeedsForwardTransformAt3(channel) !== 1) {
    // Even channels that skip the forward transform keep this concatenated
    // MDCT scratch copy in sync for the rest of the SCX pipeline.
    for (let blockIndex = 0; blockIndex < AT3_TIME2FREQ_BLOCKS; blockIndex += 1) {
      noGainScratch.set(mdctBlocks[blockIndex], blockIndex * AT3_BLOCK_SAMPLES);
    }
    return encodeScxChannelUnitAt3(channel, specs, specs, frame);
  }

  const transformed = scratch.transformed;
  if (
    forwardTransformAt3(
      mdctBlocks,
      transformed,
      ZERO_GAIN_PARAMS,
      ZERO_GAIN_PARAMS,
      AT3_TIME2FREQ_BLOCKS,
      noGainScratch
    ) === -1
  ) {
    return -1;
  }

  return encodeScxChannelUnitAt3(channel, transformed, specs, frame);
}
