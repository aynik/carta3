/**
 * Carta3 Audio Codec - Quadrature-mirror filter kernels.
 *
 * The 132 kbps encoder uses a cascaded 48-tap analysis filter with three
 * independent delay lines. The 66/105 kbps encoder and decoder instead use a
 * fused four-lane polyphase form with explicit f32 rounding and one interleaved
 * 138-sample history. They share the QMF responsibility, but not a numerically
 * interchangeable convolution kernel.
 */

import {
  ANALYSIS_WORK_FLOATS,
  BAND_PART_FLOATS,
  BAND_STRIDE_FLOATS,
  FRAME_SAMPLES,
  HIGH_HISTORY_OFFSET,
  LAYERED_QMF_ANALYSIS_MIRROR_INDEX,
  LAYERED_QMF_ANALYSIS_TAIL_INDEX,
  LAYERED_QMF_CONVOLUTION_CURSOR_OFFSET,
  LAYERED_QMF_HISTORY_FLOATS,
  LAYERED_QMF_STAGE_OFFSET,
  LAYERED_QMF_SYNTHESIS_CARRY_OFFSET,
  LAYERED_QMF_SYNTHESIS_CURSOR_OFFSET,
  LAYERED_QMF_SYNTHESIS_HISTORY_OFFSET,
  LAYERED_QMF_SYNTHESIS_LAST_TAP,
  LAYERED_QMF_SYNTHESIS_MIRROR_INDEX,
  LOW_HISTORY_OFFSET,
  QMF_DELAY,
  QMF_TAPS,
  ROOT_HISTORY_OFFSET,
  SUBBAND_COUNT,
} from '../core/constants.js'
import {
  ANALYSIS_QMF_CURVE,
  QMF_ANALYSIS_COEFFICIENTS,
  SYNTHESIS_QMF_CURVE,
  TWO_PI,
} from '../core/tables.js'
import { IndependentQmfScratch } from '../state/encoder.js'
import { float32Add, float32Multiply } from '../utils.js'

/**
 * Locate a subband's oldest gain-analysis half in the 132 kbps work image.
 * @param {number} subband Subband index from zero through three.
 * @returns {number} Float offset in the analysis work image.
 */
export function bandGainOffset(subband) {
  return subband * BAND_STRIDE_FLOATS
}

/**
 * Locate a subband's middle MDCT half in the 132 kbps work image.
 * @param {number} subband Subband index from zero through three.
 * @returns {number} Float offset in the analysis work image.
 */
export function bandMdctOffset(subband) {
  return bandGainOffset(subband) + BAND_PART_FLOATS
}

/**
 * Locate a subband's newest QMF half in the 132 kbps work image.
 * @param {number} subband Subband index from zero through three.
 * @returns {number} Float offset in the analysis work image.
 */
export function bandSplitOffset(subband) {
  return bandGainOffset(subband) + 2 * BAND_PART_FLOATS
}

/** Convolve one QMF branch and publish its updated delay line. */
function analyzeBranch(
  input,
  low,
  high,
  sampleCount,
  history,
  convolutionWork
) {
  for (let index = 0; index < QMF_DELAY; index++) {
    convolutionWork[index] = history[index]
  }
  for (let index = 0; index < sampleCount; index++) {
    convolutionWork[QMF_DELAY + index] = input[index]
  }
  history.set(input.subarray(sampleCount - QMF_DELAY, sampleCount))

  for (let outputIndex = 0; outputIndex < sampleCount / 2; outputIndex++) {
    const windowStart = outputIndex * 2
    let evenSum = 0
    let oddSum = 0
    for (let tap = QMF_TAPS - 1; tap >= 0; tap -= 4) {
      evenSum +=
        convolutionWork[windowStart + tap] * QMF_ANALYSIS_COEFFICIENTS[tap]
      evenSum +=
        convolutionWork[windowStart + tap - 2] *
        QMF_ANALYSIS_COEFFICIENTS[tap - 2]
      oddSum +=
        convolutionWork[windowStart + tap - 1] *
        QMF_ANALYSIS_COEFFICIENTS[tap - 1]
      oddSum +=
        convolutionWork[windowStart + tap - 3] *
        QMF_ANALYSIS_COEFFICIENTS[tap - 3]
    }
    low[outputIndex] = evenSum + oddSum
    high[outputIndex] = evenSum - oddSum
  }
}

/**
 * Advance one channel's three-deep history and analyze one PCM frame.
 * @param {Float32Array} pcm One complete 1024-sample channel frame.
 * @param {Float32Array} analysisWork Persistent 132 kbps analysis image.
 * @param {object} scratch Operation-local QMF buffers.
 * @returns {Float32Array} `analysisWork` with its newest split slots populated.
 */
