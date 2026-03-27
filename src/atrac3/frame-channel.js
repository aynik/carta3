import { CodecError } from "../common/errors.js";
import { AT3ENC_PROC_UNIT_COUNT_WORD } from "./proc-layout.js";
import { at3encPackBitsU16 } from "./frame-channel-pack.js";
import { writeAtrac3ToneRegionSideband } from "./frame-channel-tone.js";
import { writeAtrac3SpectralPayload } from "./frame-channel-spectrum.js";

const AT3ENC_PRIMARY_CHANNEL_HEADER_VALUE = 0xa0;
const AT3ENC_SECONDARY_CHANNEL_HEADER_VALUE = 0x0c;

/**
 * ATRAC3 per-channel payload packing.
 *
 * This owner writes one prepared channel body: transport prefix, gain-pair
 * prelude, optional tone-region sideband, and the packed non-tone spectrum.
 */
function writeAtrac3ChannelPrefix(state, layer, unitCount, out, bitpos) {
  const headerUnitBits = (unitCount - 1) & 0x03;

  if (layer.referencesPrimaryShift === true) {
    const { mixCode, slots } = state.channelConversion;
    // Converted secondary payloads spend one byte on the mix prelude before
    // the regular channel header and body start.
    out[bitpos >>> 3] =
      ((mixCode.previous & 0x0f) << 4) |
      ((slots[0].modeHint & 0x03) << 2) |
      (slots[1].modeHint & 0x03);
    bitpos += 8;

    out[bitpos >>> 3] =
      AT3ENC_SECONDARY_CHANNEL_HEADER_VALUE |
      ((slots[2].modeHint & 0x03) << 6) |
      ((slots[3].modeHint & 0x03) << 4) |
      headerUnitBits;
    return bitpos + 8;
  }

  out[bitpos >>> 3] = AT3ENC_PRIMARY_CHANNEL_HEADER_VALUE | headerUnitBits;
  return bitpos + 8;
}

function writeAtrac3GainPairPrelude(toneBlocks, unitCount, out, bitpos) {
  for (let unit = 0; unit < unitCount; unit += 1) {
    const gainPairs = toneBlocks[unit];
    const entryCount = gainPairs.entryCount;
    bitpos = at3encPackBitsU16(out, bitpos, entryCount, 3);

    for (let pair = 0; pair < entryCount; pair += 1) {
      const packedEntry = gainPairs.startIndex[pair] | (gainPairs.gainIndex[pair] << 5);
      bitpos = at3encPackBitsU16(out, bitpos, packedEntry, 9);
    }
  }

  return bitpos;
}

/** Packs one ATRAC3 algorithm-0 layer into its channel bitstream payload. */
export function at3encPackChannel(state, layer, outOffsetBytes, out) {
  if (!(out instanceof Uint8Array)) {
    throw new CodecError("out must be a Uint8Array");
  }
  if (!(state.procWords instanceof Uint32Array)) {
    throw new CodecError("state.procWords must be a Uint32Array");
  }
  if (!layer || typeof layer !== "object") {
    throw new CodecError("layer must be a layer object");
  }
  if (!Array.isArray(layer.tones?.blocks) || layer.tones.blocks.length < 4) {
    throw new CodecError("layer.tones.blocks must contain 4 tone blocks");
  }
  if (!(layer.spectrum instanceof Float32Array)) {
    throw new CodecError("layer.spectrum must be a Float32Array");
  }

  const { procWords } = state;
  const toneBlocks = layer.tones.blocks;
  const unitCount = procWords[AT3ENC_PROC_UNIT_COUNT_WORD];
  let bitpos = (outOffsetBytes | 0) * 8;
  bitpos = writeAtrac3ChannelPrefix(state, layer, unitCount, out, bitpos);

  // Phase 1: each active transform unit advertises its overlap/add gain pairs
  // before the optional tone-region sideband and the main spectral payload.
  bitpos = writeAtrac3GainPairPrelude(toneBlocks, unitCount, out, bitpos);

  // Phase 2: emit sparse tone-region sideband rows after the gain-pair prelude.
  bitpos = writeAtrac3ToneRegionSideband(procWords, unitCount, out, bitpos);

  // Phase 3: write the active band descriptors, then the packed spectral body.
  bitpos = writeAtrac3SpectralPayload(procWords, layer.spectrum, out, bitpos);

  return bitpos;
}
