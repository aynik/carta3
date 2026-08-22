/** Carta3 syntax-unpacking stage. */

import { unpackChannelSyntax } from './io/channel-decoder.js'
import { IndependentChannelHeader, JointStereoHeader } from './io/syntax.js'

/**
 * Reverse the second shared-layout region into decoder-facing order.
 *
 * @param {Uint8Array} source
 * @param {number} stepBytes
 * @param {number} previousBitPosition
 * @returns {number}
 */
function prepareJointStereoRegion(source, stepBytes, previousBitPosition) {
  let left = 0
  let right = stepBytes
  let carriedByte = 0
  while (right > left) {
    right--
    carriedByte = source[right]
    if (carriedByte !== 0xf8) break
  }
  const consumedBytes = (previousBitPosition + 7) >> 3
  const availableBytes = right - left + 1 - consumedBytes
  if (right <= left) return availableBytes
  while (right > left) {
    const leftValue = source[left]
    source[right] = leftValue
    right--
    source[left] = carriedByte
    left++
    if (right <= left) break
    carriedByte = source[right]
  }
  return availableBytes
}

/**
 * Read a validated wire header into fixed pending-header storage.
 *
 * @param {object} header
 * @param {object} pending
 * @returns {object}
 */
function readPendingJointHeader(header, pending) {
  for (let band = 3; band >= 0; band--) {
    let selector
    if (band === 0) selector = (header.first >> 2) & 3
    else if (band === 1) selector = header.first & 3
    else if (band === 2) selector = (header.second >> 6) & 3
    else selector = (header.second >> 4) & 3
    if (selector === 2) {
      throw new RangeError(`Invalid ATRAC3 joint selector in band ${band}`)
    }
    pending.gainScaleSelectors[band] = selector
  }
  pending.pairScaleIndex = (header.first >> 4) * 2
  pending.unitMode = header.unitMode
  return pending
}

/**
 * Parse both syntax regions and preflight shared selectors without mutation.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Unpacking stage.
 */
export function unpack(context) {
  const decoder = context.bufferPool.decoder
  const { jointStereoLayout: joint, stepBytes } = decoder.state.header
  return (frame) => {
    const padded = decoder.scratch.paddedFrame
    padded.fill(0)
    padded.set(frame.input)
    let channelOffset = 0
    let bitLimitBytes = stepBytes
    let bitPosition = 0
    let pendingJointHeader = null

    for (let channel = 0; channel < 2; channel++) {
      const swapped = joint && channel === 1
      let valid
      let unitMode
      let jointHeader = null
      if (swapped) {
        bitLimitBytes = prepareJointStereoRegion(padded, stepBytes, bitPosition)
        const header = JointStereoHeader.unpack(padded[0], padded[1])
        jointHeader = header
        valid = header.isValid
        unitMode = header.unitMode
        bitPosition = 16
      } else {
        const raw = padded[channelOffset]
        valid = IndependentChannelHeader.isValid(raw)
        unitMode = IndependentChannelHeader.unpack(raw).unitMode
        bitPosition = channelOffset * 8 + 8
      }
      if (!valid) {
        throw new RangeError(`Invalid ATRAC3 channel ${channel} header`)
      }
      bitPosition = unpackChannelSyntax(
        padded,
        bitPosition,
        unitMode,
        decoder.frame.decodedChannels[channel]
      )
      const bitLimit = bitLimitBytes * 8 + 16
      if (bitPosition > bitLimit) {
        throw new RangeError(`ATRAC3 channel ${channel} exceeds its bit limit`)
      }
      if (swapped) {
        pendingJointHeader = readPendingJointHeader(
          jointHeader,
          decoder.frame.pendingJointHeader
        )
      }
      channelOffset += stepBytes
      if (!joint) bitLimitBytes += stepBytes
    }

    frame.decodedChannels = decoder.frame.decodedChannels
    frame.pendingJointHeader = pendingJointHeader
    return frame
  }
}