export function analyzeIndependentQmf(
  pcm,
  analysisWork,
  scratch = new IndependentQmfScratch()
) {
  if (pcm.length < FRAME_SAMPLES) {
    throw new RangeError('ATRAC3 QMF analysis requires 1024 PCM samples')
  }
  if (analysisWork.length < ANALYSIS_WORK_FLOATS) {
    throw new RangeError('ATRAC3 QMF analysis work buffer is too short')
  }
  if (
    !scratch ||
    scratch.firstLow?.length < 512 ||
    scratch.firstHigh?.length < 512 ||
    scratch.convolutionWork?.length < QMF_DELAY + FRAME_SAMPLES
  ) {
    throw new RangeError('ATRAC3 QMF scratch has invalid geometry')
  }

  for (let band = 0; band < SUBBAND_COUNT; band++) {
    const base = bandGainOffset(band)
    analysisWork.copyWithin(
      base,
      base + BAND_PART_FLOATS,
      base + 3 * BAND_PART_FLOATS
    )
  }

  const rootHistory = analysisWork.subarray(
    ROOT_HISTORY_OFFSET,
    ROOT_HISTORY_OFFSET + QMF_DELAY
  )
  analyzeBranch(
    pcm,
    scratch.firstLow,
    scratch.firstHigh,
    FRAME_SAMPLES,
    rootHistory,
    scratch.convolutionWork
  )

  analyzeBranch(
    scratch.firstLow,
    analysisWork.subarray(
      bandSplitOffset(0),
      bandSplitOffset(0) + BAND_PART_FLOATS
    ),
    analysisWork.subarray(
      bandSplitOffset(1),
      bandSplitOffset(1) + BAND_PART_FLOATS
    ),
    512,
    analysisWork.subarray(LOW_HISTORY_OFFSET, LOW_HISTORY_OFFSET + QMF_DELAY),
    scratch.convolutionWork
  )

  analyzeBranch(
    scratch.firstHigh,
    analysisWork.subarray(
      bandSplitOffset(3),
      bandSplitOffset(3) + BAND_PART_FLOATS
    ),
    analysisWork.subarray(
      bandSplitOffset(2),
      bandSplitOffset(2) + BAND_PART_FLOATS
    ),
    512,
    analysisWork.subarray(HIGH_HISTORY_OFFSET, HIGH_HISTORY_OFFSET + QMF_DELAY),
    scratch.convolutionWork
  )

  return analysisWork
}

/**
 * Analyze one low-rate channel through the fused polyphase QMF.
 *
 * @param {Float32Array} pcm One complete PCM frame.
 * @param {Float32Array} spectrum Destination for four interleaved bands.
 * @param {Float32Array} history Persistent 138-float interleaved delay state.
 * @param {Float32Array} [scratch] Operation-local history+input workspace.
 * @returns {Float32Array} `spectrum` after analysis.
 */
