/** Carta3 Audio Codec - Streaming WAVE timeline adapters. */

import {
  ENCODER_LEAD_SAMPLES,
  FRAME_SAMPLES,
  STREAM_PRIMING_SAMPLES,
} from '../core/constants.js'
import { decode } from '../pipeline/decoder.js'
import { encode } from '../pipeline/encoder.js'
import { createWave, parseWave } from './container.js'

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
 * Create the planar shape for a timeline interval with no visible samples.
 *
 * @returns {Float32Array[]}
 */
function emptyStereoChunk() {
  return [new Float32Array(0), new Float32Array(0)]
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
    this.primingFrame = createStereoFrame()
    this.pcmFrame = createStereoFrame()
    this.primingFill = 0
    this.pcmFill = 0
    this.sampleCount = 0
    this.primingPublished = false
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

    if (!this.primingPublished) {
      const count = Math.min(
        inputLength,
        ENCODER_LEAD_SAMPLES - this.primingFill
      )
      const destination =
        FRAME_SAMPLES - ENCODER_LEAD_SAMPLES + this.primingFill
      for (let channel = 0; channel < 2; channel++) {
        this.primingFrame[channel].set(
          channels[channel].subarray(0, count),
          destination
        )
      }
      this.primingFill += count
      inputOffset += count
      this.sampleCount += count
      if (this.primingFill === ENCODER_LEAD_SAMPLES) {
        yield this.encodeFrame(this.primingFrame)
        this.primingPublished = true
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
    if (!this.primingPublished) {
      output.push(this.encodeFrame(this.primingFrame))
      this.primingPublished = true
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
 * Apply WAVE alignment and codec-delay trimming while decoding one frame at a
 * time. Frame reconstruction remains owned by the decoder stage pipeline.
 */
export class WaveStreamingDecoder {
  /**
   * Create a frame decoder with WAVE alignment and sample-count trimming.
   *
   * @param {object} [options] Profile and fact-timeline options.
   */
  constructor(options = {}) {
    this.decodeFrame = decode(options)
    this.skipSamples = options.primingSampleCount ?? STREAM_PRIMING_SAMPLES
    this.sampleCount = options.sampleCount ?? Number.POSITIVE_INFINITY
    this.timelinePosition = 0
    this.emittedSamples = 0
    this.finalized = false
  }

  /**
   * Decode one frame and return samples visible on the WAVE timeline.
   *
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
   *
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
 * Create a streaming encoder for arbitrary planar PCM chunk boundaries.
 *
 * @param {object} [options] Maintained profile options.
 * @returns {WaveStreamingEncoder} Persistent WAVE timeline adapter.
 */
export function createWaveStreamingEncoder(options) {
  return new WaveStreamingEncoder(options)
}

/**
 * Create a streaming decoder that applies WAVE timeline trimming.
 *
 * @param {object} options Profile and fact-timeline options.
 * @returns {WaveStreamingDecoder} Persistent WAVE timeline adapter.
 */
export function createWaveStreamingDecoder(options) {
  return new WaveStreamingDecoder(options)
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
    primingSampleCount: STREAM_PRIMING_SAMPLES,
  })
}

/**
 * Decode a complete ATRAC3 WAVE byte image to planar normalized PCM.
 *
 * @param {Uint8Array} input Complete ATRAC3 WAVE byte image.
 * @returns {Float32Array[]} Two equal decoded PCM channels.
 */
export function decodeWavePcm(input) {
  const parsed = parseWave(input)
  const sampleCount =
    parsed.fact?.sampleCount ??
    Math.max(0, parsed.frameCount * FRAME_SAMPLES - STREAM_PRIMING_SAMPLES)
  const primingSampleCount =
    parsed.fact?.primingSampleCount ?? STREAM_PRIMING_SAMPLES
  const decoder = new WaveStreamingDecoder({
    bitrateKbps: parsed.profile.bitrateKbps,
    sampleCount,
    primingSampleCount,
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
