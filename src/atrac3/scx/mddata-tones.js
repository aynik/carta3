/**
 * ATRAC3 SCX mddata explicit tone detection and staging.
 */
import { CodecError } from "../../common/errors.js";
import { AT3_MULTITONE_BITS_TABLE } from "../encode-tables.js";
import { ensureNumericView, toInt, toIntChecked } from "./mddata-common.js";
import { extractToneSpecs, quantToneSpecs } from "./tone.js";
import { AT3_NBITS_ERROR, scaleFactorIndexForAbsValueAt3 } from "./tables.js";

const AT3_TONE_POOL_MAX_INDEX = 0x3f;
const AT3_TONES_PER_GROUP = 0x40;
const AT3_SINGLE_TONE_NEIGHBOR_SPLIT = AT3_TONES_PER_GROUP >> 1;
const AT3_TONE_ENTRY_LIST_LIMIT = 7;
const AT3_TONE_ENTRY_TWIDDLE_ID = 3;
const AT3_TONE_ENTRY_HUFF_TABLE_BASE_INDEX = 7;
const AT3_TONE_ENTRY_HUFF_TABLE_SET_INDEX = 1;
const AT3_ENTRY_HEADER_BITS = 6;
const AT3_ENTRY_GROUP_BITS = 12;
const AT3_MULTITONE_TABLE_REPEAT_COUNT = 4;
const AT3_MULTITONE_THRESHOLD_MARGIN = 32.0;
const AT3_SINGLE_TONE_CANDIDATE_COUNT = 0x100;
const AT3_SINGLE_TONE_GROUP_SHIFT = 6;
const AT3_SINGLE_TONE_GROUP_MASK = 0x3f;
const AT3_SINGLE_TONE_EXCLUSION_RADIUS = 2;
const AT3_SINGLE_TONE_MIN_BLOCKER_THRESHOLD = 0x9;
const AT3_SINGLE_TONE_BLOCKER_GAP = 0x11;
const AT3_SINGLE_TONE_MID_LEVEL = 0x14;
const AT3_SINGLE_TONE_HIGH_LEVEL = 0x23;

function ensureMddataChannel(channel) {
  if (!channel || typeof channel !== "object") {
    throw new CodecError("channel must be an object");
  }
  if (!Array.isArray(channel.mddataEntries)) {
    throw new CodecError("channel.mddataEntries must be an array");
  }
  if (!Array.isArray(channel.tonePool)) {
    throw new CodecError("channel.tonePool must be an array");
  }
  return channel;
}

export function singleToneCheck(scfofIds) {
  const candidates = ensureNumericView(scfofIds, "scfofIds");
  if (candidates.length < AT3_SINGLE_TONE_CANDIDATE_COUNT) {
    throw new CodecError("scfofIds must contain at least 256 entries");
  }

  let bestIdx = 0;
  let bestVal = toIntChecked(candidates[0] ?? 0, "scfofIds[0]");
  for (let index = 1; index < AT3_SINGLE_TONE_CANDIDATE_COUNT; index += 1) {
    const value = toIntChecked(candidates[index] ?? 0, `scfofIds[${index}]`);
    if (value > bestVal) {
      bestVal = value;
      bestIdx = index;
    }
  }

  const primaryGroup = bestIdx >> AT3_SINGLE_TONE_GROUP_SHIFT;
  const primaryCenter = bestIdx & AT3_SINGLE_TONE_GROUP_MASK;
  const mirroredGroup =
    primaryCenter >= AT3_SINGLE_TONE_NEIGHBOR_SPLIT ? primaryGroup + 1 : primaryGroup - 1;
  const mirroredCenter = AT3_SINGLE_TONE_GROUP_MASK - primaryCenter;
  let blockerPeak = 0;

  for (let index = 0; index < AT3_SINGLE_TONE_CANDIDATE_COUNT; index += 1) {
    const groupIndex = index >> AT3_SINGLE_TONE_GROUP_SHIFT;
    if (groupIndex === primaryGroup || groupIndex === mirroredGroup) {
      const excludedCenter = groupIndex === primaryGroup ? primaryCenter : mirroredCenter;
      if (
        Math.abs((index & AT3_SINGLE_TONE_GROUP_MASK) - excludedCenter) <=
        AT3_SINGLE_TONE_EXCLUSION_RADIUS
      ) {
        continue;
      }
    }

    const value = toIntChecked(candidates[index] ?? 0, `scfofIds[${index}]`);
    if (value > blockerPeak) {
      blockerPeak = value;
    }
  }

  if (
    blockerPeak >=
    Math.max(bestVal - AT3_SINGLE_TONE_BLOCKER_GAP, AT3_SINGLE_TONE_MIN_BLOCKER_THRESHOLD)
  ) {
    return 0;
  }

  if (bestVal > AT3_SINGLE_TONE_HIGH_LEVEL) {
    return 2;
  }
  return bestVal > AT3_SINGLE_TONE_MID_LEVEL ? 1 : 0;
}

