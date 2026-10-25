/** Two-band quadrature-mirror analysis. */

import {
  QMF_ANALYSIS_MODULATION_SCALE,
  QMF_ANALYSIS_START_SAMPLE,
  QMF_ANALYSIS_STEP_SAMPLES,
  QMF_ANALYSIS_WINDOW_SAMPLES,
  QMF_BANDS,
} from '../core/constants.js'
import { QMF_ANALYSIS_COEFFICIENTS } from '../core/tables.js'

/**
 * Split one chronological sample window into two QMF subband rows.
 *
 * @param {Float32Array} input History followed by chronological input samples.
 * @param {Float32Array[]} outputBands Caller-owned chronological subband rows.
 * @returns {Float32Array[]} The completed subband rows.
 * @nativeUnchecked Buffers have the fixed geometry owned by the channel state.
 */
export function analyzeQmf(input, outputBands) {
  const lowBand = outputBands[0]
  const highBand = outputBands[1]
  const sampleCount = lowBand.length
  for (let sample = 0; sample < sampleCount; sample++) {
    const inputOffset =
      QMF_ANALYSIS_START_SAMPLE + sample * QMF_ANALYSIS_STEP_SAMPLES
    let evenSum = 0
    let oddSum = 0
    for (
      let tap = QMF_ANALYSIS_WINDOW_SAMPLES - 1;
      tap >= 0;
      tap -= QMF_BANDS * 2
    ) {
      evenSum += input[inputOffset + tap] * QMF_ANALYSIS_COEFFICIENTS[tap]
      evenSum +=
        input[inputOffset + tap - QMF_BANDS] *
        QMF_ANALYSIS_COEFFICIENTS[tap - QMF_BANDS]
      oddSum +=
        input[inputOffset + tap - 1] * QMF_ANALYSIS_COEFFICIENTS[tap - 1]
      oddSum +=
        input[inputOffset + tap - QMF_BANDS - 1] *
        QMF_ANALYSIS_COEFFICIENTS[tap - QMF_BANDS - 1]
    }
    lowBand[sample] = (evenSum + oddSum) * QMF_ANALYSIS_MODULATION_SCALE
    highBand[sample] = (evenSum - oddSum) * QMF_ANALYSIS_MODULATION_SCALE
  }
  return outputBands
}
