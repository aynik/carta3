/**
 * Carta3 Audio Codec - Quadrature-mirror filter kernels.
 *
 * Every encoder profile uses the same cascaded 48-tap analysis transform with
 * three independent delay lines. The low-rate decoder retains its native
 * synthesis realization until that transform is independently decomposed.
 */

import {
  ANALYSIS_WORK_FLOATS,
  BAND_PART_FLOATS,
  BAND_STRIDE_FLOATS,
  FRAME_SAMPLES,
  HIGH_HISTORY_OFFSET,
  LAYERED_QMF_ANALYSIS_SCALE,
  LAYERED_QMF_SYNTHESIS_CARRY_OFFSET,
  LAYERED_QMF_SYNTHESIS_CURSOR_OFFSET,
  LAYERED_QMF_SYNTHESIS_HISTORY_OFFSET,
  LAYERED_QMF_SYNTHESIS_LAST_TAP,
  LAYERED_QMF_SYNTHESIS_MIRROR_INDEX,
  LOW_HISTORY_OFFSET,
  QMF_ANALYSIS_DELAY_SAMPLES,
  QMF_ANALYSIS_HISTORY_FLOATS,
  QMF_HIGH_DELAY_OFFSET,
  QMF_LOW_DELAY_OFFSET,
  QMF_ROOT_DELAY_OFFSET,
  QMF_SYNTHESIS_HISTORY_FLOATS,
  ROOT_HISTORY_OFFSET,
  SUBBAND_COUNT,
} from '../core/constants.js'
import { SYNTHESIS_QMF_CURVE, TWO_PI } from '../core/tables.js'
import { analyzeQmf } from './qmf.js'

/**
 * Apply one reusable two-band QMF stage and publish its updated delay line.
 *
 * @param {Float32Array} input
 * @param {Float32Array} low
 * @param {Float32Array} high
 * @param {Float32Array} history
 * @param {object} scratch
 * @returns {void}
 */
function analyzeQmfPair(input, low, high, history, scratch) {
  const window = scratch.analysisWindows[input.length]
  if (!window) {
    throw new RangeError(
      `QMF analysis window for ${input.length} samples is required`
    )
  }
  window.set(history)
  window.set(input, history.length)
  scratch.outputBands[0] = low
  scratch.outputBands[1] = high
  analyzeQmf(window, scratch.outputBands)
  history.set(
    window.subarray(input.length, input.length + QMF_ANALYSIS_DELAY_SAMPLES)
  )
}

/**
 * Split one PCM frame through the common two-level four-band QMF cascade.
 *
 * @param {Float32Array} pcm One complete 1024-sample channel frame.
 * @param {Float32Array[]} bands Four caller-owned 256-sample band rows.
 * @param {Float32Array} rootHistory Root-stage delay line.
 * @param {Float32Array} lowHistory Low-branch delay line.
 * @param {Float32Array} highHistory High-branch delay line.
 * @param {object} scratch Operation-local QMF buffers.
 * @returns {void}
 */
function analyzeQmfCascade(
  pcm,
  bands,
  rootHistory,
  lowHistory,
  highHistory,
  scratch
) {
  analyzeQmfPair(pcm, scratch.firstLow, scratch.firstHigh, rootHistory, scratch)
  analyzeQmfPair(scratch.firstLow, bands[0], bands[1], lowHistory, scratch)
  analyzeQmfPair(scratch.firstHigh, bands[3], bands[2], highHistory, scratch)
}

/**
 * Locate a subband's oldest gain-analysis half in the 132 kbps work image.
 *
 * @param {number} subband Subband index from zero through three.
 * @returns {number} Float offset in the analysis work image.
 */
export function bandGainOffset(subband) {
  return subband * BAND_STRIDE_FLOATS
}

/**
 * Locate a subband's middle MDCT half in the 132 kbps work image.
 *
 * @param {number} subband Subband index from zero through three.
 * @returns {number} Float offset in the analysis work image.
 */
export function bandMdctOffset(subband) {
  return bandGainOffset(subband) + BAND_PART_FLOATS
}

/**
 * Locate a subband's newest QMF half in the 132 kbps work image.
 *
 * @param {number} subband Subband index from zero through three.
 * @returns {number} Float offset in the analysis work image.
 */
export function bandSplitOffset(subband) {
  return bandGainOffset(subband) + 2 * BAND_PART_FLOATS
}

/**
 * Advance one channel's three-deep history and analyze one PCM frame.
 *
 * @param {Float32Array} pcm One complete 1024-sample channel frame.
 * @param {Float32Array} analysisWork Frame-local 132 kbps analysis image.
 * @param {object} independentQmfScratch Operation-local QMF buffers.
 * @returns {Float32Array} `analysisWork` with its newest split slots populated.
 */
