/** Carta3 directional stream-state publication. */

/**
 * Capture independent histories into detached frame work.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Independent capture.
 */
function beginIndependent(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.independentChannels
  const work = encoder.frame.analysisWork
  const blocks = encoder.frame.channelBlocks
  const previousGainRecords = histories.map((history) => history.gainRecords)
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      histories[channel].stageTo(work[channel])
      blocks[channel].reset()
    }
    frame.analysisWork = work
    frame.channelBlocks = blocks
    frame.previousGainRecords = previousGainRecords
    return frame
  }
}

/**
 * Capture layered histories into detached frame work.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Layered capture.
 */
function beginLayered(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.layeredHistories
  const work = encoder.frame.layeredWork
  const jointHistory = encoder.state.jointStereoHistory
  const jointWork = encoder.frame.jointStereoWork
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      histories[layer].stageTo(work[layer])
    }
    jointHistory.stageTo(jointWork)
    frame.layers = work
    frame.jointStereo = jointWork
    return frame
  }
}

/**
 * Publish independent histories after successful frame packing.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): Uint8Array} Independent publication.
 */
function commitIndependent(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.independentChannels
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      histories[channel].commitFrom(
        frame.analysisWork[channel],
        frame.channelBlocks[channel].gainRecords
      )
    }
    return frame.output.slice()
  }
}

/**
 * Publish layered histories after successful frame packing.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): Uint8Array} Layered publication.
 */
function commitLayered(context) {
  const encoder = context.bufferPool.encoder
  const histories = encoder.state.layeredHistories
  const jointHistory = encoder.state.jointStereoHistory
  return (frame) => {
    for (let layer = 0; layer < 2; layer++) {
      histories[layer].commitFrom(frame.layers[layer])
    }
    jointHistory.commitFrom(frame.jointStereo)
    return frame.output.slice()
  }
}

/**
 * Select encoder capture once for the configured stream.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Encoder capture.
 */
export function beginEncoderFrame(context) {
  return context.profile.bitrateKbps === 132
    ? beginIndependent(context)
    : beginLayered(context)
}

/**
 * Select encoder publication once for the configured stream.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): Uint8Array} Encoder publication.
 */
export function commitEncoderFrame(context) {
  return context.profile.bitrateKbps === 132
    ? commitIndependent(context)
    : commitLayered(context)
}

/**
 * Capture decoder history into detached frame work.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Decoder capture.
 */
export function beginDecoderFrame(context) {
  const decoder = context.bufferPool.decoder
  return (frame) => {
    decoder.state.stageTo(decoder.frame)
    return frame
  }
}

/**
 * Publish decoder history after successful synthesis.
 *
 * @param {DecoderContext} context Pipeline ownership context.
 * @returns {function(DecoderFrame): DecoderFrame} Decoder publication.
 */
export function commitDecoderFrame(context) {
  const decoder = context.bufferPool.decoder
  const joint = context.profile.bitrateKbps === 66
  return (frame) => {
    if (joint) decoder.frame.header.advanceFrom(frame.pendingJointHeader)
    decoder.state.commitFrom(decoder.frame)
    return frame
  }
}
