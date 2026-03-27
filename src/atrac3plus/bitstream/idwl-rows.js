import { trimTailValue, trimTailValueCount } from "./idwl-shared.js";

function idwlRowBaseSlot(row) {
  return ((row | 0) * 4) | 0;
}

function idwlRowBandCount(scratch, row, col) {
  return scratch.bandCountBySlot[idwlRowBaseSlot(row) + (col | 0)] | 0;
}

function idwlRowSetBandCount(scratch, row, col, value) {
  scratch.bandCountBySlot[idwlRowBaseSlot(row) + (col | 0)] = value | 0;
}

function refreshIdwlRowMapIds(scratch, row) {
  const baseSlot = idwlRowBaseSlot(row);
  for (let col = 0; col <= 3; col += 1) {
    scratch.mappedGroupBySlot[baseSlot + col] = -1;
    for (let prev = 0; prev < col; prev += 1) {
      if (
        (scratch.bandCountBySlot[baseSlot + prev] | 0) ===
        (scratch.bandCountBySlot[baseSlot + col] | 0)
      ) {
        scratch.mappedGroupBySlot[baseSlot + col] = prev | 0;
        break;
      }
    }
  }
}

export function resetIdwlRowBandCounts(scratch, row, bandLimit) {
  const baseSlot = idwlRowBaseSlot(row);
  scratch.extraWordByIndex[row | 0] = 0;
  for (let col = 0; col <= 3; col += 1) {
    scratch.bandCountBySlot[baseSlot + col] = bandLimit | 0;
    scratch.mappedGroupBySlot[baseSlot + col] = -1;
  }
}

export function computeRowMetaAndBandCountsForRow(
  channelIndex,
  bandLimit,
  rowCoeffs,
  scratch,
  row
) {
  resetIdwlRowBandCounts(scratch, row, bandLimit);

  {
    let count = idwlRowBandCount(scratch, row, 1);
    count = trimTailValue(rowCoeffs, count, 0);
    idwlRowSetBandCount(scratch, row, 1, count);
  }

  if ((channelIndex | 0) === 0) {
    {
      let count = idwlRowBandCount(scratch, row, 2);
      count = trimTailValue(rowCoeffs, count, 1);
      idwlRowSetBandCount(scratch, row, 2, count);
    }

    {
      let count = idwlRowBandCount(scratch, row, 3);
      const trimmed = trimTailValueCount(rowCoeffs, count, 0);
      count = trimmed.count | 0;
      const removed = trimmed.removed | 0;

      idwlRowSetBandCount(scratch, row, 3, count);

      if (((removed - 1) | 0) > 3) {
        scratch.extraWordByIndex[row] = 0;
        idwlRowSetBandCount(scratch, row, 3, bandLimit);
      } else {
        scratch.extraWordByIndex[row] = removed | 0;
        count = idwlRowBandCount(scratch, row, 3);
        count = trimTailValue(rowCoeffs, count, 1);
        idwlRowSetBandCount(scratch, row, 3, count);
      }
    }
  } else {
    {
      let count = idwlRowBandCount(scratch, row, 2);
      let trimZeroes = 1;
      let count3 = 0;

      if (count > 0) {
        let lastVal = rowCoeffs[count - 1] | 0;
        if (lastVal <= 1 && lastVal >= 0) {
          for (;;) {
            count -= 1;
            idwlRowSetBandCount(scratch, row, 2, count);
            if (count <= 0) {
              break;
            }
            lastVal = rowCoeffs[count - 1] | 0;
            if (lastVal > 1) {
              break;
            }
            if (lastVal < 0) {
              if ((idwlRowBandCount(scratch, row, 3) | 0) > 0) {
                trimZeroes = 1;
              } else {
                count3 = idwlRowBandCount(scratch, row, 3);
                trimZeroes = 0;
              }
              break;
            }
          }
        }
      }

      if (trimZeroes) {
        count3 = idwlRowBandCount(scratch, row, 3);
        count3 = trimTailValue(rowCoeffs, count3, 0);
        idwlRowSetBandCount(scratch, row, 3, count3);
      }

      let onesRun = 0;
      if (count3 > 0 && (rowCoeffs[count3 - 1] | 0) === 1) {
        count3 -= 1;
        for (;;) {
          onesRun += 1;
          idwlRowSetBandCount(scratch, row, 3, count3);
          if (count3 <= 0) {
            break;
          }
          count3 -= 1;
          if ((rowCoeffs[count3] | 0) !== 1) {
            break;
          }
        }

        if (onesRun <= 2) {
          scratch.extraWordByIndex[row] = 0;
          idwlRowSetBandCount(scratch, row, 3, bandLimit);
        } else if (onesRun <= 6) {
          scratch.extraWordByIndex[row] = onesRun | 0;
        } else {
          scratch.extraWordByIndex[row] = 6;
          idwlRowSetBandCount(
            scratch,
            row,
            3,
            (idwlRowBandCount(scratch, row, 3) + (onesRun - 6)) | 0
          );
        }
      } else {
        scratch.extraWordByIndex[row] = 0;
        idwlRowSetBandCount(scratch, row, 3, bandLimit);
      }
    }
  }

  refreshIdwlRowMapIds(scratch, row);
}

