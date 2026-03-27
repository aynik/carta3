import {
  AT3_DEC_BLOCK_FLOATS,
  AT3_DEC_NEUTRAL_GAIN,
  ATRAC3_RESIDUAL_DELAY_SAMPLES,
} from "./constants.js";
import {
  AT3_DEC_COEFF_SCALE_BITS,
  AT3_DEC_COEFF_TABLE,
  AT3_DEC_SCALE_TABLE,
  AT3_DEC_TWIDDLE_TABLE,
  AT3_REORDER_TABLE_128,
} from "./decode-tables.js";

const AT3_DEC_MIX_STRIDE = 4;
const AT3_DEC_GAIN_RAMP_SUBSTEPS = 8;
const AT3_DEC_GAIN_RAMP_STEPS = AT3_DEC_GAIN_RAMP_SUBSTEPS - 1;
const AT3_DEC_FINE_GAIN_TABLE_OFFSET = 0x10;
const AT3_DEC_TRANSFORM_HALF_FLOATS = AT3_DEC_BLOCK_FLOATS >> 1;
const AT3_DEC_TRANSFORM_LAST_ROW = AT3_DEC_TRANSFORM_HALF_FLOATS - 1;
const AT3_DEC_WORK_UPPER_HALF_OFFSET = AT3_DEC_TRANSFORM_HALF_FLOATS * AT3_DEC_MIX_STRIDE;
const AT3_DEC_WORK_BLOCK_FLOATS = AT3_DEC_BLOCK_FLOATS * AT3_DEC_MIX_STRIDE;

function prepareAtrac3BlockMirrors(spectra, spectrumOffset, blockEnd, swapMirrors) {
  for (let index = 0; index < AT3_DEC_TRANSFORM_HALF_FLOATS; index += 1) {
    const loIndex = spectrumOffset + index;
    const mirrorIndex = blockEnd - 1 - index;

    if (!swapMirrors) {
      spectra[loIndex] -= spectra[mirrorIndex];
      continue;
    }

    const sample = spectra[loIndex];
    spectra[loIndex] = spectra[mirrorIndex] - sample;
    spectra[mirrorIndex] = sample;
  }
}

function preconditionAtrac3BlockTransform(spectra, spectrumOffset, halfOffset) {
  for (let index = 0; index < AT3_DEC_TRANSFORM_HALF_FLOATS; index += 1) {
    const loIndex = spectrumOffset + index;
    const hiIndex = halfOffset + index;
    const lo = spectra[loIndex];
    const hi = spectra[hiIndex];

    spectra[hiIndex] = lo - hi * AT3_DEC_COEFF_SCALE_BITS;
    spectra[loIndex] = lo + hi * AT3_DEC_COEFF_SCALE_BITS;
  }
}

function applyAtrac3BlockTwiddleStages(spectra, spectrumOffset, blockEnd) {
  for (let step = AT3_DEC_TRANSFORM_HALF_FLOATS >> 1; step > 2; step >>= 1) {
    const halfStep = step >> 1;
    let twiddlePos = AT3_DEC_TRANSFORM_LAST_ROW - halfStep;

    for (
      let segmentBase = spectrumOffset;
      segmentBase < blockEnd;
      segmentBase += step * 2, twiddlePos -= step
    ) {
      const span = step * 2;

      for (let offset = 0; offset < step; offset += 1) {
        spectra[segmentBase + offset] -= spectra[segmentBase + span - 1 - offset];
      }

      const twiddle = AT3_DEC_TWIDDLE_TABLE[twiddlePos] ?? 0;
      for (let pairOffset = 0; pairOffset < step; pairOffset += 2) {
        const loIndex = segmentBase + pairOffset;
        const hiIndex = loIndex + step;
        const sampleA = twiddle * spectra[hiIndex];
        const sampleB = twiddle * spectra[hiIndex + 1];

        spectra[hiIndex] = spectra[loIndex] - sampleA;
        spectra[hiIndex + 1] = spectra[loIndex + 1] - sampleB;
        spectra[loIndex] += sampleA;
        spectra[loIndex + 1] += sampleB;
      }
    }
  }
}

function finalizeAtrac3BlockTransform(spectra, spectrumOffset) {
  for (let row = 0; row < AT3_DEC_TRANSFORM_HALF_FLOATS >> 1; row += 1) {
    const sampleBase = spectrumOffset + row * 4;
    const diffA = spectra[sampleBase] - spectra[sampleBase + 3];
    const diffB = spectra[sampleBase + 1] - spectra[sampleBase + 2];
    const twiddle = AT3_DEC_TWIDDLE_TABLE[AT3_DEC_TRANSFORM_LAST_ROW - 1 - row * 2] ?? 0;
    const scaledA = spectra[sampleBase + 2] * twiddle;
    const scaledB = spectra[sampleBase + 3] * twiddle;

    spectra[sampleBase] = diffA + scaledA;
    spectra[sampleBase + 2] = diffA - scaledA;
    spectra[sampleBase + 1] = diffB + scaledB;
    spectra[sampleBase + 3] = diffB - scaledB;
  }
}

