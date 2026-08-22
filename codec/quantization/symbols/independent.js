/** @import { AllocationFrame } from '../../allocation/stage.js' */
/** @import { SymbolFrame } from '../stage.js' */

/**
 * Publish selected sound-unit candidates as final syntax.
 *
 * @returns {function(AllocationFrame): SymbolFrame} Quantization operation.
 */
export function promoteSymbols() {
  return (frame) => {
    for (let channel = 0; channel < 2; channel++) {
      frame.soundUnits[channel].copyTo(frame.channelBlocks[channel])
    }
    return frame
  }
}
