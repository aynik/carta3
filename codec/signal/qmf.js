/** Two-band quadrature-mirror analysis. */

import {
  QMF_ANALYSIS_MODULATION_SCALE as analysisModulationScale,
  QMF_ANALYSIS_START_SAMPLE as analysisStartSample,
  QMF_ANALYSIS_STEP_SAMPLES as analysisStepSamples,
  QMF_ANALYSIS_WINDOW_SAMPLES as analysisWindowSamples,
  QMF_BANDS as bandCount,
} from '../core/constants.js'
import { QMF_ANALYSIS_COEFFICIENTS as analysisCoefficients } from '../core/tables.js'

/**
 * Split one chronological sample window into two QMF subband rows.
 *
 * @param {Float32Array} input History followed by chronological input samples.
 * @param {Float32Array[]} outputBands Caller-owned chronological subband rows.
 * @returns {Float32Array[]} The completed subband rows.
 */
export function analyzeQmf(input, outputBands) {
  const lowBand = outputBands[0]
  const highBand = outputBands[1]
  const sampleCount = lowBand.length
  for (let sample = 0; sample < sampleCount; sample++) {
    const inputOffset = analysisStartSample + sample * analysisStepSamples
    let evenSum = 0
    let oddSum = 0
    for (let tap = analysisWindowSamples - 1; tap >= 0; tap -= bandCount * 2) {
      evenSum += input[inputOffset + tap] * analysisCoefficients[tap]
      evenSum +=
        input[inputOffset + tap - bandCount] *
        analysisCoefficients[tap - bandCount]
      oddSum += input[inputOffset + tap - 1] * analysisCoefficients[tap - 1]
      oddSum +=
        input[inputOffset + tap - bandCount - 1] *
        analysisCoefficients[tap - bandCount - 1]
    }
    lowBand[sample] = (evenSum + oddSum) * analysisModulationScale
    highBand[sample] = (evenSum - oddSum) * analysisModulationScale
  }
  return outputBands
}
