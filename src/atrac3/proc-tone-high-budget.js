import { AT3_DBA_GROUP_MASK_TABLE, AT3_SFB_OFFSETS } from "./encode-tables.js";
import { groupIdsfEstimateFromMagKey, readSpectrumMaxKey } from "./proc-quant-scale.js";
import {
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_POOL_BASE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_TONE_SCALE_WORD,
  AT3ENC_PROC_TONE_WORD_STRIDE,
  AT3ENC_PROC_UNIT_COUNT_WORD,
  at3encAppendToneRegionRowTone,
  at3encClearToneRegionScratch,
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
  at3encProcToneRegionFlagWord,
  at3encProcToneRegionModeWord,
  at3encProcToneRegionRowCountWord,
  at3encProcToneRegionRowPtrWord,
  at3encProcToneRegionSymMaxWord,
} from "./proc-layout.js";
import {
  AT3_TONE_PASS_SPLIT_LAYOUT,
  AT3_TONE_REGION_COUNT_DUAL,
  quantizeToneWord,
  restoreToneContribution,
} from "./proc-tone-common.js";

const AT3_HIGH_BUDGET_PREFERRED_CLASS_IDSF = 0x1e;
const AT3_HIGH_BUDGET_ROW_CAPACITY = 7;
const AT3_HIGH_BUDGET_TONE_HEADER_BITS = [0x1c, 0x24];
const AT3_HIGH_BUDGET_TONE_MASKS = [
  AT3_DBA_GROUP_MASK_TABLE[3] >>> 0,
  AT3_DBA_GROUP_MASK_TABLE[5] >>> 0,
];
const AT3_HIGH_BUDGET_DETECT_KEY = 0x80000000;
const AT3_HIGH_BUDGET_MAX_TONES = 0x40;
const AT3_HIGH_BUDGET_SCAN_STRIDE = 4;
const AT3_HIGH_BUDGET_PRESENCE_BITS = 0x0c;
const AT3_HIGH_BUDGET_HEADER_BUDGET_RESERVE = 200;
const AT3_HIGH_BUDGET_REGION_MODES = [5, 7];
const AT3_HIGH_BUDGET_REGION_SYMBOL_LIMITS = [3, 3];

function claimHighBudgetToneSlot(procWords, spectrum, group, idsfEst, tonePoolWord) {
  const preferredClass = idsfEst > AT3_HIGH_BUDGET_PREFERRED_CLASS_IDSF ? 1 : 0;
  const alternateClass = 1 - preferredClass;

  for (const toneClass of [preferredClass, alternateClass]) {
    const rowCount = procWords[at3encProcToneRegionRowCountWord(toneClass, group)] | 0;
    if (rowCount >= AT3_HIGH_BUDGET_ROW_CAPACITY) {
      continue;
    }

    at3encAppendToneRegionRowTone(procWords, toneClass, group, tonePoolWord);
    return {
      toneClass,
      toneWord: tonePoolWord,
      reusesExistingTone: false,
    };
  }

  const toneClass = preferredClass;
  const rowSlotsWord = at3encProcToneRegionRowPtrWord(toneClass, group, 0);
  const rowCountWord = at3encProcToneRegionRowCountWord(toneClass, group);
  const rowCount = procWords[rowCountWord] | 0;
  let weakestSlot = -1;
  let weakestIdsf = idsfEst;
  for (let slotIndex = 0; slotIndex < rowCount; slotIndex += 1) {
    const toneWord = procWords[rowSlotsWord + slotIndex] | 0;
    const toneIdsf = procWords[toneWord + AT3ENC_PROC_TONE_SCALE_WORD] | 0;
    if (toneIdsf < weakestIdsf) {
      weakestIdsf = toneIdsf;
      weakestSlot = slotIndex;
    }
  }
  if (weakestSlot < 0) {
    return null;
  }

  const toneWord = procWords[rowSlotsWord + weakestSlot] | 0;
  procWords.copyWithin(
    rowSlotsWord + weakestSlot,
    rowSlotsWord + weakestSlot + 1,
    rowSlotsWord + rowCount
  );
  procWords[rowSlotsWord + rowCount - 1] = toneWord >>> 0;
  restoreToneContribution(
    spectrum,
    procWords,
    toneWord,
    procWords[at3encProcToneRegionModeWord(toneClass)] | 0,
    procWords[at3encProcToneRegionSymMaxWord(toneClass)] | 0
  );

  return {
    toneClass,
    toneWord,
    reusesExistingTone: true,
  };
}

/**
 * Extracts the high-budget ATRAC3 tone side channel and refreshes the
 * non-tone band selectors after the tone energy is removed.
 */
