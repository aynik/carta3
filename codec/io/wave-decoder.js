/** Carta3 Audio Codec - Streaming WAVE timeline decoder. */

import { FRAME_SAMPLES, WAVE_DELAY_SAMPLES } from '../core/constants.js'
import { decode } from '../pipeline/decoder.js'
import { parseWave } from './wave.js'

/** Create the planar shape for a timeline interval with no visible samples. */
function emptyStereoChunk() {
  return [new Float32Array(0), new Float32Array(0)]
}

/**
 * Apply WAVE alignment and codec-delay trimming while decoding one frame at a
 * time. Frame reconstruction remains owned by the decoder stage pipeline.
 */
export class WaveStreamingDecoder {
  /**
   * Create a frame decoder with WAVE alignment and sample-count trimming.
   * @param {object} [options] Profile and fact-timeline options.
   */
  constructor(options = {}) {
    this.decodeFrame = decode(options)
    this.skipSamples =
      (options.alignmentSampleCount ?? FRAME_SAMPLES) + WAVE_DELAY_SAMPLES
    this.sampleCount = options.sampleCount ?? Number.POSITIVE_INFINITY
    this.timelinePosition = 0
    this.emittedSamples = 0
    this.finalized = false
  }

  /**
   * Decode one frame and return samples visible on the WAVE timeline.
   * @param {Uint8Array} frame One complete encoded ATRAC3 frame.
   * @returns {Float32Array[]} Timeline-trimmed planar PCM chunk.
   */
  write(frame) {
    if (this.finalized)
      throw new Error('ATRAC3 WAVE decoder has already been finalized')
    const decoded = this.decodeFrame(frame)
    const start = Math.max(0, this.skipSamples - this.timelinePosition)
    const available = FRAME_SAMPLES - start
    const remaining = this.sampleCount - this.emittedSamples
    const count = Math.max(0, Math.min(available, remaining))
    this.timelinePosition += FRAME_SAMPLES
    if (count === 0) return emptyStereoChunk()
    this.emittedSamples += count
    return decoded.map((channel) => channel.slice(start, start + count))
  }

  /**
   * Finalize once and reject a truncated finite-length timeline.
   * @returns {void}
   */
  finish() {
    if (this.finalized) return
    this.finalized = true
    if (
      Number.isFinite(this.sampleCount) &&
      this.emittedSamples !== this.sampleCount
    ) {
      throw new RangeError(
        `Truncated ATRAC3 WAVE timeline: decoded ${this.emittedSamples} of ${this.sampleCount} samples`
      )
    }
  }
}

/**
 * Create a streaming decoder that applies WAVE timeline trimming.
 * @param {object} options Profile and fact-timeline options.
 * @returns {WaveStreamingDecoder} Persistent WAVE timeline adapter.
 */
export function createWaveStreamingDecoder(options) {
  return new WaveStreamingDecoder(options)
}

/**
 * Decode a complete ATRAC3 WAVE byte image to planar signed-sample PCM.
 * @param {Uint8Array} input Complete ATRAC3 WAVE byte image.
 * @returns {Float32Array[]} Two equal decoded PCM channels.
 */
export function decodeWavePcm(input) {
  const parsed = parseWave(input)
  const sampleCount =
    parsed.fact?.sampleCount ??
    Math.max(
      0,
      parsed.frameCount * FRAME_SAMPLES - FRAME_SAMPLES - WAVE_DELAY_SAMPLES
    )
  const alignmentSampleCount =
    parsed.fact?.alignmentSampleCount ?? FRAME_SAMPLES
  const decoder = new WaveStreamingDecoder({
    bitrateKbps: parsed.profile.bitrateKbps,
    sampleCount,
    alignmentSampleCount,
  })
  const output = [new Float32Array(sampleCount), new Float32Array(sampleCount)]
  let outputOffset = 0
  for (const frame of parsed.frames()) {
    const chunk = decoder.write(frame)
    for (let channel = 0; channel < 2; channel++) {
      output[channel].set(chunk[channel], outputOffset)
    }
    outputOffset += chunk[0].length
  }
  decoder.finish()
  return output
}
