/** Carta3 byte-packing stage. */

import { packLayeredChannel } from './syntax/unit/writer/layered.js'
import { packSoundUnit } from './syntax/unit/writer/independent.js'

/**
 * Pack an independent frame after all decisions are final.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Independent packing.
 */
function packIndependent(context) {
  const { profile } = context
  const encoder = context.bufferPool.encoder
  const unitBytes = profile.bytesPerFrame / 2
  return (frame) => {
    const output = encoder.frame.packedBytes.subarray(0, profile.bytesPerFrame)
    output.fill(0)
    for (let channel = 0; channel < 2; channel++) {
      packSoundUnit(
        frame.channelBlocks[channel],
        frame.soundUnitBits[channel],
        output,
        channel * unitBytes
      )
    }
    frame.output = output
    return frame
  }
}

/**
 * Pack completed layers into their final independent or shared spans.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layer packing.
 */
export function packLayered(context) {
  const { profile } = context
  const encoder = context.bufferPool.encoder
  const stride = profile.bytesPerFrame / 2
  const joint = profile.bitrateKbps === 66
  return (frame) => {
    const output = encoder.frame.packedBytes.subarray(0, profile.bytesPerFrame)
    output.fill(0)
    const offsets = joint ? frame.layeredOffsets : [0, stride]
    for (let layer = 0; layer < 2; layer++) {
      const end = packLayeredChannel(
        frame.layers[layer],
        frame.layeredAllocationWork[layer],
        frame.layeredSymbols[layer],
        offsets[layer],
        output,
        {
          previousOutput: frame.jointStereo.previousOutputSelector,
          gainSelectors: frame.jointStereo.absoluteModeHints,
        }
      )
      const limit = joint
        ? layer === 0
          ? offsets[1] * 8
          : profile.bytesPerFrame * 8
        : (layer + 1) * stride * 8
      if (end > limit) {
        throw new RangeError(
          `ATRAC3 layer ${layer} exceeds its selected frame span`
        )
      }
    }
    if (joint) {
      output.subarray(offsets[1], profile.bytesPerFrame).reverse()
    }
    frame.output = output
    return frame
  }
}

/**
 * Select byte packing for the configured profile.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Packing stage.
 */
export function pack(context) {
  return context.profile.bitrateKbps === 132
    ? packIndependent(context)
    : packLayered(context)
}
