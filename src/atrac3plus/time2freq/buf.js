import { AT5_GAIN_SEGMENTS_MAX, AT5_T2F_BANDS_MAX } from "./constants.js";

/**
 * Gain-control record written by `setGaincAt5` and consumed by later stages.
 * Canonical camelCase fields only (no snake_case aliases).
 */
export function createAt5EncodeBufRecord() {
  return {
    entries: 0,
    locations: new Uint32Array(AT5_GAIN_SEGMENTS_MAX),
    levels: new Uint32Array(AT5_GAIN_SEGMENTS_MAX),
    tlevFlag: 0,

    attackTotal: 0,
    releaseTotal: 0,

    minAll: 0,
    minHi: 0,
    minTail: 0,
    gainBase: 0,

    attackPoints: 0,
    attackFirst: 0,
    releaseLast: 0,

    tlev: 0,

    histA: 0,
    histB: 0,

    // Gain-control seed/metrics used to make next-frame decisions.
    ampScaledMax: 0,
    attackSeedLimit: 0,
    // Carry a forced round-down into the next frame after GC tightens the attack seed.
    attackRoundDownCarry: 0,

    derivMaxAll: 0,
    derivMaxHi: 0,
    derivSeedLimit: 0,

    attackTotalB: 0,
    releaseTotalB: 0,

    ampSlotMaxSum: 0,
    derivSlotMaxSum: 0,
  };
}

export function createAt5EncodeBufBlock() {
  const records = Array.from({ length: AT5_T2F_BANDS_MAX }, () => createAt5EncodeBufRecord());

  for (const rec of records) {
    rec.minAll = 4.0;
    rec.ampScaledMax = 4.0;
    rec.attackSeedLimit = 4.0;
    rec.derivMaxAll = 4.0;
    rec.derivSeedLimit = 4.0;
    rec.ampSlotMaxSum = 128.0;
    rec.derivSlotMaxSum = 128.0;
    rec.attackRoundDownCarry = 0;
  }

  return {
    records,
    tlevFlagsCopy: new Uint32Array(AT5_T2F_BANDS_MAX),
    scaleFactorIndices: new Int32Array(32), // `buf_* + 0x9c8` in at3re
    bandScales: new Float32Array(32), // `buf_* + 0xa48` in at3re
  };
}
