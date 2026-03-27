import {
  AT3_DBA_GROUP_MASK_TABLE,
  AT3ENC_PROC_OFFSET_TABLE,
  AT3ENC_PROC_TABLE_0,
  AT3ENC_PROC_TABLE_1,
  AT3ENC_PROC_TABLE_2,
  AT3ENC_PROC_TABLE_3,
  AT3ENC_PROC_TABLE_4,
  AT3ENC_PROC_TABLE_5,
  AT3ENC_PROC_TABLE_6,
  AT3ENC_PROC_TABLE_7,
  AT3ENC_PROC_TABLE_8,
} from "./encode-tables.js";

/**
 * ATRAC3 non-tone quantization mode catalog.
 *
 * The rest of the proc pipeline talks about mode numbers; this file is the one
 * owner that translates those authored mode ids into coarse bit-model data,
 * selector skip thresholds, and the concrete Huffman tables used by payload
 * packing and tone-pass sidebands.
 */

/**
 * @typedef {object} Atrac3NontoneQuantMode
 * @property {number} bitsPerSpec Coarse bit model used during low-budget planning.
 * @property {number} skipBits Coarse rebate for coefficient groups below the mode threshold.
 * @property {Uint8Array | null} tableBytes Main packed codebook for the mode.
 * @property {Uint8Array | null} bandPackTable Codebook used by band payload packing.
 * @property {number} tableIndexMask Index mask applied to quantized codes.
 * @property {number} bandPackMask Index mask applied by the band packer.
 * @property {number} bandPackCoefficients Number of coefficients packed per emitted code.
 * @property {(Uint8Array | null)[]} tonePassTables Tone-pass codebooks for pass 0 and pass 1.
 * @property {number} classScale Class-floor multiplier used by payload fitting.
 * @property {number} step Group IDSF threshold step used by coarse bit estimation.
 */
function createNontoneQuantMode(
  bitsPerSpec,
  skipBits,
  tableBytes,
  maskIndex,
  classScale = 0,
  step = 0,
  {
    bandPackTable = tableBytes,
    tonePassTables = [bandPackTable, null],
    tableIndexMask = AT3_DBA_GROUP_MASK_TABLE[maskIndex] >>> 0,
    bandPackMask = tableIndexMask,
    bandPackCoefficients = 1,
  } = {}
) {
  return {
    bitsPerSpec,
    skipBits,
    tableBytes,
    bandPackTable,
    tableIndexMask,
    bandPackMask,
    bandPackCoefficients,
    tonePassTables,
    classScale,
    step,
  };
}

const AT3_NONTONE_QUANT_MODES = [
  createNontoneQuantMode(0x64, -1024, AT3ENC_PROC_TABLE_7, 5, 0, 0, {
    bandPackTable: null,
    tonePassTables: [null, null],
  }),
  createNontoneQuantMode(0x0f, 0x28, AT3ENC_PROC_TABLE_7, 5, 1, 3, {
    bandPackTable: AT3ENC_PROC_OFFSET_TABLE,
    bandPackMask: 0x3,
    bandPackCoefficients: 2,
    tonePassTables: [AT3ENC_PROC_OFFSET_TABLE, null],
  }),
  createNontoneQuantMode(0x14, 0x28, AT3ENC_PROC_TABLE_0, 0, 2, 5),
  createNontoneQuantMode(0x19, 0x3c, AT3ENC_PROC_TABLE_1, 1, 2, 7, {
    tonePassTables: [AT3ENC_PROC_TABLE_1, AT3ENC_PROC_TABLE_2],
  }),
  createNontoneQuantMode(0x1d, 0x4c, AT3ENC_PROC_TABLE_3, 2, 2, 9),
  createNontoneQuantMode(0x23, 0x3c, AT3ENC_PROC_TABLE_4, 3, 4, 12, {
    tonePassTables: [AT3ENC_PROC_TABLE_4, AT3ENC_PROC_TABLE_5],
  }),
  createNontoneQuantMode(0x2d, 0x3c, AT3ENC_PROC_TABLE_6, 4, 6, 15),
  createNontoneQuantMode(0x37, 0x64, AT3ENC_PROC_TABLE_7, 5, 6, 18, {
    tonePassTables: [AT3ENC_PROC_TABLE_7, AT3ENC_PROC_TABLE_8],
  }),
];

/** Returns one authored non-tone mode descriptor, or `null` for unknown modes. */
export function getNontoneQuantMode(mode) {
  return AT3_NONTONE_QUANT_MODES[mode] ?? null;
}

/** Clamps one caller-provided mode id onto the authored non-tone mode catalog. */
export function resolveNontoneQuantMode(mode) {
  return AT3_NONTONE_QUANT_MODES[mode < 1 ? 0 : mode > 7 ? 7 : mode];
}

/** Clamps one non-muted mode id onto the authored ATRAC3 mode range. */
export function clampMode(mode) {
  return mode < 1 ? 1 : mode > 7 ? 7 : mode;
}

/** Returns the class-floor scale used when a band falls to its lightest viable payload. */
export function at3ClassScaleByMode(mode) {
  return resolveNontoneQuantMode(mode).classScale | 0;
}