function toneAbsMax4(specs, toneIndex) {
  const base = toneIndex * 4;
  return Math.max(
    Math.abs(Number(specs[base] ?? 0)),
    Math.abs(Number(specs[base + 1] ?? 0)),
    Math.abs(Number(specs[base + 2] ?? 0)),
    Math.abs(Number(specs[base + 3] ?? 0))
  );
}

function initializeMddataEntry(channel) {
  const entryIndex = toInt(channel.mddataEntryIndex);
  channel.mddataEntryIndex = entryIndex + 1;
  if (entryIndex < 0 || entryIndex >= channel.mddataEntries.length) {
    return null;
  }

  const entry = channel.mddataEntries[entryIndex];
  entry.huffTableBaseIndex = AT3_TONE_ENTRY_HUFF_TABLE_BASE_INDEX;
  entry.twiddleId = AT3_TONE_ENTRY_TWIDDLE_ID;
  entry.huffTableSetIndex = AT3_TONE_ENTRY_HUFF_TABLE_SET_INDEX;
  entry.groupFlags.fill(0);
  entry.listCounts.fill(0);
  return entry;
}

function stageQuantizedTone(entry, toneIndex, specView, channel, ctx) {
  const block = toneIndex >> 4;
  if ((entry.listCounts[block] | 0) >= AT3_TONE_ENTRY_LIST_LIMIT) {
    return null;
  }

  const tonePoolIndex = toInt(channel.toneCount);
  if (tonePoolIndex > AT3_TONE_POOL_MAX_INDEX) {
    return null;
  }

  const tone = channel.tonePool[tonePoolIndex];
  if (!tone || typeof tone !== "object") {
    return AT3_NBITS_ERROR;
  }

  tone.start = toneIndex * 4;
  tone.twiddleId = AT3_TONE_ENTRY_TWIDDLE_ID;
  tone.huffTableBaseIndex = AT3_TONE_ENTRY_HUFF_TABLE_BASE_INDEX;
  tone.huffTableSetIndex = AT3_TONE_ENTRY_HUFF_TABLE_SET_INDEX;
  return quantToneSpecs(specView, tone, ctx);
}

function commitStagedTone(entry, toneIndex, specView, channel) {
  const block = toneIndex >> 4;
  const listIndex = entry.listCounts[block] | 0;
  const tonePoolIndex = toInt(channel.toneCount);
  entry.lists[block][listIndex] = tonePoolIndex >>> 0;
  channel.toneCount = tonePoolIndex + 1;
  entry.listCounts[block] = listIndex + 1;
  return extractToneSpecs(channel.tonePool[tonePoolIndex], specView);
}

export function extractSingleTones(
  budget,
  count,
  span,
  idx,
  groups,
  maxIdx,
  specs,
  scfofIds,
  channel
) {
  const maxBudget = toIntChecked(budget, "budget");
  const entryCount = toIntChecked(count, "count");
  const searchSpan = toIntChecked(span, "span");
  const peakIdx = toIntChecked(idx, "idx");
  const groupCount = toIntChecked(groups, "groups");
  const maxIndex = toIntChecked(maxIdx, "maxIdx");
  const scalefactorIds = ensureNumericView(scfofIds, "scfofIds");
  const specView = ensureNumericView(specs, "specs");
  const ch = ensureMddataChannel(channel);
  const peakGroup = (peakIdx / AT3_TONES_PER_GROUP) | 0;
  const offset = peakIdx % AT3_TONES_PER_GROUP;
  const mirroredOffset = (AT3_TONES_PER_GROUP - 1 - offset) | 0;
  const mirroredGroup = offset < AT3_SINGLE_TONE_NEIGHBOR_SPLIT ? peakGroup - 1 : peakGroup + 1;
  const targetPlans = [
    [peakGroup, peakIdx],
    [mirroredGroup, mirroredGroup * AT3_TONES_PER_GROUP + mirroredOffset],
  ];

  let bits = (groupCount + AT3_ENTRY_HEADER_BITS) * entryCount;
  let skipFollowingEntryAfterOverflow = false;

  if (entryCount <= 0) {
    return bits;
  }

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const entry = initializeMddataEntry(ch);
    if (entry === null) {
      return AT3_NBITS_ERROR;
    }
    if (skipFollowingEntryAfterOverflow) {
      skipFollowingEntryAfterOverflow = false;
      continue;
    }

    for (const [targetGroup, targetBase] of targetPlans) {
      if (targetGroup < 0 || targetGroup >= groupCount) {
        continue;
      }

      let groupBits = bits;
      if ((entry.groupFlags[targetGroup] | 0) === 0) {
        groupBits = bits + AT3_ENTRY_GROUP_BITS;
        if (groupBits >= maxBudget) {
          continue;
        }
        entry.groupFlags[targetGroup] = 1;
      }

      bits = groupBits;
      skipFollowingEntryAfterOverflow = false;

      const targetStart = Math.max(targetBase - searchSpan, 0);
      const targetEnd = Math.min(targetBase + searchSpan, maxIndex - 1);
      for (let toneIndex = targetStart; toneIndex <= targetEnd; toneIndex += 1) {
        const addBits = stageQuantizedTone(entry, toneIndex, specView, ch, ch.globalState);
        if (addBits === null) {
          skipFollowingEntryAfterOverflow = false;
          continue;
        }
        if (addBits === AT3_NBITS_ERROR) {
          return AT3_NBITS_ERROR;
        }

        const candidateBits = bits + addBits;
        if (candidateBits > maxBudget) {
          skipFollowingEntryAfterOverflow = true;
          continue;
        }

        if (commitStagedTone(entry, toneIndex, specView, ch) < 0) {
          return AT3_NBITS_ERROR;
        }

        scalefactorIds[toneIndex] = scaleFactorIndexForAbsValueAt3(
          toneAbsMax4(specView, toneIndex)
        );
        bits = candidateBits;
        skipFollowingEntryAfterOverflow = false;
      }
    }
  }

  return bits | 0;
}

