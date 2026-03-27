import { AT3_DEC_BLOCK_FLOATS, ATRAC3_FRAME_SAMPLES } from "./constants.js";
import { AT3_SPCODE_SCALE_TABLE } from "./decode-tables.js";
import { decodeSpcode } from "./decode-channel-spcode.js";
import { markAtrac3DecodeError, readAtrac3Bits } from "./decode-channel-transport.js";

const AT3_DEC_TONE_SEGMENT_STRIDE = 0x40;
const AT3_DEC_TONE_SEGMENTS_PER_BLOCK = AT3_DEC_BLOCK_FLOATS / AT3_DEC_TONE_SEGMENT_STRIDE;
const AT3_DEC_MAX_TONE_SEGMENTS = 0x40;
const AT3_DEC_TONE_INVALID_PASS_MODE = 2;
const AT3_DEC_TONE_DYNAMIC_TABLE_SEL_MODE = 3;

/**
 * One sparse tonal patch pass inside an ATRAC3 channel payload.
 *
 * @typedef {object} Atrac3TonePass
 * @property {number} unitActivityBits
 * @property {number} segmentLength
 * @property {number} spcodeIndex
 * @property {number} tableSel
 */
function readAtrac3TonePass(state, activeUnitCount, usesDynamicTableSel, passMode) {
  const { bitstream } = state;
  const unitActivityBits = readAtrac3Bits(bitstream, activeUnitCount) >>> 0;
  const segmentLength = (readAtrac3Bits(bitstream, 3) & 7) + 1;
  const spcodeIndex = (readAtrac3Bits(bitstream, 3) & 7) - 1;
  if (spcodeIndex < 1) {
    markAtrac3DecodeError(state);
    return null;
  }

  return {
    unitActivityBits,
    segmentLength,
    spcodeIndex,
    tableSel: usesDynamicTableSel ? readAtrac3Bits(bitstream, 1) & 1 : passMode,
  };
}

function decodeAtrac3TonePassUnits(state, activeUnitCount, spectrum, tonePass, toneState) {
  const { bitstream } = state;
  const { unitActivityBits, segmentLength, spcodeIndex, tableSel } = tonePass;

  for (let unit = 0; unit < activeUnitCount; unit += 1) {
    if (((unitActivityBits >>> (activeUnitCount - unit - 1)) & 1) === 0) {
      continue;
    }

    const unitOffset = unit * AT3_DEC_BLOCK_FLOATS;
    for (let segment = 0; segment < AT3_DEC_TONE_SEGMENTS_PER_BLOCK; segment += 1) {
      const repeatCount = (readAtrac3Bits(bitstream, 3) | 0) - 1;
      if (repeatCount < 0) {
        continue;
      }

      const segmentOffset = unitOffset + segment * AT3_DEC_TONE_SEGMENT_STRIDE;
      for (let repeat = 0; repeat <= repeatCount; repeat += 1) {
        const scaleIndex = readAtrac3Bits(bitstream, 6) & 0x3f;
        const start = readAtrac3Bits(bitstream, 6) & 0x3f;
        const outStart = segmentOffset + start;
        const outEnd = Math.min(outStart + segmentLength, ATRAC3_FRAME_SAMPLES);
        toneState.maxCoeffIndex = Math.max(toneState.maxCoeffIndex, outEnd);

        toneState.segmentCount += 1;
        if (toneState.segmentCount > AT3_DEC_MAX_TONE_SEGMENTS) {
          markAtrac3DecodeError(state);
          return false;
        }

        decodeSpcode(
          state,
          tableSel,
          spcodeIndex,
          AT3_SPCODE_SCALE_TABLE[scaleIndex],
          spectrum,
          outStart,
          outEnd
        );
      }
    }
  }

  return true;
}

/**
 * Decodes the optional sparse tone-patch passes that precede grouped
 * non-tonal SPCODEs inside an ATRAC3 channel payload.
 */
export function decodeAtrac3TonePasses(state, activeUnitCount, spectrum) {
  const { bitstream } = state;
  const tonePassCount = readAtrac3Bits(bitstream, 5) & 0x1f;
  if (tonePassCount === 0) {
    return 0;
  }

  const passMode = readAtrac3Bits(bitstream, 2) & 3;
  if (passMode === AT3_DEC_TONE_INVALID_PASS_MODE) {
    markAtrac3DecodeError(state);
    return 0;
  }

  const usesDynamicTableSel = passMode === AT3_DEC_TONE_DYNAMIC_TABLE_SEL_MODE;
  const toneState = { maxCoeffIndex: 0, segmentCount: 0 };

  // Tone passes patch sparse tonal detail back into whichever transform
  // blocks the activity bitfield enables for the current pass.
  for (let pass = 0; pass < tonePassCount; pass += 1) {
    const tonePass = readAtrac3TonePass(state, activeUnitCount, usesDynamicTableSel, passMode);
    if (tonePass === null) {
      return null;
    }
    if (tonePass.unitActivityBits === 0) {
      continue;
    }
    if (!decodeAtrac3TonePassUnits(state, activeUnitCount, spectrum, tonePass, toneState)) {
      return null;
    }
  }

  return toneState.maxCoeffIndex;
}
