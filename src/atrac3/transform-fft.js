import { AT3_REORDER_TABLE_128 } from "./decode-tables.js";
import {
  AT3ENC_POW2_SCALE_TABLE_F32,
  AT3ENC_PROC_SCALE_TABLE_256,
  AT3ENC_TWIDDLE_TABLE,
} from "./encode-tables.js";

const AT3ENC_TRANSFORM_ROW_COUNT = 128;
const AT3ENC_TRANSFORM_LANE_COUNT = 4;
const AT3ENC_FFT_HALF_OFFSET = 512;
const AT3ENC_SPECTRUM_MIRROR_OFFSET = 128;
const AT3ENC_SPECTRUM_QUADRANT_STRIDE = 256;
const K_INV_SQRT1_2 = 0.7071067690849304;

function copySpectrumToTransformWork(layer) {
  const spectrum = layer.spectrum;
  const transformWork = layer.workspace.transform;
  for (let index = 0; index < 1024; index += 1) {
    const sample = spectrum[index];
    transformWork[index] = Object.is(sample, -0) ? 0 : sample;
  }
}

/**
 * Twiddles the ATRAC3 transform windows, runs the FFT butterfly passes, and
 * scatters the folded result back into ATRAC3 spectrum order.
 */
export function runAtrac3TransformFft(layer, fftStorage, debugStages = null) {
  const transformWork = layer.workspace.transform;
  const spectrum = layer.spectrum;
  const toneBlocks = layer.tones.blocks;
  const frontWindow = transformWork.subarray(0, 512);
  const middleWindow = transformWork.subarray(512, 1024);
  const tailWindow = transformWork.subarray(1024, 1536);
  const captureDebugStages = debugStages && typeof debugStages === "object";

  if (captureDebugStages) {
    debugStages.buf1000Before = new Float32Array(frontWindow);
    debugStages.buf1800Before = new Float32Array(middleWindow);
    debugStages.buf2000Before = new Float32Array(tailWindow);
  }

  const workspace = layer.workspace;
  let laneWeights = workspace.laneWeights;
  if (
    !(laneWeights instanceof Float32Array) ||
    laneWeights.length !== AT3ENC_TRANSFORM_LANE_COUNT
  ) {
    laneWeights = new Float32Array(AT3ENC_TRANSFORM_LANE_COUNT);
    workspace.laneWeights = laneWeights;
  }
  for (let lane = 0; lane < AT3ENC_TRANSFORM_LANE_COUNT; lane += 1) {
    const gainIndex = toneBlocks[lane].gainIndex[0];
    laneWeights[lane] = AT3ENC_POW2_SCALE_TABLE_F32[gainIndex] ?? 0;
  }

  // Twiddle the three transform windows into the interleaved FFT scratch
  // layout expected by the later butterfly passes.
  for (let row = 0; row < AT3ENC_TRANSFORM_ROW_COUNT; row += 1) {
    const reorderedRow = AT3_REORDER_TABLE_128[row];
    const twiddleBase = reorderedRow * 4;
    const twiddleMix = AT3ENC_TWIDDLE_TABLE[twiddleBase + 0] ?? 0;
    const twiddleDiff = AT3ENC_TWIDDLE_TABLE[twiddleBase + 1] ?? 0;
    const twiddleScale = AT3ENC_TWIDDLE_TABLE[twiddleBase + 2] ?? 0;
    const twiddleOutput = AT3ENC_TWIDDLE_TABLE[twiddleBase + 3] ?? 0;
    const fftRowBase = row * 8;
    const tailRowBase = row * 4;
    const middleRowBase = reorderedRow * 4;
    const frontRowBase = (0x7f - reorderedRow) * 4;

    for (let lane = 0; lane < AT3ENC_TRANSFORM_LANE_COUNT; lane += 1) {
      const tailIndex = tailRowBase + lane;
      const weightedTail = laneWeights[lane] * tailWindow[tailIndex];
      const middleValue = middleWindow[middleRowBase + lane];
      const frontValue = frontWindow[frontRowBase + lane];

      const mixed = (frontValue * twiddleMix + middleValue) * twiddleScale;
      tailWindow[tailIndex] = (middleValue * twiddleMix - frontValue) * twiddleDiff;

      const side = (mixed - weightedTail) * twiddleOutput;
      let main = mixed + weightedTail;
      main += side;

      fftStorage[fftRowBase + lane + 4] = side;
      fftStorage[fftRowBase + lane] = main;
    }
  }

  if (captureDebugStages) {
    debugStages.buf2000AfterTwiddle = new Float32Array(tailWindow);
    debugStages.fftAfterTwiddle = new Float32Array(fftStorage);
  }

  copySpectrumToTransformWork(layer);

  // First butterfly sweep across the 128 interleaved FFT rows.
  for (let phaseIndex = -0x80, stageBase = 0; phaseIndex < 0; phaseIndex += 2, stageBase += 0x10) {
    const scale = AT3ENC_PROC_SCALE_TABLE_256[phaseIndex + 0x81] ?? 0;
    for (let lane = 0; lane < AT3ENC_TRANSFORM_LANE_COUNT; lane += 1) {
      const laneBase = stageBase + lane;
      const highPair = fftStorage[laneBase + 0x0c];
      const lowReal = fftStorage[laneBase + 0x00];
      const lowImag = fftStorage[laneBase + 0x04];
      const midReal = fftStorage[laneBase + 0x08];

      const scaledHigh = Math.fround(lowImag - highPair) * scale; // Required rounding
      const scaledMid = (lowReal - midReal) * scale;

      fftStorage[laneBase + 0x0c] = scaledHigh;
      fftStorage[laneBase + 0x00] = Math.fround(lowReal + midReal) + scaledHigh; // Required rounding
      fftStorage[laneBase + 0x08] = scaledMid;
      fftStorage[laneBase + 0x04] = Math.fround(lowImag + highPair) + scaledMid; // Required rounding
    }
  }

  if (captureDebugStages) {
    debugStages.fftAfterStage1 = new Float32Array(fftStorage);
  }

  // Grow the butterfly span until the full 128-row transform is folded.
  for (let span = 4; span !== 0x80; span *= 2) {
    let phase = (span >> 1) - 0x80;
    let phaseBase = 0;

    while (phase < 1) {
      const scale = AT3ENC_PROC_SCALE_TABLE_256[0x80 + phase] ?? 0;
      const butterflyLimit = phaseBase + span * 4;

      while (phaseBase !== butterflyLimit) {
        let lowerHalfPtr = phaseBase;
        let upperHalfPtr = phaseBase + span * 4 + 4;

        for (let lane = 0; lane < AT3ENC_TRANSFORM_LANE_COUNT; lane += 1) {
          const foldedLaneBase = phaseBase + span * 4 + lane;
          const foldedReal = fftStorage[foldedLaneBase];
          const foldedImag = fftStorage[upperHalfPtr];
          const currentReal = fftStorage[lowerHalfPtr];
          const currentImag = fftStorage[lowerHalfPtr + 4];

          fftStorage[foldedLaneBase] = Math.fround(currentReal - foldedReal) * scale; // Required rounding
          fftStorage[upperHalfPtr] = Math.fround(currentImag - foldedImag) * scale; // Required rounding
          fftStorage[lowerHalfPtr] = foldedReal + currentReal;
          fftStorage[lowerHalfPtr + 4] = foldedImag + currentImag;
          upperHalfPtr += 1;
          lowerHalfPtr += 1;
        }

        phaseBase += 8;
      }

      let mirrorOffset = span * 2 - 1;
      phaseBase -= span * 4;
      while (mirrorOffset > 0) {
        let tableOffset = mirrorOffset << 4;
        let mixBase = phaseBase;
        for (let lane = 0; lane < AT3ENC_TRANSFORM_LANE_COUNT; lane += 1) {
          fftStorage[mixBase + 0x00] =
            fftStorage[phaseBase + (tableOffset >> 2)] + fftStorage[mixBase + 0x00];
          fftStorage[mixBase + 0x04] =
            fftStorage[phaseBase + ((tableOffset - 0x10) >> 2)] + fftStorage[mixBase + 0x04];
          fftStorage[mixBase + 0x08] =
            fftStorage[phaseBase + ((tableOffset - 0x20) >> 2)] + fftStorage[mixBase + 0x08];

          const highTableOffset = tableOffset - 0x30;
          tableOffset += 4;
          fftStorage[mixBase + 0x0c] =
            fftStorage[phaseBase + (highTableOffset >> 2)] + fftStorage[mixBase + 0x0c];
          mixBase += 1;
        }
        phaseBase += 0x10;
        mirrorOffset -= 8;
      }

      phaseBase += span * 4;
      phase += span;
    }
  }

  if (captureDebugStages) {
    debugStages.fftAfterStage2 = new Float32Array(fftStorage);
  }

  // Fold the mirrored FFT halves back into the codec's 512+512 layout.
  for (let row = 0; row < AT3ENC_TRANSFORM_ROW_COUNT; row += 1) {
    for (let lane = 0; lane < AT3ENC_TRANSFORM_LANE_COUNT; lane += 1) {
      const low = row * AT3ENC_TRANSFORM_LANE_COUNT + lane;
      const high = low + AT3ENC_FFT_HALF_OFFSET;
      const lowerHalf = fftStorage[low];
      const upperHalf = fftStorage[high];
      fftStorage[low] = lowerHalf + upperHalf;
      fftStorage[high] = (lowerHalf - upperHalf) * K_INV_SQRT1_2;
    }
  }

  if (captureDebugStages) {
    debugStages.fftAfterStage3 = new Float32Array(fftStorage);
  }

  // Scatter the folded FFT rows back into the ATRAC3 spectrum packing order.
  for (let row = 0; row < AT3ENC_TRANSFORM_ROW_COUNT; row += 1) {
    const lowerRowBase = row * AT3ENC_TRANSFORM_LANE_COUNT;
    const upperRowBase =
      AT3ENC_FFT_HALF_OFFSET + (AT3ENC_TRANSFORM_ROW_COUNT - 1 - row) * AT3ENC_TRANSFORM_LANE_COUNT;
    const mirroredRow = AT3ENC_TRANSFORM_ROW_COUNT - 1 - row;

    for (let lane = 0; lane < AT3ENC_TRANSFORM_LANE_COUNT; lane += 1) {
      fftStorage[lowerRowBase + lane] += fftStorage[upperRowBase + lane];
    }

    spectrum[row] = fftStorage[lowerRowBase + 0];
    spectrum[AT3ENC_SPECTRUM_QUADRANT_STRIDE + row] = fftStorage[upperRowBase + 1];
    spectrum[AT3ENC_SPECTRUM_QUADRANT_STRIDE * 2 + row] = fftStorage[lowerRowBase + 2];
    spectrum[AT3ENC_SPECTRUM_QUADRANT_STRIDE * 3 + row] = fftStorage[upperRowBase + 3];

    spectrum[AT3ENC_SPECTRUM_MIRROR_OFFSET + mirroredRow] = fftStorage[upperRowBase + 0];
    spectrum[AT3ENC_SPECTRUM_QUADRANT_STRIDE + AT3ENC_SPECTRUM_MIRROR_OFFSET + mirroredRow] =
      fftStorage[lowerRowBase + 1];
    spectrum[AT3ENC_SPECTRUM_QUADRANT_STRIDE * 2 + AT3ENC_SPECTRUM_MIRROR_OFFSET + mirroredRow] =
      fftStorage[upperRowBase + 2];
    spectrum[AT3ENC_SPECTRUM_QUADRANT_STRIDE * 3 + AT3ENC_SPECTRUM_MIRROR_OFFSET + mirroredRow] =
      fftStorage[lowerRowBase + 3];
  }
}