// Gain-pair entries encode a steady plateau up to each start marker, followed
// by a fixed 7-step ramp into the next gain level.
function applyAtrac3BlockGainEnvelope(work, dstBase, pairEntries) {
  const scaleCursor = dstBase + AT3_DEC_WORK_BLOCK_FLOATS;
  let currentGain = pairEntries[0].gain | 0;
  let dst = dstBase;

  for (let pairIndex = 0; dst < scaleCursor; pairIndex += 1) {
    const transitionStart = dstBase + ((pairEntries[pairIndex].start | 0) + 1) * AT3_DEC_MIX_STRIDE;

    if (currentGain === AT3_DEC_NEUTRAL_GAIN) {
      dst = transitionStart;
      if (dst >= scaleCursor) {
        break;
      }
    } else {
      const steadyScale = AT3_DEC_SCALE_TABLE[currentGain] ?? 0;
      for (; dst < transitionStart; dst += AT3_DEC_MIX_STRIDE) {
        work[dst] *= steadyScale;
      }
    }

    const nextGain = pairEntries[pairIndex + 1].gain | 0;
    const rampDelta = nextGain - currentGain;
    let gainStep = currentGain * AT3_DEC_GAIN_RAMP_SUBSTEPS;

    for (
      let rampStep = 0;
      rampStep < AT3_DEC_GAIN_RAMP_STEPS && dst < scaleCursor;
      rampStep += 1, dst += AT3_DEC_MIX_STRIDE
    ) {
      gainStep += rampDelta;
      const fineGainIndex =
        (gainStep & (AT3_DEC_GAIN_RAMP_SUBSTEPS - 1)) + AT3_DEC_FINE_GAIN_TABLE_OFFSET;
      const coarseGainIndex = gainStep >> 3;
      const rampScale =
        (AT3_DEC_SCALE_TABLE[fineGainIndex] ?? 0) * (AT3_DEC_SCALE_TABLE[coarseGainIndex] ?? 0);
      work[dst] *= rampScale;
    }

    currentGain = nextGain;
  }
}

/**
 * Rebuilds one ATRAC3 spectrum block into the decoder overlap/add work buffer.
 *
 * This owns the block-local inverse transform, coefficient reorder, residual
 * history rotation, and staged gain-envelope application. The neighboring
 * `decode-rebuild.js` owner uses this block helper to rebuild one full channel
 * work area from the decoded payload.
 */
export function applyAtrac3BlockTransform(
  spectra,
  spectrumOffset,
  blockIndex,
  gainIndex,
  channelState
) {
  const blockEnd = spectrumOffset + AT3_DEC_BLOCK_FLOATS;
  const halfOffset = spectrumOffset + AT3_DEC_TRANSFORM_HALF_FLOATS;
  prepareAtrac3BlockMirrors(spectra, spectrumOffset, blockEnd, (blockIndex & 1) !== 0);
  preconditionAtrac3BlockTransform(spectra, spectrumOffset, halfOffset);
  applyAtrac3BlockTwiddleStages(spectra, spectrumOffset, blockEnd);
  finalizeAtrac3BlockTransform(spectra, spectrumOffset);

  const work = channelState.workF32;
  const history = channelState.spectrumHistory[blockIndex];
  const dstBase = ATRAC3_RESIDUAL_DELAY_SAMPLES + blockIndex;
  const upperWorkBase = dstBase + AT3_DEC_WORK_UPPER_HALF_OFFSET;
  const gainScale = AT3_DEC_SCALE_TABLE[gainIndex] ?? 0;

  for (let row = 0; row < AT3_DEC_TRANSFORM_HALF_FLOATS; row += 1) {
    const reorder = AT3_REORDER_TABLE_128[row];
    const coeffBase = reorder * 4;
    const srcIndex = spectrumOffset + row * 2;
    const sampleA = spectra[srcIndex];
    const sampleB = spectra[srcIndex + 1];
    const diff = sampleA - sampleB;
    const scaledSum = (AT3_DEC_COEFF_TABLE[coeffBase + 3] ?? 0) * sampleB;
    const coeffA = AT3_DEC_COEFF_TABLE[coeffBase] ?? 0;
    const coeffB = AT3_DEC_COEFF_TABLE[coeffBase + 1] ?? 0;
    const coeffScale = AT3_DEC_COEFF_TABLE[coeffBase + 2] ?? 0;
    const previous = history[reorder];
    const transformed = (diff - scaledSum) * gainScale * coeffScale;

    work[dstBase + (AT3_DEC_TRANSFORM_LAST_ROW - reorder) * AT3_DEC_MIX_STRIDE] =
      previous - coeffA * transformed;
    work[upperWorkBase + reorder * AT3_DEC_MIX_STRIDE] = coeffA * previous + transformed;
    history[reorder] = (diff + scaledSum) * coeffB;
  }

  applyAtrac3BlockGainEnvelope(work, dstBase, channelState.gainTables.active[blockIndex]);
}