export function analyzeLayeredQmf(
  pcm,
  spectrum,
  history,
  scratch = new Float32Array(FRAME_SAMPLES + LAYERED_QMF_HISTORY_FLOATS)
) {
  if (
    pcm.length < FRAME_SAMPLES ||
    spectrum.length < FRAME_SAMPLES ||
    history.length < LAYERED_QMF_HISTORY_FLOATS ||
    scratch.length < FRAME_SAMPLES + LAYERED_QMF_HISTORY_FLOATS
  ) {
    throw new RangeError('ATRAC3 layered QMF has invalid buffer geometry')
  }
  scratch.set(history.subarray(0, LAYERED_QMF_HISTORY_FLOATS), 0)

  for (let window = 0; window < FRAME_SAMPLES; window += 4) {
    const sample0 = pcm[window]
    const sample1 = pcm[window + 1]
    const sample2 = pcm[window + 2]
    const sample3 = pcm[window + 3]
    scratch[window + LAYERED_QMF_HISTORY_FLOATS] = sample0
    scratch[window + LAYERED_QMF_HISTORY_FLOATS + 1] = sample1
    scratch[window + LAYERED_QMF_HISTORY_FLOATS + 2] = sample2
    scratch[window + LAYERED_QMF_HISTORY_FLOATS + 3] = sample3

    let oddLow = float32Add(
      sample1,
      float32Multiply(
        scratch[window + LAYERED_QMF_STAGE_OFFSET + 1],
        ANALYSIS_QMF_CURVE[0]
      )
    )
    let oddHigh = float32Add(
      sample3,
      float32Multiply(
        scratch[window + LAYERED_QMF_STAGE_OFFSET + 3],
        ANALYSIS_QMF_CURVE[0]
      )
    )
    let evenLow = float32Add(
      float32Multiply(sample0, ANALYSIS_QMF_CURVE[0]),
      scratch[window + LAYERED_QMF_STAGE_OFFSET]
    )
    let evenHigh = float32Add(
      float32Multiply(sample2, ANALYSIS_QMF_CURVE[0]),
      scratch[window + LAYERED_QMF_STAGE_OFFSET + 2]
    )
    for (
      let curveIndex = LAYERED_QMF_ANALYSIS_TAIL_INDEX;
      curveIndex >= 1;
      curveIndex--
    ) {
      const mirrored = LAYERED_QMF_ANALYSIS_MIRROR_INDEX - curveIndex
      oddHigh = float32Add(
        oddHigh,
        float32Multiply(
          ANALYSIS_QMF_CURVE[curveIndex],
          scratch[window + curveIndex * 2 + LAYERED_QMF_STAGE_OFFSET + 3]
        )
      )
      oddLow = float32Add(
        oddLow,
        float32Multiply(
          ANALYSIS_QMF_CURVE[curveIndex],
          scratch[window + curveIndex * 2 + LAYERED_QMF_STAGE_OFFSET + 1]
        )
      )
      evenLow = float32Add(
        evenLow,
        float32Multiply(
          ANALYSIS_QMF_CURVE[mirrored],
          scratch[window + curveIndex * 2 + LAYERED_QMF_STAGE_OFFSET]
        )
      )
      evenHigh = float32Add(
        evenHigh,
        float32Multiply(
          ANALYSIS_QMF_CURVE[mirrored],
          scratch[window + curveIndex * 2 + LAYERED_QMF_STAGE_OFFSET + 2]
        )
      )
    }
    const lowSum = float32Add(oddLow, evenLow)
    const lowDifference = float32Add(oddLow, -evenLow)
    const highSum = float32Add(oddHigh, evenHigh)
    const highDifference = float32Add(oddHigh, -evenHigh)
    scratch[window + LAYERED_QMF_STAGE_OFFSET] = lowSum
    scratch[window + LAYERED_QMF_STAGE_OFFSET + 1] = lowDifference
    scratch[window + LAYERED_QMF_STAGE_OFFSET + 2] = highSum
    scratch[window + LAYERED_QMF_STAGE_OFFSET + 3] = highDifference

    let lane0 = float32Add(
      float32Multiply(scratch[window + 2], ANALYSIS_QMF_CURVE[0]),
      highSum
    )
    let lane1 = float32Add(
      float32Multiply(scratch[window + 3], ANALYSIS_QMF_CURVE[0]),
      highDifference
    )
    let lane2 = float32Add(
      float32Multiply(lowDifference, ANALYSIS_QMF_CURVE[0]),
      scratch[window + 1]
    )
    let lane3 = float32Add(
      float32Multiply(lowSum, ANALYSIS_QMF_CURVE[0]),
      scratch[window]
    )
    const cursor = window + LAYERED_QMF_CONVOLUTION_CURSOR_OFFSET
    for (
      let curveIndex = LAYERED_QMF_ANALYSIS_TAIL_INDEX;
      curveIndex >= 1;
      curveIndex--
    ) {
      const mirrored = LAYERED_QMF_ANALYSIS_MIRROR_INDEX - curveIndex
      const offset = cursor - (LAYERED_QMF_ANALYSIS_TAIL_INDEX - curveIndex) * 4
      lane1 = float32Add(
        lane1,
        float32Multiply(ANALYSIS_QMF_CURVE[curveIndex], scratch[offset + 3])
      )
      lane0 = float32Add(
        lane0,
        float32Multiply(ANALYSIS_QMF_CURVE[curveIndex], scratch[offset + 2])
      )
      lane3 = float32Add(
        lane3,
        float32Multiply(ANALYSIS_QMF_CURVE[mirrored], scratch[offset])
      )
      lane2 = float32Add(
        lane2,
        float32Multiply(ANALYSIS_QMF_CURVE[mirrored], scratch[offset + 1])
      )
    }
    spectrum[window] = float32Add(lane0, lane3)
    spectrum[window + 1] = float32Add(lane0, -lane3)
    spectrum[window + 2] = float32Add(lane1, -lane2)
    spectrum[window + 3] = float32Add(lane1, lane2)
  }

  history.set(
    scratch.subarray(FRAME_SAMPLES, FRAME_SAMPLES + LAYERED_QMF_HISTORY_FLOATS)
  )
  return spectrum
}