export function refreshIdwlRowBandCountsForIndex(
  channelIndex,
  bandLimit,
  rowCoeffs,
  scratch,
  row,
  coeffIndex
) {
  const idx = coeffIndex | 0;

  let count = idwlRowBandCount(scratch, row, 1);
  if (idx >= ((count - 1) | 0) || count === (bandLimit | 0)) {
    count = trimTailValue(rowCoeffs, bandLimit, 0) | 0;
    idwlRowSetBandCount(scratch, row, 1, count);
  }

  count = idwlRowBandCount(scratch, row, 2);
  if (idx >= ((count - 1) | 0) || count === (bandLimit | 0)) {
    if ((channelIndex | 0) === 0) {
      count = trimTailValue(rowCoeffs, bandLimit, 1) | 0;
      idwlRowSetBandCount(scratch, row, 2, count);
    } else if ((bandLimit | 0) > 0) {
      count = bandLimit | 0;
      let lastVal = rowCoeffs[count - 1] | 0;
      if (lastVal <= 1 && lastVal >= 0) {
        let curCount = count | 0;
        do {
          curCount = (curCount - 1) | 0;
          idwlRowSetBandCount(scratch, row, 2, curCount);
          if (curCount <= 0) {
            break;
          }
          lastVal = rowCoeffs[curCount - 1] | 0;
        } while (lastVal <= 1 && lastVal >= 0);
      } else {
        idwlRowSetBandCount(scratch, row, 2, count);
      }
    } else {
      idwlRowSetBandCount(scratch, row, 2, count);
    }
  }

  count = idwlRowBandCount(scratch, row, 3);
  if (idx >= ((count - 1) | 0) || count === (bandLimit | 0)) {
    count = bandLimit | 0;
    idwlRowSetBandCount(scratch, row, 3, count);

    if ((channelIndex | 0) === 0) {
      const trimmed = trimTailValueCount(rowCoeffs, idwlRowBandCount(scratch, row, 3), 0);
      let removedZeroes = trimmed.removed | 0;
      count = trimmed.count | 0;
      idwlRowSetBandCount(scratch, row, 3, count);

      if (((removedZeroes - 1) | 0) > 3) {
        scratch.extraWordByIndex[row] = 0;
        idwlRowSetBandCount(scratch, row, 3, bandLimit);
      } else {
        scratch.extraWordByIndex[row] = removedZeroes | 0;
        count = trimTailValue(rowCoeffs, idwlRowBandCount(scratch, row, 3), 1) | 0;
        idwlRowSetBandCount(scratch, row, 3, count);
      }
    } else {
      count = trimTailValue(rowCoeffs, idwlRowBandCount(scratch, row, 3), 0) | 0;
      idwlRowSetBandCount(scratch, row, 3, count);

      let onesRun = 0;
      if (count > 0 && (rowCoeffs[count - 1] | 0) === 1) {
        count = (count - 1) | 0;
        for (;;) {
          onesRun = (onesRun + 1) | 0;
          idwlRowSetBandCount(scratch, row, 3, count);
          if (count <= 0) {
            break;
          }
          count = (count - 1) | 0;
          if ((rowCoeffs[count] | 0) !== 1) {
            break;
          }
        }

        if (onesRun <= 2) {
          scratch.extraWordByIndex[row] = 0;
          idwlRowSetBandCount(scratch, row, 3, bandLimit);
        } else if (onesRun <= 6) {
          scratch.extraWordByIndex[row] = onesRun | 0;
        } else {
          scratch.extraWordByIndex[row] = 6;
          idwlRowSetBandCount(
            scratch,
            row,
            3,
            (idwlRowBandCount(scratch, row, 3) + (onesRun - 6)) | 0
          );
        }
      } else {
        scratch.extraWordByIndex[row] = 0;
        idwlRowSetBandCount(scratch, row, 3, bandLimit);
      }
    }
  }

  refreshIdwlRowMapIds(scratch, row);
}
