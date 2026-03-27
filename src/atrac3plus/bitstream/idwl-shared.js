import { AT5_HC_WL, AT5_WLC_COEF } from "../tables/unpack.js";

export const AT5_IDWL_CONFIG_WL = 0;
export const AT5_IDWL_CONFIG_GROUP = 1;
export const AT5_IDWL_CONFIG_BAND_COUNT = 2;
export const AT5_IDWL_CONFIG_EXTRA_WORD = 3;
export const AT5_IDWL_CONFIG_ROW = 4;
export const AT5_IDWL_GROUP_COUNT = 4;

function hcCodes(desc) {
  const codes = desc?.codes;
  return codes instanceof Uint8Array ? codes : null;
}

export function idwlWlcCodes(wl) {
  return hcCodes(AT5_HC_WL[wl >>> 0]);
}

export function idwlEncodeMode(channel) {
  const state = channel?.blockState ?? null;
  return (state?.encodeMode ?? 0) | 0;
}

export function idwlBandLimit(shared) {
  return (shared?.bandLimit ?? shared?.codedBandLimit ?? 0) | 0;
}

export function idwlBandCount(shared) {
  return (shared?.bandCount ?? 0) | 0;
}

export function idwlWlcCoefRow(channelIndex, row) {
  const r = row | 0;
  if (r <= 0) {
    return null;
  }
  const baseRow = ((channelIndex >>> 0) * 3 + (r - 1)) >>> 0;
  const start = baseRow * 32;
  return AT5_WLC_COEF.subarray(start, start + 32);
}

export function trimTailValue(values, count, target) {
  let n = count | 0;
  const t = target | 0;
  while (n > 0 && (values[n - 1] | 0) === t) {
    n -= 1;
  }
  return n | 0;
}

export function trimTailValueCount(values, count, target) {
  let n = count | 0;
  const t = target | 0;
  let removed = 0;
  while (n > 0 && (values[n - 1] | 0) === t) {
    n -= 1;
    removed += 1;
  }
  return { count: n | 0, removed: removed | 0 };
}

function idwlRowGroupSlot(row, group) {
  return ((row | 0) * AT5_IDWL_GROUP_COUNT + (group | 0)) | 0;
}

export function idwlGroupHeaderAdjustedCost(rawCost, group, bandCount, bandLimit, channelIndex) {
  const cost = rawCost | 0;
  const groupIndex = group | 0;
  let adjusted = cost | 0;

  if (groupIndex !== 0) {
    adjusted = (adjusted + 5) | 0;
    if (groupIndex === 2 && (channelIndex | 0) === 1) {
      adjusted = (adjusted + ((bandLimit | 0) - (bandCount | 0))) | 0;
    }
    if (groupIndex === 3) {
      adjusted = (adjusted + 2) | 0;
    }
  }

  return adjusted | 0;
}

export function buildIdwlRowGroupPlans(
  scratch,
  row,
  bandLimit,
  channelIndex,
  buildUniquePlan,
  options = null
) {
  const sharedPlans = new Array(AT5_IDWL_GROUP_COUNT);
  const plans = new Array(AT5_IDWL_GROUP_COUNT);
  const rowIndex = row | 0;
  const adjustZeroCost = options?.adjustZeroCost ?? true;

  for (let group = 0; group < AT5_IDWL_GROUP_COUNT; group += 1) {
    const groupSlot = idwlRowGroupSlot(rowIndex, group);
    const bandCount = scratch.bandCountBySlot[groupSlot] | 0;
    const mappedGroup = scratch.mappedGroupBySlot[groupSlot] | 0;
    const sharedPlan =
      mappedGroup >= 0 ? sharedPlans[mappedGroup] : buildUniquePlan(group | 0, bandCount | 0);

    sharedPlans[group] = sharedPlan;
    plans[group] = {
      ...sharedPlan,
      group: group | 0,
      bandCount: bandCount | 0,
      adjustedCost:
        !adjustZeroCost && (sharedPlan.rawCost | 0) <= 0
          ? 0
          : idwlGroupHeaderAdjustedCost(
              sharedPlan.rawCost,
              group,
              bandCount,
              bandLimit,
              channelIndex
            ),
    };
  }

  return plans;
}

export function buildIdwlGroupPlans(scratch, bandLimit, channelIndex, buildUniquePlan) {
  return buildIdwlRowGroupPlans(scratch, 0, bandLimit, channelIndex, buildUniquePlan);
}

export function findCheapestIdwlGroupPlan(plans) {
  let bestPlan = plans[0] ?? null;
  let bestCost = bestPlan?.adjustedCost ?? 0;

  for (let group = 1; group < plans.length; group += 1) {
    const candidate = plans[group];
    const candidateCost = candidate?.adjustedCost ?? 0;
    if (candidateCost < bestCost) {
      bestPlan = candidate;
      bestCost = candidateCost;
    }
  }

  return bestPlan;
}

export function findCheapestPositiveIdwlGroupPlan(plans, maxCost = 0x4000) {
  let bestPlan = null;
  let bestCost = maxCost | 0;

  for (const plan of plans) {
    if ((plan?.rawCost | 0) <= 0) {
      continue;
    }

    const candidateCost = plan.adjustedCost | 0;
    if (candidateCost < bestCost) {
      bestPlan = plan;
      bestCost = candidateCost;
    }
  }

  return bestPlan;
}

/**
 * Select the mode-1/mode-3 row plan with the lowest positive adjusted cost.
 * When every candidate stays header-free, keep row 0/group 0 as the historical fallback.
 */
export function findCheapestPositiveIdwlRowPlan(rowPlans) {
  let bestPlan = rowPlans[0]?.[0] ?? null;
  let bestRow = 0;
  let bestCost = bestPlan?.adjustedCost ?? 0;

  for (let row = 0; row < rowPlans.length; row += 1) {
    const plans = rowPlans[row];
    if (!plans) {
      continue;
    }

    for (const plan of plans) {
      const candidateCost = plan.adjustedCost | 0;
      if (candidateCost > 0 && candidateCost < bestCost) {
        bestPlan = plan;
        bestRow = row | 0;
        bestCost = candidateCost;
      }
    }
  }

  return { row: bestRow | 0, plan: bestPlan };
}

export function idwlScratchConfigForSlot(scratch, slot) {
  switch (slot & 3) {
    case 1:
      return scratch?.slot1Config ?? null;
    case 2:
      return scratch?.slot2Config ?? null;
    case 3:
      return scratch?.slot3Config ?? null;
    default:
      return scratch?.slot0Config ?? null;
  }
}
