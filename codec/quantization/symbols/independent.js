/**
 * Publish selected sound-unit candidates as final syntax.
 *
 * @returns {Function} Quantization operation.
 */
export function promoteSymbols() {
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      frame.soundUnits[channel].copyTo(frame.channelBlocks[channel])
    }
    return frame
  }
}
