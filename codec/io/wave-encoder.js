/** Carta3 Audio Codec - Streaming WAVE timeline encoder. */

import { FRAME_SAMPLES, WAVE_DELAY_SAMPLES } from '../core/constants.js'
import { encode } from '../pipeline/encoder.js'
import { createWave } from './wave.js'

/**
 * Validate one equally sized planar stereo PCM chunk.
 *
 * @param {Float32Array[]} channels
 */
function validateChunk(channels) {
  if (
    !Array.isArray(channels) ||
    channels.length !== 2 ||
    !(channels[0] instanceof Float32Array) ||
    !(channels[1] instanceof Float32Array) ||
    channels[0].length !== channels[1].length
  ) {
    throw new RangeError(
      'ATRAC3 WAVE input must contain two equally sized Float32 channels'
    )
  }
}

/**
 * Allocate one zeroed 1024-sample planar stereo frame.
 *
 * @returns {Float32Array[]}
 */
function createStereoFrame() {
  return [new Float32Array(FRAME_SAMPLES), new Float32Array(FRAME_SAMPLES)]
}

/**
 * Adapt arbitrary planar PCM chunks to the canonical ATRAC3 WAVE encode
 * timeline. Samples use normalized Web Audio values from -1 through 1.
 */
export class WaveStreamingEncoder {
  /**
   * Create a timeline adapter around one persistent frame encoder.
   *
   * @param {object} [options] Maintained profile options.
   */
  constructor(options = {}) {
    this.encodeFrame = encode(options)
    this.alignmentFrame = createStereoFrame()
    this.pcmFrame = createStereoFrame()
    this.alignmentFill = 0
    this.pcmFill = 0
    this.sampleCount = 0
    this.alignmentPublished = false
    this.dropNextPcmFrame = true
    this.finalized = false
  }

  /**
   * Consume one equally sized planar PCM chunk and collect its encoded frames.
   *
   * @param {Float32Array[]} channels Two equal normalized PCM channels.
   * @returns {Uint8Array[]} Newly completed encoded frames.
   */
  write(channels) {
    return [...this.frames(channels)]
  }

  /**
   * Lazily consume one equally sized planar PCM chunk.
   *
   * @param {Float32Array[]} channels Two equal normalized PCM channels.
   * @returns {Generator<Uint8Array>} Newly completed encoded frames.
   */
  *frames(channels) {
    if (this.finalized)
      throw new Error('ATRAC3 WAVE encoder has already been finalized')
    validateChunk(channels)
    const inputLength = channels[0].length
    let inputOffset = 0

    if (!this.alignmentPublished) {
      const count = Math.min(
        inputLength,
        WAVE_DELAY_SAMPLES - this.alignmentFill
      )
      const destination =
        FRAME_SAMPLES - WAVE_DELAY_SAMPLES + this.alignmentFill
      for (let channel = 0; channel < 2; channel++) {
        this.alignmentFrame[channel].set(
          channels[channel].subarray(0, count),
          destination
        )
      }
      this.alignmentFill += count
      inputOffset += count
      this.sampleCount += count
      if (this.alignmentFill === WAVE_DELAY_SAMPLES) {
        yield this.encodeFrame(this.alignmentFrame)
        this.alignmentPublished = true
      }
    }

    while (inputOffset < inputLength) {
      const count = Math.min(
        inputLength - inputOffset,
        FRAME_SAMPLES - this.pcmFill
      )
      for (let channel = 0; channel < 2; channel++) {
        this.pcmFrame[channel].set(
          channels[channel].subarray(inputOffset, inputOffset + count),
          this.pcmFill
        )
      }
      this.pcmFill += count
      inputOffset += count
      this.sampleCount += count
      if (this.pcmFill === FRAME_SAMPLES) {
        const frame = this.encodeFrame(this.pcmFrame)
        if (this.dropNextPcmFrame) this.dropNextPcmFrame = false
        else yield frame
        for (const channel of this.pcmFrame) channel.fill(0)
        this.pcmFill = 0
      }
    }
  }

  /**
   * Flush a partial frame and three codec-delay drain frames exactly once.
   *
   * @returns {Uint8Array[]} Remaining encoded frames.
   */
  finish() {
    if (this.finalized) return []
    const output = []
    if (this.sampleCount === 0) {
      this.finalized = true
      return output
    }
    if (!this.alignmentPublished) {
      output.push(this.encodeFrame(this.alignmentFrame))
      this.alignmentPublished = true
    }
    if (this.pcmFill !== 0) {
      const frame = this.encodeFrame(this.pcmFrame)
      if (this.dropNextPcmFrame) this.dropNextPcmFrame = false
      else output.push(frame)
      this.pcmFill = 0
    }
    const silence = createStereoFrame()
    for (let frame = 0; frame < 3; frame++) {
      output.push(this.encodeFrame(silence))
    }
    this.finalized = true
    return output
  }
}

/**
 * Create a streaming encoder for arbitrary planar PCM chunk boundaries.
 *
 * @param {object} [options] Maintained profile options.
 * @returns {WaveStreamingEncoder} Persistent WAVE timeline adapter.
 */
export function createWaveStreamingEncoder(options) {
  return new WaveStreamingEncoder(options)
}

/**
 * Encode complete planar normalized PCM to ATRAC3 WAVE.
 *
 * @param {Float32Array[]} channels Two equal normalized PCM channels.
 * @param {object} [options] Maintained profile options.
 * @returns {Uint8Array} Complete ATRAC3 WAVE byte image.
 */
export function encodeWavePcm(channels, options = {}) {
  validateChunk(channels)
  const encoder = new WaveStreamingEncoder(options)
  const frames = encoder.write(channels)
  frames.push(...encoder.finish())
  return createWave(frames, {
    ...options,
    sampleCount: encoder.sampleCount,
  })
}
