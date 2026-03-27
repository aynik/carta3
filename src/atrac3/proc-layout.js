/**
 * ATRAC3 Algorithm-0 proc-word layout helpers.
 *
 * The encoder keeps one shared `Uint32Array` scratch buffer for the whole
 * low-budget planning path:
 * - words `0x000..0x01f`: non-tone band modes
 * - words `0x020..0x03f`: band selectors and selector-side tone claims
 * - words `0x040..0x14f`: active-band count, block count, and tone-region headers
 * - words `0x150..`: packed tone words
 *
 * Keeping the addressing helpers here lets `proc-low-budget.js`,
 * `proc-low-budget-tone.js`, `proc-words.js`, and `frame.js` talk about the
 * same scratch structure without each re-deriving the word math.
 */
export const AT3ENC_PROC_BAND_COUNT = 0x20;
export const AT3ENC_PROC_BAND_SELECTOR_BASE_WORD = 0x20;
export const AT3ENC_PROC_ACTIVE_BANDS_WORD = 0x40;
export const AT3ENC_PROC_UNIT_COUNT_WORD = 0x41;
export const AT3ENC_PROC_TONE_PASS_MODE_WORD = 0x42;
export const AT3ENC_PROC_TONE_REGION_COUNT_WORD = 0x43;
export const AT3ENC_PROC_TONE_REGION_WORD_STRIDE = 0x218 >>> 2;
export const AT3ENC_PROC_TONE_REGION_FLAGS_WORD = 0x44;
export const AT3ENC_PROC_TONE_REGION_MODE_WORD = 0x48;
export const AT3ENC_PROC_TONE_REGION_SYM_MAX_WORD = 0x49;
export const AT3ENC_PROC_TONE_ROWS_PER_UNIT = 4;
export const AT3ENC_PROC_TONE_REGION_ROW_WORD_STRIDE = 8;
export const AT3ENC_PROC_TONE_REGION_ROW_COUNT_WORD = 6;
export const AT3ENC_PROC_TONE_REGION_ROW_PTRS_WORD = 7;
export const AT3ENC_PROC_TONE_WORD_STRIDE = 6;
export const AT3ENC_PROC_TONE_POOL_BASE_WORD = 0x150;
export const AT3ENC_PROC_TONE_START_WORD = 4;
export const AT3ENC_PROC_TONE_SCALE_WORD = 5;

/**
 * ATRAC3 encode stages share one scratch word buffer. The first 0x20 words are
 * band modes, the next 0x20 are the matching scale selectors, and the header
 * words after that describe block count and optional tone regions.
 */
export function at3encProcBandSelectorWord(band) {
  return AT3ENC_PROC_BAND_SELECTOR_BASE_WORD + band;
}

/**
 * The leading 0x20 proc words are reused as the per-band mode slots once band
 * planning finishes.
 */
export function at3encProcBandModesView(procWords) {
  return procWords.subarray(0, AT3ENC_PROC_BAND_COUNT);
}

/**
 * The next 0x20 proc words hold the per-band scale selectors and tone gates.
 */
export function at3encProcBandSelectorsView(procWords) {
  return procWords.subarray(
    AT3ENC_PROC_BAND_SELECTOR_BASE_WORD,
    AT3ENC_PROC_BAND_SELECTOR_BASE_WORD + AT3ENC_PROC_BAND_COUNT
  );
}

/** Returns the first header word of one tone region inside the proc buffer. */
export function at3encProcToneRegionBaseWord(region) {
  return region * AT3ENC_PROC_TONE_REGION_WORD_STRIDE;
}

export function at3encProcToneRegionFlagWord(region, unit) {
  return at3encProcToneRegionBaseWord(region) + AT3ENC_PROC_TONE_REGION_FLAGS_WORD + unit;
}

export function at3encProcToneRegionModeWord(region) {
  return at3encProcToneRegionBaseWord(region) + AT3ENC_PROC_TONE_REGION_MODE_WORD;
}

export function at3encProcToneRegionSymMaxWord(region) {
  return at3encProcToneRegionBaseWord(region) + AT3ENC_PROC_TONE_REGION_SYM_MAX_WORD;
}

/**
 * Packs the per-unit activity bits stored in one tone-region header into the
 * bitstream order used by the ATRAC3 sideband.
 */
export function at3encReadToneRegionActiveUnitFlags(procWords, region, unitCount) {
  let activeUnitFlags = 0;

  for (let unit = 0; unit < unitCount; unit += 1) {
    activeUnitFlags =
      (activeUnitFlags << 1) | (procWords[at3encProcToneRegionFlagWord(region, unit)] & 0x1);
  }

  return activeUnitFlags;
}

/** Returns the first row-header word for one tone row in one tone region. */
export function at3encProcToneRegionRowBaseWord(region, row) {
  return (
    at3encProcToneRegionBaseWord(region) +
    AT3ENC_PROC_TONE_REGION_FLAGS_WORD +
    row * AT3ENC_PROC_TONE_REGION_ROW_WORD_STRIDE
  );
}

export function at3encProcToneRegionRowCountWord(region, row) {
  return at3encProcToneRegionRowBaseWord(region, row) + AT3ENC_PROC_TONE_REGION_ROW_COUNT_WORD;
}

export function at3encProcToneRegionRowPtrWord(region, row, entry) {
  return (
    at3encProcToneRegionRowBaseWord(region, row) + AT3ENC_PROC_TONE_REGION_ROW_PTRS_WORD + entry
  );
}

/**
 * Clears the tone-region header and row metadata while preserving the band
 * planning words and the tone pool itself.
 */
export function at3encClearToneRegionScratch(procWords) {
  procWords.fill(0, at3encProcToneRegionFlagWord(0, 0), AT3ENC_PROC_TONE_POOL_BASE_WORD);
}

/**
 * Appends one tone word pointer to a tone-region row and returns the slot that
 * was assigned.
 */
export function at3encAppendToneRegionRowTone(procWords, region, row, toneWord) {
  const rowCountWord = at3encProcToneRegionRowCountWord(region, row);
  const rowCount = procWords[rowCountWord] | 0;
  procWords[rowCountWord] = (rowCount + 1) >>> 0;
  procWords[at3encProcToneRegionRowPtrWord(region, row, rowCount)] = toneWord >>> 0;
  return rowCount;
}

/** Returns the first word of one packed tone record in the tone pool. */
export function at3encProcToneWord(index) {
  return AT3ENC_PROC_TONE_POOL_BASE_WORD + index * AT3ENC_PROC_TONE_WORD_STRIDE;
}
