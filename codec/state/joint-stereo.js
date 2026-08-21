/** Carta3 Audio Codec - Joint-stereo history and frame work. */

import { JOINT_STEREO_ALL_SLOTS, SUBBAND_COUNT } from '../core/constants.js'

/** Persistent cross-frame joint-stereo history. */
export class JointStereoHistory {
  /** Allocate neutral history with stable array identities. */
  constructor() {
    this.slotModes = new Int32Array(SUBBAND_COUNT)
    this.outputSelector = 0
    this.previousRatios = new Float32Array(SUBBAND_COUNT)
  }

  /**
   * Restore the profile-derived initial history for a layered stream.
   *
   * @param {boolean} jointStereo Whether the stream uses joint stereo.
   * @returns {JointStereoHistory} This initialized history.
   */
  reset(jointStereo) {
    this.slotModes.fill(jointStereo ? -3 : 0)
    this.outputSelector = jointStereo ? JOINT_STEREO_ALL_SLOTS : 0
    this.previousRatios.fill(jointStereo ? 1 : 0)
    return this
  }

  /**
   * Stage genuine history into reusable frame work.
   *
   * @param {JointStereoWork} destination Existing destination work.
   * @returns {JointStereoWork} `destination` after staging.
   */
  stageTo(destination) {
    destination.slotModes.set(this.slotModes)
    destination.previousOutputSelector = this.outputSelector
    destination.outputSelector = this.outputSelector
    destination.previousRatios.set(this.previousRatios)
    return destination
  }

  /**
   * Commit genuine histories from the selected frame plan.
   *
   * @param {JointStereoWork} source Completed frame work.
   * @returns {JointStereoHistory} This committed history.
   */
  commitFrom(source) {
    this.slotModes.set(source.slotModes)
    this.outputSelector = source.outputSelector
    this.previousRatios.set(source.previousRatios)
    return this
  }
}

/** Reusable current-frame joint-stereo configuration, history, and plan. */
export class JointStereoWork {
  /** Allocate neutral work with stable plan and history identities. */
  constructor() {
    this.ratioScaledSlotCount = 0
    this.absoluteModeHints = new Int32Array(SUBBAND_COUNT)
    this.slotModes = new Int32Array(SUBBAND_COUNT)
    this.previousOutputSelector = 0
    this.outputSelector = 0
    this.previousRatios = new Float32Array(SUBBAND_COUNT)
    this.transitionStartRatios = new Float32Array(SUBBAND_COUNT)
    this.selectedRatios = new Float32Array(SUBBAND_COUNT)
  }
}
