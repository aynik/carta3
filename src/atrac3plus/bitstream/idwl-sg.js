import { AT5_SG_SHAPE_INDEX, AT5_WLC_SG_CB } from "../tables/unpack.js";

import { idwlBandCount, idwlBandLimit } from "./idwl-shared.js";
import {
  AT5_IDWL_WORK_GROUP_VALUES_OFFSET,
  AT5_IDWL_WORK_SG_EXTRA_OFFSET,
  copyIdwlWorkGroupSlot,
  idwlWorkGroupShapeCount,
  idwlWorkI32,
  idwlWorkLoadI32,
  idwlWorkSetGroupAvgBase,
  idwlWorkSetGroupBestShape,
  idwlWorkSetGroupShapeCount,
  idwlWorkSharedGroupAvgValuesView,
  idwlWorkSharedGroupShapeAdjustView,
  idwlWorkStoreI32,
  idwlWorkU8,
} from "./idwl-work.js";

function i32abs(v) {
  const x = v | 0;
  return x < 0 ? -x : x;
}

function asI8(v) {
  const x = v & 0xff;
  return x > 127 ? x - 256 : x;
}

function avg3Sum(a, b, c) {
  return (((a | 0) + (b | 0) + (c | 0) + 1) / 3) | 0;
}

function avg5Sum(a, b, c, d, e) {
  return (((a | 0) + (b | 0) + (c | 0) + (d | 0) + (e | 0) + 2) / 5) | 0;
}

function n2Under128(n) {
  const x = n | 0;
  return (x * x) | 0;
}

