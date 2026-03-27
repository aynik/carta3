import { AT3_DBA_GROUP_BITCOUNT_TABLE, AT3_SFB_OFFSETS, AT3_SFB_WIDTHS } from "./encode-tables.js";
import { AT3ENC_PROC_BAND_COUNT } from "./proc-layout.js";
import {
  buildLowBudgetCorrectionTrail,
  LOW_BUDGET_SELECTOR_MAX,
} from "./proc-payload-correction.js";
import { at3ClassScaleByMode, resolveNontoneQuantMode } from "./proc-quant-modes.js";
import { at3BandScaleFromMode, magicFloatBits, tableBitlen } from "./proc-quant-scale.js";

/**
 * ATRAC3 measurable non-tone payload planning.
 *
 * This owner converts the post-tone low-budget band state into concrete
 * payload candidates: it measures packed bit costs against the corrected
 * low-budget band trail and produces one candidate plan per surviving band.
 */

const BAND_PRIORITY_INACTIVE = -1;
const LOW_BUDGET_PROMOTION_SCORE = 0xfa1;
const LOW_BUDGET_DEMOTION_SCORE = 300;
const LOW_BUDGET_MIN_BAND_HEADROOM_BITS = 0x10;
const LOW_BUDGET_CLASS_FLOOR_HEADER_BITS = 0x0c;

function countMode1GroupBits(spectrum, start, scale) {
  let groupBits = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    groupBits = (groupBits << 1) | (magicFloatBits(spectrum[start + offset], scale) & 1);
  }
  return AT3_DBA_GROUP_BITCOUNT_TABLE[groupBits] | 0;
}

/** Measures the packed non-tone payload cost for one band at a given mode and selector. */
export function countbitsNontoneSpecsGeneric(mode, scaleSel, count, spectrum, start) {
  const scale = at3BandScaleFromMode(mode, scaleSel);
  let bitSum = 6;

  if (mode === 1) {
    for (let offset = 0; offset < count; offset += 8) {
      const groupStart = start + offset;
      bitSum += countMode1GroupBits(spectrum, groupStart, scale);
      bitSum += countMode1GroupBits(spectrum, groupStart + 4, scale);
    }
    return bitSum;
  }

  const quantMode = resolveNontoneQuantMode(mode);
  const end = start + count;
  for (let index = start; index < end; index += 1) {
    bitSum += tableBitlen(
      quantMode.tableBytes,
      magicFloatBits(spectrum[index], scale) & quantMode.tableIndexMask
    );
  }

  return bitSum;
}
/**
 * @typedef {object} Atrac3LowBudgetBandPlan
 * @property {number} band Active band index.
 * @property {number} mode Non-tone coding mode after the correction trail.
 * @property {number} scaleSel Scale selector used for the packed payload.
 * @property {number} bandWidth Width of the band in coefficients.
 * @property {number} spectrumStart Spectrum offset of the band payload.
 * @property {number} bits Current packed payload size.
 * @property {number} modeFloorBits Bit cost where the mode falls to its class floor.
 * @property {number} priority Selector-derived commit priority.
 */

/**
 * Shared low-budget non-tone planning state handed from the proc-word
 * orchestrator into the correction and measurable planning stages.
 *
 * @typedef {object} Atrac3LowBudgetPayloadPlanInput
 * @property {Uint32Array} bandModes
 * @property {Uint32Array} bandSelectors
 * @property {Int32Array} bandMetrics
 * @property {Uint32Array} groupIdsf
 * @property {number} estimatedBits
 * @property {number} activeWidth
 * @property {number} mode7Width
 * @property {number} activeBands
 * @property {number} totalAvailable
 * @property {number} modeShift
 * @property {Float32Array} spectrum
 * @property {boolean} [captureDebug]
 */

/**
 * Rebuilds concrete payload candidates after the coarse correction pass.
 *
 * @param {Atrac3LowBudgetPayloadPlanInput} state
 */
export function planLowBudgetBandPayloads({
  bandModes,
  bandSelectors,
  bandMetrics,
  groupIdsf,
  estimatedBits,
  activeWidth,
  mode7Width,
  activeBands,
  totalAvailable,
  modeShift,
  spectrum,
  captureDebug = false,
}) {
  const { remaining10, bandBudgetTrail } = buildLowBudgetCorrectionTrail({
    bandModes,
    bandSelectors,
    bandMetrics,
    groupIdsf,
    estimatedBits,
    activeWidth,
    mode7Width,
    activeBands,
    totalAvailable,
    modeShift,
  });

  const bandModesAfterCorrection = captureDebug ? bandModes.slice() : null;
  const bandSelectorsAfterCorrection = captureDebug ? bandSelectors.slice() : null;
  let plannedBits = 0;
  const bandPlans = [];
  const bitCountSnapshot = captureDebug ? new Int32Array(34) : null;
  const prioritySnapshot = captureDebug
    ? new Int32Array(AT3ENC_PROC_BAND_COUNT).fill(BAND_PRIORITY_INACTIVE, 0, activeBands)
    : null;

  for (let band = 0; band < activeBands; band += 1) {
    let mode = bandModes[band];
    if (mode === 0) {
      continue;
    }

    const bandWidth = AT3_SFB_WIDTHS[band];
    const remainingBits = totalAvailable - plannedBits;
    if (remainingBits * 2 - LOW_BUDGET_MIN_BAND_HEADROOM_BITS < bandWidth) {
      bandModes[band] = 0;
      continue;
    }

    let scaleSel = bandSelectors[band];
    const correctionScore = bandBudgetTrail[band + 1] - plannedBits * 10;
    if (correctionScore >= LOW_BUDGET_PROMOTION_SCORE && mode < 7) {
      mode += 1;
    } else if (correctionScore < LOW_BUDGET_DEMOTION_SCORE && band !== 0) {
      if (mode > 1) {
        mode -= 1;
      } else if (scaleSel !== LOW_BUDGET_SELECTOR_MAX) {
        scaleSel += 1;
      }
    }
    bandModes[band] = mode;
    bandSelectors[band] = scaleSel;

    const spectrumStart = AT3_SFB_OFFSETS[band];
    const bits = countbitsNontoneSpecsGeneric(mode, scaleSel, bandWidth, spectrum, spectrumStart);
    if (bitCountSnapshot !== null) {
      bitCountSnapshot[band + 1] = bits;
    }

    const classFloorBits =
      bandWidth * at3ClassScaleByMode(mode) + LOW_BUDGET_CLASS_FLOOR_HEADER_BITS;
    if (bits * 2 === classFloorBits) {
      bandModes[band] = 0;
      continue;
    }

    const priority = scaleSel;
    plannedBits += bits;
    if (prioritySnapshot !== null) {
      prioritySnapshot[band] = priority;
    }
    bandPlans.push({
      band,
      mode,
      scaleSel,
      bandWidth,
      spectrumStart,
      bits,
      modeFloorBits: (bandWidth >> 1) * at3ClassScaleByMode(mode) + 6,
      priority,
    });
  }

  return {
    remaining10,
    bandBudgetTrail,
    bandModesAfterCorrection,
    bandSelectorsAfterCorrection,
    plannedBits,
    bandPlans,
    plannedActiveBands: bandPlans.length === 0 ? 1 : bandPlans[bandPlans.length - 1].band + 1,
    bitCountSnapshot,
    prioritySnapshot,
  };
}
