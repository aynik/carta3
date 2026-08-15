/** Carta3 Audio Codec - Persistent joint-stereo state. */

import { SUBBAND_COUNT } from '../core/constants.js'

/**
 * Create neutral left/right energy measurements for all interleaved slots.
 *
 * @returns {{left: number, right: number}[]}
 */
function createEnergies() {
  return Array.from({ length: SUBBAND_COUNT }, () => ({ left: 0, right: 0 }))
}

/**
 * Copy left/right energy measurements without replacing destination records.
 *
 * @param {{left: number, right: number}[]} source
 * @param {{left: number, right: number}[]} destination
 */
function copyEnergies(source, destination) {
  for (let slot = 0; slot < SUBBAND_COUNT; slot++) {
    destination[slot].left = source[slot].left
    destination[slot].right = source[slot].right
  }
}

/** Transactionally copyable history for all interleaved stereo slots. */
export class JointStereoState {
  /** Allocate neutral joint-stereo history. */
  constructor() {
    this.ratioScaledSlotCount = 0
    this.absoluteModeHints = new Int32Array(SUBBAND_COUNT)
    this.slotModes = new Int32Array(SUBBAND_COUNT)
    this.previousOutputSelector = 0
    this.outputSelector = 0
    this.previousRatios = new Float32Array(SUBBAND_COUNT)
    this.transitionStartRatios = new Float32Array(SUBBAND_COUNT)
    this.selectedRatios = new Float32Array(SUBBAND_COUNT)
    this.energies = createEnergies()
    this.previousEnergies = createEnergies()
    this.secondPreviousEnergies = createEnergies()
  }

  /**
   * Copy this history without replacing destination-owned storage.
   *
   * @param {JointStereoState} destination Existing destination state.
   * @returns {JointStereoState} `destination` after the copy.
   */
  copyTo(destination) {
    destination.ratioScaledSlotCount = this.ratioScaledSlotCount
    destination.absoluteModeHints.set(this.absoluteModeHints)
    destination.slotModes.set(this.slotModes)
    destination.previousOutputSelector = this.previousOutputSelector
    destination.outputSelector = this.outputSelector
    destination.previousRatios.set(this.previousRatios)
    destination.transitionStartRatios.set(this.transitionStartRatios)
    destination.selectedRatios.set(this.selectedRatios)
    copyEnergies(this.energies, destination.energies)
    copyEnergies(this.previousEnergies, destination.previousEnergies)
    copyEnergies(
      this.secondPreviousEnergies,
      destination.secondPreviousEnergies
    )
    return destination
  }
}
