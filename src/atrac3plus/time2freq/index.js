/**
 * Time-domain to frequency-domain analysis for the ATRAC3plus encoder.
 *
 * This stable surface exposes the MDCT-stage entrypoints that bridge
 * signal-processing analysis into the channel-block allocator. Scratch
 * buffers, record helpers, and low-mode repair stay in `internal.js`.
 */
import { at5T2fLowModeMaximaAndOverflow } from "./lowmode.js";
import { at5T2fMdctOutputs } from "./mdct.js";

export { AT5_GAIN_SEGMENTS_MAX, AT5_T2F_BANDS_MAX, AT5_T2F_MAX_CHANNELS } from "./constants.js";
export { at5T2fMdctOutputs, at5T2fSelectWindow } from "./mdct.js";

/**
 * Runs the ATRAC3plus time-to-frequency stage for a frame slice.
 *
 * @param {Array<object>} prevBufs
 * @param {Array<object>} curBufs
 * @param {Array<Float32Array>} analysisRows
 * @param {Array<Float32Array>} quantizedSpectraByChannel
 * @param {Array<Float32Array>} bitallocSpectraByChannel
 * @param {number} channelCount
 * @param {number} bandCount
 * @param {number} [encodeMode=0]
 * @param {boolean} [applyLowModeGainAdjust=false]
 * @returns {{maxima: {maxPre: Float32Array, maxPost: Float32Array} | null}}
 */
export function at5Time2freqMdctStage(
  prevBufs,
  curBufs,
  analysisRows,
  quantizedSpectraByChannel,
  bitallocSpectraByChannel,
  channelCount,
  bandCount,
  encodeMode = 0,
  applyLowModeGainAdjust = false
) {
  const maxima = applyLowModeGainAdjust
    ? at5T2fLowModeMaximaAndOverflow(
        prevBufs,
        curBufs,
        analysisRows,
        channelCount | 0,
        bandCount | 0,
        null
      )
    : null;

  at5T2fMdctOutputs(
    prevBufs,
    curBufs,
    analysisRows,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
    channelCount | 0,
    bandCount | 0,
    encodeMode | 0
  );

  return {
    maxima,
  };
}