/**
 * Fold four interleaved decoded bands through the low-rate synthesis QMF.
 * @param {object} channel Decoder channel state containing synthesis history.
 * @returns {Float32Array} One reconstructed PCM frame view.
 */
export function synthesizeLayeredQmf(channel) {
  const work = channel.synthesisBuffer
  const twoPi = Number(TWO_PI)
  for (let frameOffset = 0; frameOffset < FRAME_SAMPLES; frameOffset += 4) {
    let evenDifference =
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS]) -
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 1])
    let evenSum =
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS]) +
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 1])
    let oddSum =
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 3]) +
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 2])
    work[frameOffset + LAYERED_QMF_HISTORY_FLOATS] = Math.fround(evenDifference)
    evenDifference +=
      Number(work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET]) * twoPi
    let oddDifference =
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 3]) -
      Number(work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 2])
    work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 3] = Math.fround(oddSum)
    work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 1] = Math.fround(evenSum)
    evenSum =
      evenSum * twoPi +
      Number(work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 1])
    oddSum =
      oddSum * twoPi +
      Number(work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 3])
    work[frameOffset + LAYERED_QMF_HISTORY_FLOATS + 2] =
      Math.fround(oddDifference)
    oddDifference +=
      Number(work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 2]) * twoPi

    let historyOffset = frameOffset + LAYERED_QMF_SYNTHESIS_CURSOR_OFFSET
    for (let tap = LAYERED_QMF_SYNTHESIS_LAST_TAP; tap >= 0; tap--) {
      const mirrored = LAYERED_QMF_SYNTHESIS_MIRROR_INDEX - tap
      oddDifference +=
        Number(SYNTHESIS_QMF_CURVE[tap + 1]) *
        Number(work[historyOffset + LAYERED_QMF_SYNTHESIS_HISTORY_OFFSET + 2])
      evenDifference +=
        Number(SYNTHESIS_QMF_CURVE[tap + 1]) *
        Number(work[historyOffset + LAYERED_QMF_SYNTHESIS_HISTORY_OFFSET])
      evenSum +=
        Number(SYNTHESIS_QMF_CURVE[mirrored]) *
        Number(work[historyOffset + LAYERED_QMF_SYNTHESIS_HISTORY_OFFSET + 1])
      oddSum +=
        Number(SYNTHESIS_QMF_CURVE[mirrored]) *
        Number(work[historyOffset + LAYERED_QMF_SYNTHESIS_HISTORY_OFFSET + 3])
      if (tap !== 0) historyOffset -= 4
    }

    work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 2] = Math.fround(
      evenSum - oddSum
    )
    let lane2 = evenSum - oddSum + Number(work[frameOffset + 2]) * twoPi
    work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 1] = Math.fround(
      evenDifference + oddDifference
    )
    let lane1 =
      (evenDifference + oddDifference) * twoPi + Number(work[frameOffset + 1])
    let lane0 =
      Number(work[frameOffset]) * twoPi + evenDifference - oddDifference
    work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET] = Math.fround(
      evenDifference - oddDifference
    )
    let lane3 = (oddSum + evenSum) * twoPi + Number(work[frameOffset + 3])
    work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 3] = Math.fround(
      oddSum + evenSum
    )

    for (let tap = LAYERED_QMF_SYNTHESIS_LAST_TAP; tap >= 0; tap--) {
      const mirrored = LAYERED_QMF_SYNTHESIS_MIRROR_INDEX - tap
      lane2 +=
        Number(SYNTHESIS_QMF_CURVE[tap + 1]) *
        Number(work[frameOffset + tap * 2 + 4])
      lane0 +=
        Number(SYNTHESIS_QMF_CURVE[tap + 1]) *
        Number(work[frameOffset + tap * 2 + 2])
      lane1 +=
        Number(SYNTHESIS_QMF_CURVE[mirrored]) *
        Number(work[frameOffset + tap * 2 + 3])
      lane3 +=
        Number(SYNTHESIS_QMF_CURVE[mirrored]) *
        Number(work[frameOffset + tap * 2 + 5])
    }
    work[frameOffset] = Math.fround(lane0)
    work[frameOffset + 1] = Math.fround(lane1)
    work[frameOffset + 2] = Math.fround(lane2)
    work[frameOffset + 3] = Math.fround(lane3)
  }
  return work.subarray(0, FRAME_SAMPLES)
}