export function calcIdwlSgAt5(channel, scratch, flag, count) {
  const shared = channel?.shared;
  const bandCount = idwlBandCount(shared) | 0;
  const bandLimit = idwlBandLimit(shared) | 0;
  const coeff = channel?.idwl?.values;
  if (!(coeff instanceof Uint32Array) && !(coeff instanceof Int32Array)) {
    throw new TypeError("calcIdwlSgAt5: missing channel.idwl.values");
  }

  const workU8 = idwlWorkU8(scratch);
  const workI32 = idwlWorkI32(scratch);
  const avgVals = idwlWorkSharedGroupAvgValuesView(workU8);

  const doFull = (flag | 0) !== 0;
  if (doFull) {
    let coeffIdx = 0;
    for (let i = 0; i < bandCount; i += 1) {
      avgVals[i] = avg3Sum(coeff[coeffIdx] | 0, coeff[coeffIdx + 1] | 0, coeff[coeffIdx + 2] | 0);
      coeffIdx += 3;
    }

    if (bandCount === 0x0a) {
      const extra = avg5Sum(
        coeff[27] | 0,
        coeff[28] | 0,
        coeff[29] | 0,
        coeff[30] | 0,
        coeff[31] | 0
      );
      idwlWorkStoreI32(workU8, AT5_IDWL_WORK_SG_EXTRA_OFFSET, extra);
    }

    const base = avgVals[0] | 0;
    for (let i = 1; i < bandCount; i += 1) {
      avgVals[i] = (base - (avgVals[i] | 0)) | 0;
    }
  } else {
    const groupIdx = ((count | 0) / 3) | 0;
    if (groupIdx === 0) {
      const newAvg = avg3Sum(coeff[0] | 0, coeff[1] | 0, coeff[2] | 0);
      if ((newAvg | 0) !== (avgVals[0] | 0)) {
        const delta = (newAvg - (avgVals[0] | 0)) | 0;
        for (let i = 1; i < bandCount; i += 1) {
          avgVals[i] = ((avgVals[i] | 0) + delta) | 0;
        }
        avgVals[0] = newAvg | 0;
      }
    } else if (groupIdx <= 8) {
      const coeffIdx = (groupIdx * 3) | 0;
      const newAvg = avg3Sum(coeff[coeffIdx] | 0, coeff[coeffIdx + 1] | 0, coeff[coeffIdx + 2] | 0);
      const delta = ((avgVals[0] | 0) - newAvg) | 0;
      if ((delta | 0) !== (avgVals[groupIdx] | 0)) {
        avgVals[groupIdx] = delta | 0;
      }
    } else {
      const newAvg = avg5Sum(
        coeff[27] | 0,
        coeff[28] | 0,
        coeff[29] | 0,
        coeff[30] | 0,
        coeff[31] | 0
      );
      const delta = ((avgVals[0] | 0) - newAvg) | 0;
      const extraOff = AT5_IDWL_WORK_SG_EXTRA_OFFSET;
      if ((idwlWorkLoadI32(workU8, extraOff) | 0) !== (delta | 0)) {
        idwlWorkStoreI32(workU8, extraOff, delta | 0);
      }
    }
  }

  const avgBase = avgVals[0] | 0;

  const workValsBaseIndex = (AT5_IDWL_WORK_GROUP_VALUES_OFFSET / 4) | 0;
  let offsetLow = 0;
  let offsetMid = 0;
  let offsetHigh = 0;

  for (let group = 0; group <= 3; group += 1) {
    const mapIdx = scratch.mappedGroupBySlot[group] | 0;
    let filled = 0;

    if (mapIdx >= 0) {
      copyIdwlWorkGroupSlot(workU8, group, mapIdx);
      filled = 1;
    }

    const sgCount = scratch.bandCountBySlot[group] | 0;
    let shapeCount = 0;

    if (!filled) {
      if (sgCount > 0) {
        shapeCount = ((AT5_SG_SHAPE_INDEX[(sgCount - 1) | 0] ?? 0) + 1) | 0;
      }
      idwlWorkSetGroupShapeCount(workU8, group, shapeCount);

      let reuseGroup = -1;
      for (let j = 0; j < group; j += 1) {
        const prevShape = idwlWorkGroupShapeCount(workU8, j) | 0;
        if ((prevShape | 0) === (shapeCount | 0)) {
          reuseGroup = j;
          break;
        }
      }

      if (reuseGroup >= 0) {
        copyIdwlWorkGroupSlot(workU8, group, reuseGroup);
        filled = 1;
      }
    }

    if (!filled) {
      idwlWorkSetGroupAvgBase(workU8, group, avgBase);

      let bestCost = 0;
      let bestShape = 0;
      const baseIndex = avgVals[0] | 0;

      if (shapeCount > 1) {
        const shapeTblBase = (baseIndex * 144) | 0;
        let cost = 0;
        for (let i = 1; i < shapeCount; i += 1) {
          const diff = (avgVals[i] | 0) - asI8(AT5_WLC_SG_CB[shapeTblBase + (i - 1)]);
          cost = (cost + n2Under128(i32abs(diff))) | 0;
        }
        bestCost = cost | 0;
        bestShape = 0;
      }

      for (let shape = 1, tblOff = 9; shape < 16; shape += 1, tblOff += 9) {
        let cost = 0;
        if (shapeCount > 1) {
          const shapeTblBase = ((baseIndex * 144) | 0) + tblOff;
          for (let i = 1; i < shapeCount; i += 1) {
            const diff = (avgVals[i] | 0) - asI8(AT5_WLC_SG_CB[shapeTblBase + (i - 1)]);
            cost = (cost + n2Under128(i32abs(diff))) | 0;
          }
        }
        if ((cost | 0) < (bestCost | 0)) {
          bestCost = cost | 0;
          bestShape = shape | 0;
        }
      }

      const shapeAdjust = idwlWorkSharedGroupShapeAdjustView(workU8);
      shapeAdjust[0] = avgBase | 0;

      const bestTblBase = ((baseIndex * 144) | 0) + ((bestShape * 9) | 0);
      for (let i = 1; i <= 9; i += 1) {
        shapeAdjust[i] = asI8(AT5_WLC_SG_CB[bestTblBase + (i - 1)]) | 0;
      }

      idwlWorkSetGroupBestShape(workU8, group, bestShape);

      const baseIdx = (workValsBaseIndex + offsetHigh) | 0;
      workI32[baseIdx + 0] = ((coeff[0] | 0) - avgBase) | 0;
      workI32[baseIdx + 1] = ((coeff[1] | 0) - avgBase) | 0;
      workI32[baseIdx + 2] = ((coeff[2] | 0) - avgBase) | 0;

      let coeffIdx = 3;
      for (let i = 1; i < bandCount; i += 1) {
        const delta = (avgBase - (shapeAdjust[i] | 0)) | 0;
        shapeAdjust[i] = delta | 0;

        const outIndex = (workValsBaseIndex + offsetHigh + coeffIdx) | 0;
        workI32[outIndex + 0] = ((coeff[coeffIdx + 0] | 0) - delta) | 0;
        workI32[outIndex + 1] = ((coeff[coeffIdx + 1] | 0) - delta) | 0;
        workI32[outIndex + 2] = ((coeff[coeffIdx + 2] | 0) - delta) | 0;
        coeffIdx += 3;
      }

      if (bandCount === 0x0a && 0x1b < bandLimit) {
        const extra = shapeAdjust[9] | 0;
        for (let i = 0x1b; i < bandLimit; i += 1) {
          workI32[(workValsBaseIndex + offsetMid + i) | 0] = ((coeff[i] | 0) - extra) | 0;
        }
      }

      for (let i = 0; i < bandLimit; i += 1) {
        const idx = (workValsBaseIndex + offsetLow + i) | 0;
        workI32[idx] = (workI32[idx] & 0x7) | 0;
      }
    }

    offsetHigh = (offsetHigh + 0x23) | 0;
    offsetMid = (offsetMid + 0x23) | 0;
    offsetLow = (offsetLow + 0x23) | 0;
  }
}