export function analyzeIndependentQmfChannel(
  pcm,
  analysisWork,
  independentQmfScratch
) {
  if (pcm.length < FRAME_SAMPLES) {
    throw new RangeError('ATRAC3 QMF analysis requires 1024 PCM samples')
  }
  if (analysisWork.length < ANALYSIS_WORK_FLOATS) {
    throw new RangeError('ATRAC3 QMF analysis work buffer is too short')
  }
  if (
    !independentQmfScratch ||
    independentQmfScratch.firstLow?.length < 512 ||
    independentQmfScratch.firstHigh?.length < 512 ||
    independentQmfScratch.analysisWindows?.[FRAME_SAMPLES]?.length <
      QMF_ANALYSIS_DELAY_SAMPLES + FRAME_SAMPLES ||
    independentQmfScratch.analysisWindows?.[FRAME_SAMPLES / 2]?.length <
      QMF_ANALYSIS_DELAY_SAMPLES + FRAME_SAMPLES / 2
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
    ROOT_HISTORY_OFFSET + QMF_ANALYSIS_DELAY_SAMPLES
  )
  const bands = independentQmfScratch.cascadeOutputs
  bands[0] = analysisWork.subarray(
    bandSplitOffset(0),
    bandSplitOffset(0) + BAND_PART_FLOATS
  )
  bands[1] = analysisWork.subarray(
    bandSplitOffset(1),
    bandSplitOffset(1) + BAND_PART_FLOATS
  )
  bands[2] = analysisWork.subarray(
    bandSplitOffset(2),
    bandSplitOffset(2) + BAND_PART_FLOATS
  )
  bands[3] = analysisWork.subarray(
    bandSplitOffset(3),
    bandSplitOffset(3) + BAND_PART_FLOATS
  )
  analyzeQmfCascade(
    pcm,
    bands,
    rootHistory,
    analysisWork.subarray(
      LOW_HISTORY_OFFSET,
      LOW_HISTORY_OFFSET + QMF_ANALYSIS_DELAY_SAMPLES
    ),
    analysisWork.subarray(
      HIGH_HISTORY_OFFSET,
      HIGH_HISTORY_OFFSET + QMF_ANALYSIS_DELAY_SAMPLES
    ),
    independentQmfScratch
  )

  return analysisWork
}

/**
 * Analyze one low-rate channel through the common four-band QMF cascade.
 *
 * @param {Float32Array} pcm One complete PCM frame.
 * @param {Float32Array} spectrum Destination for four interleaved bands.
 * @param {Float32Array} history Three consecutive 46-sample delay lines.
 * @param {object} qmfScratch Operation-local QMF buffers.
 * @returns {Float32Array} `spectrum` after analysis.
 */
export function analyzeLayeredQmfChannel(pcm, spectrum, history, qmfScratch) {
  if (
    pcm.length < FRAME_SAMPLES ||
    spectrum.length < FRAME_SAMPLES ||
    history.length < QMF_ANALYSIS_HISTORY_FLOATS ||
    !qmfScratch ||
    qmfScratch.layeredBands?.length < SUBBAND_COUNT
  ) {
    throw new RangeError('ATRAC3 layered QMF has invalid buffer geometry')
  }
  const bands = qmfScratch.layeredBands
  analyzeQmfCascade(
    pcm,
    bands,
    history.subarray(
      QMF_ROOT_DELAY_OFFSET,
      QMF_ROOT_DELAY_OFFSET + QMF_ANALYSIS_DELAY_SAMPLES
    ),
    history.subarray(
      QMF_LOW_DELAY_OFFSET,
      QMF_LOW_DELAY_OFFSET + QMF_ANALYSIS_DELAY_SAMPLES
    ),
    history.subarray(
      QMF_HIGH_DELAY_OFFSET,
      QMF_HIGH_DELAY_OFFSET + QMF_ANALYSIS_DELAY_SAMPLES
    ),
    qmfScratch
  )
  for (let sample = 0; sample < BAND_PART_FLOATS; sample++) {
    const destination = sample * SUBBAND_COUNT
    for (let band = 0; band < SUBBAND_COUNT; band++) {
      spectrum[destination + band] =
        bands[band][sample] * LAYERED_QMF_ANALYSIS_SCALE
    }
  }
  return spectrum
}

/**
 * Fold four interleaved decoded bands through the low-rate synthesis QMF.
 *
 * @param {object} channel Decoder channel state containing synthesis history.
 * @returns {Float32Array} One reconstructed PCM frame view.
 * @nativeUnchecked Buffers have the fixed geometry owned by the channel state.
 */
export function synthesizeQmfChannel(channel) {
  const work = channel.synthesisBuffer
  const twoPi = Number(TWO_PI)
  for (let frameOffset = 0; frameOffset < FRAME_SAMPLES; frameOffset += 4) {
    let evenDifference =
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS]) -
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 1])
    let evenSum =
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS]) +
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 1])
    let oddSum =
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 3]) +
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 2])
    work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS] =
      Math.fround(evenDifference)
    evenDifference +=
      Number(work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET]) * twoPi
    let oddDifference =
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 3]) -
      Number(work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 2])
    work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 3] = Math.fround(oddSum)
    work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 1] = Math.fround(evenSum)
    evenSum =
      evenSum * twoPi +
      Number(work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 1])
    oddSum =
      oddSum * twoPi +
      Number(work[frameOffset + LAYERED_QMF_SYNTHESIS_CARRY_OFFSET + 3])
    work[frameOffset + QMF_SYNTHESIS_HISTORY_FLOATS + 2] =
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
