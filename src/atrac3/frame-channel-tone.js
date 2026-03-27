import {
  AT3ENC_PROC_TONE_PASS_MODE_WORD,
  AT3ENC_PROC_TONE_REGION_COUNT_WORD,
  AT3ENC_PROC_TONE_ROWS_PER_UNIT,
  AT3ENC_PROC_TONE_SCALE_WORD,
  AT3ENC_PROC_TONE_START_WORD,
  at3encProcToneRegionModeWord,
  at3encProcToneRegionRowCountWord,
  at3encProcToneRegionRowPtrWord,
  at3encProcToneRegionSymMaxWord,
  at3encReadToneRegionActiveUnitFlags,
} from "./proc-layout.js";
import { getNontoneQuantMode } from "./proc-quant-modes.js";
import { at3encPackBitsU16, at3encPackTableU16 } from "./frame-channel-pack.js";

/**
 * Writes the ATRAC3 tone-region sideband after the gain-pair prelude and
 * before the non-tone spectral payload.
 */
export function writeAtrac3ToneRegionSideband(procWords, unitCount, out, bitpos) {
  const toneRegionCount = procWords[AT3ENC_PROC_TONE_REGION_COUNT_WORD];
  bitpos = at3encPackBitsU16(out, bitpos, toneRegionCount, 5);
  if (toneRegionCount === 0) {
    return bitpos;
  }

  const tonePassMode = procWords[AT3ENC_PROC_TONE_PASS_MODE_WORD];
  const toneWordLimit = procWords.length - (AT3ENC_PROC_TONE_SCALE_WORD + 1);
  bitpos = at3encPackBitsU16(out, bitpos, tonePassMode, 2);

  for (let region = 0; region < toneRegionCount; region += 1) {
    const activeUnitFlags = at3encReadToneRegionActiveUnitFlags(procWords, region, unitCount);
    bitpos = at3encPackBitsU16(out, bitpos, activeUnitFlags, unitCount);

    const toneRegionMode = procWords[at3encProcToneRegionModeWord(region)];
    const symMax = procWords[at3encProcToneRegionSymMaxWord(region)];
    bitpos = at3encPackBitsU16(out, bitpos, toneRegionMode | (symMax << 3), 6);

    const tonePassTable = getNontoneQuantMode(toneRegionMode)?.tonePassTables[tonePassMode] ?? null;
    if (tonePassTable === null) {
      continue;
    }

    // Each active transform unit contributes four tone rows to the region
    // sideband in block order.
    for (
      let unit = 0, unitMask = 1 << (unitCount - 1);
      unit < unitCount;
      unit += 1, unitMask >>>= 1
    ) {
      if ((activeUnitFlags & unitMask) === 0) {
        continue;
      }

      const rowStart = unit * AT3ENC_PROC_TONE_ROWS_PER_UNIT;
      const rowEnd = rowStart + AT3ENC_PROC_TONE_ROWS_PER_UNIT;
      for (let row = rowStart; row < rowEnd; row += 1) {
        const entryCount = procWords[at3encProcToneRegionRowCountWord(region, row)];
        bitpos = at3encPackBitsU16(out, bitpos, entryCount, 3);

        for (let entry = 0; entry < entryCount; entry += 1) {
          const toneWord = procWords[at3encProcToneRegionRowPtrWord(region, row, entry)];
          if (toneWord === 0 || toneWord > toneWordLimit) {
            continue;
          }

          bitpos = at3encPackBitsU16(
            out,
            bitpos,
            procWords[toneWord + AT3ENC_PROC_TONE_SCALE_WORD],
            6
          );
          bitpos = at3encPackBitsU16(
            out,
            bitpos,
            procWords[toneWord + AT3ENC_PROC_TONE_START_WORD] & 0x3f,
            6
          );

          for (let symbol = 0; symbol <= symMax; symbol += 1) {
            bitpos = at3encPackTableU16(out, bitpos, tonePassTable, procWords[toneWord + symbol]);
          }
        }
      }
    }
  }

  return bitpos;
}