export function extractMultitone(
  budget,
  count,
  addBits,
  threshold,
  tonesAIds,
  tonesBIds,
  specs,
  channel,
  toneCtx
) {
  const maxBudget = toIntChecked(budget, "budget");
  const candidateCount = toIntChecked(count, "count");
  const entryAddBits = toIntChecked(addBits, "addBits");
  const thresholdValue = Number(threshold) + AT3_MULTITONE_THRESHOLD_MARGIN;
  const originalScalefactorIds = ensureNumericView(tonesAIds, "tonesAIds");
  const transformedScalefactorIds = ensureNumericView(tonesBIds, "tonesBIds");
  const specView = ensureNumericView(specs, "specs");
  const ch = ensureMddataChannel(channel);
  const ctx = toneCtx ?? ch.globalState;
  const multitoneTableBits = toIntChecked(
    AT3_MULTITONE_BITS_TABLE[
      AT3_TONE_ENTRY_HUFF_TABLE_BASE_INDEX + AT3_TONE_ENTRY_HUFF_TABLE_SET_INDEX * 8
    ] ?? 0,
    "AT3_MULTITONE_BITS_TABLE[15]"
  );
  const groupStopBits =
    multitoneTableBits * AT3_MULTITONE_TABLE_REPEAT_COUNT + AT3_ENTRY_GROUP_BITS;

  let bits = 0;
  let budgetExhausted = false;

  for (let pass = 0; pass < 2 && !budgetExhausted; pass += 1) {
    const baseToneCount = toIntChecked(ch.toneCount ?? 0, "channel.toneCount");
    const blockCounts = new Int32Array(16);
    let candidateCountThisPass = 0;
    let entry = null;

    for (let toneIndex = 0; toneIndex < candidateCount; toneIndex += 1) {
      const transformed = toIntChecked(
        transformedScalefactorIds[toneIndex] ?? 0,
        `transformedScalefactorIds[${toneIndex}]`
      );
      if (transformed <= thresholdValue) {
        continue;
      }

      const block = toneIndex >> 4;
      if ((blockCounts[block] | 0) >= AT3_TONE_ENTRY_LIST_LIMIT) {
        continue;
      }
      if (baseToneCount + candidateCountThisPass > AT3_TONE_POOL_MAX_INDEX) {
        continue;
      }

      blockCounts[block] += 1;
      candidateCountThisPass += 1;
      if (entry === null) {
        const entryBits = bits + entryAddBits + AT3_ENTRY_HEADER_BITS;
        if (entryBits > maxBudget) {
          budgetExhausted = true;
          break;
        }

        entry = initializeMddataEntry(ch);
        if (entry === null) {
          return AT3_NBITS_ERROR;
        }
        bits = entryBits;
      }

      let groupBits = bits;
      const group = toneIndex >> 6;
      if ((entry.groupFlags[group] | 0) === 0) {
        groupBits = bits + AT3_ENTRY_GROUP_BITS;
        if (groupBits > maxBudget) {
          budgetExhausted = true;
          break;
        }
        entry.groupFlags[group] = 1;
      }

      const addToneBits = stageQuantizedTone(entry, toneIndex, specView, ch, ctx);
      if (addToneBits === null) {
        continue;
      }
      if (addToneBits === AT3_NBITS_ERROR) {
        return AT3_NBITS_ERROR;
      }
      if (groupBits + groupStopBits > maxBudget) {
        bits = groupBits;
        budgetExhausted = true;
        break;
      }

      if (commitStagedTone(entry, toneIndex, specView, ch) < 0) {
        return AT3_NBITS_ERROR;
      }

      const scfof = scaleFactorIndexForAbsValueAt3(toneAbsMax4(specView, toneIndex));
      const previous = toIntChecked(
        originalScalefactorIds[toneIndex] ?? 0,
        `originalScalefactorIds[${toneIndex}]`
      );
      transformedScalefactorIds[toneIndex] = transformed + scfof - previous;
      originalScalefactorIds[toneIndex] = scfof;
      bits = groupBits + addToneBits;
    }
  }

  return bits | 0;
}