export function extractHighBudgetTones(
  layer,
  procWords,
  bandLimit,
  availableBits,
  groupIdsf,
  bandWork
) {
  let headerBits = 0x16;
  let toneCount = 0;
  let tonePoolWord = AT3ENC_PROC_TONE_POOL_BASE_WORD;
  const toneHeaderBudget = availableBits - AT3_HIGH_BUDGET_HEADER_BUDGET_RESERVE;
  const blockCount = procWords[AT3ENC_PROC_UNIT_COUNT_WORD] | 0;
  const minBlocks = AT3_SFB_OFFSETS[bandLimit] >> 8;
  if (blockCount < minBlocks) {
    procWords[AT3ENC_PROC_UNIT_COUNT_WORD] = minBlocks >>> 0;
    headerBits += (minBlocks - blockCount) * 3;
  }

  at3encClearToneRegionScratch(procWords);
  for (let region = 0; region < AT3_TONE_REGION_COUNT_DUAL; region += 1) {
    procWords[at3encProcToneRegionModeWord(region)] = AT3_HIGH_BUDGET_REGION_MODES[region];
    procWords[at3encProcToneRegionSymMaxWord(region)] =
      AT3_HIGH_BUDGET_REGION_SYMBOL_LIMITS[region];
  }
  procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD] = AT3_TONE_PASS_SPLIT_LAYOUT;
  procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD] = AT3_TONE_REGION_COUNT_DUAL;

  const scanLimit = AT3_SFB_OFFSETS[bandLimit] | 0;
  const spectrum = layer.spectrum;
  const spectrumU32 = new Uint32Array(spectrum.buffer, spectrum.byteOffset, spectrum.length);

  if (scanLimit > 0) {
    let extractedOnPass = true;
    let exhaustedBudget = false;

    while (extractedOnPass && !exhaustedBudget) {
      extractedOnPass = false;

      for (let scan = 0; scan < scanLimit; ) {
        while (scan < scanLimit && (spectrumU32[scan] << 1) >>> 0 < AT3_HIGH_BUDGET_DETECT_KEY) {
          scan += 1;
        }
        if (scan >= scanLimit) {
          break;
        }

        const start = Math.min(scan, 0x3fc);
        const idsfEst = groupIdsfEstimateFromMagKey(readSpectrumMaxKey(spectrumU32, start)) | 0;
        const toneSlot = claimHighBudgetToneSlot(
          procWords,
          spectrum,
          scan >> 6,
          idsfEst,
          tonePoolWord
        );
        if (toneSlot === null) {
          scan += 1;
          continue;
        }

        const { toneClass, toneWord, reusesExistingTone } = toneSlot;
        const presenceWord = at3encProcToneRegionFlagWord(toneClass, scan >> 8);
        if ((procWords[presenceWord] | 0) === 0) {
          procWords[presenceWord] = 1;
          headerBits += AT3_HIGH_BUDGET_PRESENCE_BITS;
        }

        const toneBase = procWords[at3encProcToneRegionModeWord(toneClass)] | 0;
        if (
          quantizeToneWord(
            spectrum,
            spectrumU32,
            procWords,
            toneWord,
            start,
            toneBase,
            AT3_HIGH_BUDGET_TONE_MASKS[toneClass]
          ) < 0
        ) {
          scan += 1;
          continue;
        }

        if (!reusesExistingTone) {
          tonePoolWord += AT3ENC_PROC_TONE_WORD_STRIDE;
          toneCount += 1;
        }
        headerBits += AT3_HIGH_BUDGET_TONE_HEADER_BITS[toneClass];
        extractedOnPass = true;
        scan += AT3_HIGH_BUDGET_SCAN_STRIDE;
        if (toneCount >= AT3_HIGH_BUDGET_MAX_TONES || headerBits > toneHeaderBudget) {
          exhaustedBudget = true;
          break;
        }
      }
    }
  }

  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);
  for (let band = 0; band < bandLimit; band += 1) {
    const groupStart = AT3_SFB_OFFSETS[band] >> 2;
    const groupEnd = AT3_SFB_OFFSETS[band + 1] >> 2;
    let peak = 0;

    for (let group = groupStart; group < groupEnd; group += 1) {
      const idsf = groupIdsfEstimateFromMagKey(readSpectrumMaxKey(spectrumU32, group * 4));
      groupIdsf[group] = idsf;
      if (peak < idsf) {
        peak = idsf;
      }
    }

    bandSelectors[band] = peak >>> 0;
    bandModes[band] = peak === 0 ? 0 : 1;
    bandWork[band + 1] = (peak * 0x155) | 0;
  }
  return availableBits - headerBits;
}
