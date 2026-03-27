import { bitsToFloat32 } from "./float32.js";
import {
  AT3_CHCONV_MODE_BALANCED,
  slotUsesTransitionWindow,
} from "./channel-conversion-analysis.js";
import { layerUsesAtrac3SwappedTailTransport } from "./profiles.js";
import {
  AT3ENC_POW2_SCALE_TABLE,
  AT3ENC_POW2_SCALE_TABLE_F32,
  AT3ENC_PROC_LARGE_LIMIT_A_BITS,
} from "./encode-tables.js";

const F32_MIN_NORMAL = 1.1754943508222875e-38; // 2^-126
const AT3ENC_BLOCKS = 4;
const AT3ENC_MAXMAG_BLOCKS = 32;
const AT3ENC_MAXMAG_TOTAL = AT3ENC_MAXMAG_BLOCKS * 4;
const AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS = 0x20;
const AT3ENC_TONE_HISTORY_WORDS = AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS * 2;
const AT3ENC_TONE_GAIN_GROUP_COUNT = 8;
const AT3ENC_TONE_GAIN_GROUP_SIZE = 4;
const AT3ENC_TONE_GAIN_NEUTRAL = 4;
const AT3ENC_TONE_GAIN_MAX_BUDGET = 4;
const AT3ENC_TONE_GAIN_TRAILING_SENTINEL = 7;
const AT3ENC_TONE_GAIN_TRAILING_FLOOR = 5;
const AT3ENC_TONE_ATTACK_HEADROOM_BASE = 0x83;
const AT3ENC_TONE_ATTACK_MAX_GAIN = 0x0f;
const AT3_TONE_MODE_WINDOW_TRANSITION = 5;
const AT3_TONE_MODE_WINDOW_BALANCED = -1;
const AT3_TONE_MODE_WINDOW_DOMINANT = 0;

const K_LIMIT = 46796791808;
const K_SQRT1_2 = 1.4142135381698608;
const K_MUL = 6.521296920031965e-15;
const K_1P85 = 1.850000023841858;
const K_1P6 = 1.600000023841858;
const K_1P25 = 1.25;
const K_HUGE = 7.667187e13;
const AT3ENC_TONE_GAIN_MAX_TRAILING_ENTRIES =
  AT3ENC_TONE_GAIN_TRAILING_SENTINEL - AT3ENC_TONE_GAIN_TRAILING_FLOOR;
const AT3ENC_TONE_ATTACK_THRESHOLD_BALANCED = K_1P6 * K_1P25;
const AT3ENC_TONE_ATTACK_THRESHOLD_DEFAULT = K_1P6;
const AT3ENC_LARGE_LIMIT_BITS = AT3ENC_PROC_LARGE_LIMIT_A_BITS[0];
const AT3ENC_LARGE_LIMIT = bitsToFloat32(AT3ENC_LARGE_LIMIT_BITS);

function f32UnbiasedExponent(value) {
  const x = Math.abs(value);
  if (x === 0) {
    return -127;
  }
  if (!Number.isFinite(x)) {
    return 128;
  }
  if (x < F32_MIN_NORMAL) {
    return -127;
  }

  let exponent = Math.floor(Math.log2(x));
  let power = 2 ** exponent;

  while (x < power) {
    exponent -= 1;
    power *= 0.5;
  }
  while (x >= power * 2) {
    exponent += 1;
    power *= 2;
  }

  return exponent;
}

function f32ExponentBits(value) {
  const x = Math.abs(value);
  if (x === 0) {
    return 0;
  }
  if (!Number.isFinite(x)) {
    return 0xff;
  }
  if (x < F32_MIN_NORMAL) {
    return 0;
  }
  return (f32UnbiasedExponent(x) + 127) & 0xff;
}

function buildUnitPeakWords(spectrum, out) {
  const spectrumU32 = new Uint32Array(spectrum.buffer, spectrum.byteOffset, spectrum.length);
  for (let block = 0; block < AT3ENC_MAXMAG_BLOCKS; block += 1) {
    const blockStart = block * AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS;

    for (let unit = 0; unit < AT3ENC_BLOCKS; unit += 1) {
      let blockPeakBits = 0;

      for (
        let slot = blockStart + unit;
        slot < blockStart + AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS;
        slot += AT3ENC_BLOCKS
      ) {
        const sampleBits = spectrumU32[slot] & 0x7fffffff;
        if (blockPeakBits < sampleBits) {
          blockPeakBits = sampleBits;
        }
      }

      out[unit * AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS + block] = blockPeakBits;
    }
  }
}

function prepareToneBlockPeakHistory(
  toneBlock,
  unitPeakWords,
  unit,
  peakTimeline,
  previousEdgePeaks
) {
  const previousEntryCount = toneBlock.entryCount;
  const previousMaxBits = toneBlock.maxBits;
  let historicalPeakBits = AT3ENC_LARGE_LIMIT_BITS;
  const unitPeakOffset = unit * AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS;
  const historicalPeaks = peakTimeline.subarray(0, AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS);
  const currentPeaks = peakTimeline.subarray(AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS);

  toneBlock.startIndex[AT3ENC_TONE_GAIN_TRAILING_SENTINEL] = AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS;

  // The first half keeps the previous frame's lane peaks. The second half is
  // overwritten with the current frame's lane peaks for lookahead decisions.
  for (let index = 0; index < AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS; index += 1) {
    const previousBits = toneBlock.scratchBits[index];
    historicalPeaks[index] = bitsToFloat32(previousBits);
    if (historicalPeakBits < previousBits) {
      historicalPeakBits = previousBits;
    }

    const currentBits = unitPeakWords[unitPeakOffset + index];
    currentPeaks[index] = bitsToFloat32(currentBits);
    toneBlock.scratchBits[index] = currentBits;
  }

  // The backward edge scan later walks starts 28, 24, ... 0. Those eight
  // edge checks need the carried tail peak plus the previous frame's first
  // seven group peaks; the last group peak becomes the next carried tail.
  previousEdgePeaks[0] = toneBlock.lastMax ?? 0;
  let nextTailPeak = 0;
  for (let group = 0; group < AT3ENC_TONE_GAIN_GROUP_COUNT; group += 1) {
    const groupBase = group * AT3ENC_TONE_GAIN_GROUP_SIZE;
    const groupPeak = Math.max(
      historicalPeaks[groupBase + 0],
      historicalPeaks[groupBase + 1],
      historicalPeaks[groupBase + 2],
      historicalPeaks[groupBase + 3]
    );
    if (group + 1 < AT3ENC_TONE_GAIN_GROUP_COUNT) {
      previousEdgePeaks[group + 1] = groupPeak;
    }
    nextTailPeak = groupPeak;
  }

  toneBlock.maxBits = historicalPeakBits;
  toneBlock.lastMax = nextTailPeak;
  return {
    previousEntryCount,
    previousMaxBits,
  };
}

/**
 * Plans the tone-gain envelope for one transform unit.
 *
 * The planner first reserves any strong trailing releases from the previous
 * frame, then spends the remaining gain budget on leading attacks in the
 * previous/current peak timeline, and finally applies the block-0 follower
 * fallback used by the legacy ATRAC3 matrix.
 */
function planToneGainEntries(
  blocks,
  toneBlock,
  peakTimeline,
  previousEdgePeaks,
  unit,
  usesSwappedTransport,
  modeWindow,
  previousEntryCount,
  previousMaxBits
) {
  const historicalPeaks = peakTimeline.subarray(0, AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS);
  const currentPeaks = peakTimeline.subarray(AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS);
  let referencePeak = toneBlock.lastMax ?? 0;
  const currentLookaheadRows =
    modeWindow > 0
      ? Math.max(0, AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS - modeWindow * AT3ENC_TONE_GAIN_GROUP_COUNT)
      : AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS;
  for (let index = 0; index < currentLookaheadRows; index += 1) {
    if (currentPeaks[index] > referencePeak) {
      referencePeak = currentPeaks[index];
    }
  }
  referencePeak = Math.max(referencePeak, AT3ENC_LARGE_LIMIT);

  // Phase 1: reserve trailing block edges first so later attacks can only
  // spend the budget that the tail leaves behind.
  let remainingBudget = AT3ENC_TONE_GAIN_MAX_BUDGET;
  let trailingThreshold = referencePeak * K_1P85;
  const trailingEntries = [];

  for (
    let group = AT3ENC_TONE_GAIN_GROUP_COUNT - 1;
    group >= 0 &&
    remainingBudget > 0 &&
    trailingEntries.length < AT3ENC_TONE_GAIN_MAX_TRAILING_ENTRIES;
    group -= 1
  ) {
    const edgePeak = previousEdgePeaks[group];
    if (edgePeak < referencePeak) {
      continue;
    }
    if (edgePeak <= K_LIMIT || edgePeak <= trailingThreshold) {
      referencePeak = edgePeak;
      trailingThreshold = referencePeak * K_1P85;
      continue;
    }

    let startIndex = group * AT3ENC_TONE_GAIN_GROUP_SIZE;
    if (
      group !== 0 &&
      historicalPeaks[startIndex] < trailingThreshold &&
      historicalPeaks[startIndex - 1] < trailingThreshold
    ) {
      startIndex -= historicalPeaks[startIndex - 2] >= trailingThreshold ? 1 : 2;
    }

    let gainDelta = f32UnbiasedExponent((edgePeak / referencePeak) * K_SQRT1_2);
    if (gainDelta > remainingBudget) {
      gainDelta = remainingBudget;
    }

    trailingEntries.unshift({ startIndex, gainDelta: -gainDelta });
    remainingBudget -= gainDelta;
    referencePeak = edgePeak;
    trailingThreshold = referencePeak * K_1P85;
  }

  // Phase 2: walk forward through the block and spend the leftover gain
  // budget on leading attacks that survive the tail reservation.
  const previousPeak = bitsToFloat32(previousMaxBits);
  let attackBudget =
    Math.min(
      AT3ENC_TONE_ATTACK_HEADROOM_BASE - f32ExponentBits(previousPeak * K_MUL * K_SQRT1_2),
      AT3ENC_TONE_ATTACK_MAX_GAIN
    ) - remainingBudget;
  const leadingEntries = [];
  if (attackBudget > 0) {
    const attackThresholdScale =
      modeWindow === AT3_TONE_MODE_WINDOW_BALANCED
        ? AT3ENC_TONE_ATTACK_THRESHOLD_BALANCED
        : AT3ENC_TONE_ATTACK_THRESHOLD_DEFAULT;
    let runningPeak = Math.max(previousPeak, peakTimeline[0]);
    const trailingStart = trailingEntries[0]?.startIndex ?? AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS;
    const leadingEntryLimit = AT3ENC_TONE_GAIN_TRAILING_SENTINEL - trailingEntries.length;

    for (let scan = 0; scan < trailingStart; scan += 1) {
      // The peak timeline is laid out as previous-frame rows followed by
      // current-frame rows, so this scan intentionally bridges slot 31 -> 32.
      const attackPeak = peakTimeline[scan + 1];
      if (attackPeak < runningPeak) {
        continue;
      }

      const peakBeforeAttack = runningPeak;
      runningPeak = attackPeak;
      if (attackPeak <= K_LIMIT || attackPeak <= peakBeforeAttack * attackThresholdScale) {
        continue;
      }

      let gainDelta = f32UnbiasedExponent((attackPeak / peakBeforeAttack) * K_SQRT1_2);
      const previousAttack = leadingEntries[leadingEntries.length - 1];
      if (previousAttack?.startIndex === scan - 1) {
        const previousDelta = previousAttack.gainDelta;
        if (gainDelta >= previousDelta) {
          leadingEntries.pop();
          attackBudget += previousDelta;
          gainDelta += previousDelta;
        }
      }

      if (gainDelta > attackBudget) {
        gainDelta = attackBudget;
      }
      attackBudget -= gainDelta;
      leadingEntries.push({ startIndex: scan, gainDelta });

      if (leadingEntries.length === leadingEntryLimit || attackBudget <= 0) {
        break;
      }
    }
  }

  // Phase 3: append the reserved tail entries and convert the stored deltas
  // into the absolute region gains consumed by the envelope pass.
  const plannedEntries = [...leadingEntries, ...trailingEntries];
  let nextRegionGain = AT3ENC_TONE_GAIN_NEUTRAL;
  for (let index = plannedEntries.length - 1; index >= 0; index -= 1) {
    nextRegionGain += plannedEntries[index].gainDelta;
    plannedEntries[index].gainIndex = nextRegionGain;
  }
  for (let index = 0; index < plannedEntries.length; index += 1) {
    toneBlock.startIndex[index] = plannedEntries[index].startIndex;
    toneBlock.gainIndex[index] = plannedEntries[index].gainIndex;
  }

  const plannedEntryCount = plannedEntries.length;
  const canBorrowFollowerToneShape =
    plannedEntryCount === 0 && unit === 0 && !usesSwappedTransport && previousEntryCount === 0;
  if (!canBorrowFollowerToneShape) {
    return plannedEntryCount;
  }

  const followerBlock = blocks[1];
  const followerCount = followerBlock.entryCount;
  if (followerCount === 0 || bitsToFloat32(toneBlock.maxBits) > K_HUGE) {
    return plannedEntryCount;
  }

  let minGain = AT3ENC_TONE_GAIN_NEUTRAL;
  let maxGain = AT3ENC_TONE_GAIN_NEUTRAL;
  for (let index = 0; index < followerCount; index += 1) {
    const gain = followerBlock.gainIndex[index];
    if (gain < minGain) {
      minGain = gain;
    }
    if (gain > maxGain) {
      maxGain = gain;
    }
  }
  if (maxGain - minGain <= 1) {
    return plannedEntryCount;
  }

  const checkCount = followerBlock.startIndex[0] + 1;
  for (let index = 0; index < checkCount; index += 1) {
    if (peakTimeline[index + 1] > K_HUGE) {
      return plannedEntryCount;
    }
  }

  toneBlock.startIndex[0] = followerBlock.startIndex[0];
  toneBlock.gainIndex[0] = 5;
  return 1;
}

function applyToneGainEnvelope(transformWork, toneBlock, unit, selectedEntryCount) {
  if (selectedEntryCount === 0) {
    return;
  }

  const rowBase = (rowIndex) => unit + rowIndex * AT3ENC_BLOCK_ENTRY_SCRATCH_WORDS;

  let currentGain = toneBlock.gainIndex[0];
  let steadyRowIndex = 0;

  for (let region = 0; region < selectedEntryCount; region += 1) {
    const transitionRowIndex = toneBlock.startIndex[region];
    const transitionRowBase = rowBase(transitionRowIndex);
    if (currentGain !== AT3ENC_TONE_GAIN_NEUTRAL) {
      const gainScale = AT3ENC_POW2_SCALE_TABLE_F32[currentGain] ?? 0;
      for (; steadyRowIndex < transitionRowIndex; steadyRowIndex += 1) {
        const steadyRowBase = rowBase(steadyRowIndex);
        for (let slot = 0; slot < AT3ENC_TONE_GAIN_GROUP_COUNT; slot += 1) {
          transformWork[steadyRowBase + slot * AT3ENC_BLOCKS] *= gainScale;
        }
      }
      transformWork[transitionRowBase] *= gainScale;
    } else {
      steadyRowIndex = transitionRowIndex;
    }

    // The first slot in the transition row stays at the current gain. The
    // remaining seven slots ramp toward the next region gain.
    const nextGain =
      region + 1 < selectedEntryCount ? toneBlock.gainIndex[region + 1] : AT3ENC_TONE_GAIN_NEUTRAL;
    for (let slot = 1; slot < AT3ENC_TONE_GAIN_GROUP_COUNT; slot += 1) {
      const steppedGain =
        currentGain * AT3ENC_TONE_GAIN_GROUP_COUNT + (nextGain - currentGain) * slot;
      const mantissa = AT3ENC_POW2_SCALE_TABLE[16 + (steppedGain & 7)] >>> 0;
      const scaleBits = (steppedGain * 0x100000 + mantissa) >>> 0;
      transformWork[transitionRowBase + slot * AT3ENC_BLOCKS] *= bitsToFloat32(scaleBits);
    }

    steadyRowIndex = transitionRowIndex + 1;
    currentGain = nextGain;
  }
}

/**
 * Rebuilds the per-block tone-gain envelopes that shape the ATRAC3 transform
 * work buffer before the FFT pass.
 */
export function rebuildAtrac3ToneGainEnvelopes(state, layer) {
  const toneState = layer.tones;
  const scratch = toneState?.scratch ?? null;
  let unitPeakWords = scratch?.unitPeakWords ?? null;
  let peakTimeline = scratch?.peakTimeline ?? null;
  let previousEdgePeaks = scratch?.previousEdgePeaks ?? null;

  if (!(unitPeakWords instanceof Uint32Array) || unitPeakWords.length !== AT3ENC_MAXMAG_TOTAL) {
    unitPeakWords = new Uint32Array(AT3ENC_MAXMAG_TOTAL);
  }
  if (
    !(peakTimeline instanceof Float32Array) ||
    peakTimeline.length !== AT3ENC_TONE_HISTORY_WORDS
  ) {
    peakTimeline = new Float32Array(AT3ENC_TONE_HISTORY_WORDS);
  }
  if (
    !(previousEdgePeaks instanceof Float32Array) ||
    previousEdgePeaks.length !== AT3ENC_TONE_GAIN_GROUP_COUNT
  ) {
    previousEdgePeaks = new Float32Array(AT3ENC_TONE_GAIN_GROUP_COUNT);
  }

  if (scratch && typeof scratch === "object") {
    scratch.unitPeakWords = unitPeakWords;
    scratch.peakTimeline = peakTimeline;
    scratch.previousEdgePeaks = previousEdgePeaks;
  } else if (toneState && typeof toneState === "object") {
    toneState.scratch = {
      unitPeakWords,
      peakTimeline,
      previousEdgePeaks,
    };
  }

  buildUnitPeakWords(layer.spectrum, unitPeakWords);
  const blocks = toneState.blocks;
  const usesSwappedTransport = layerUsesAtrac3SwappedTailTransport(layer);
  const transformWork = layer.workspace.transform;

  for (let unit = AT3ENC_BLOCKS - 1; unit >= 0; unit -= 1) {
    const toneBlock = blocks[unit];
    const { previousEntryCount, previousMaxBits } = prepareToneBlockPeakHistory(
      toneBlock,
      unitPeakWords,
      unit,
      peakTimeline,
      previousEdgePeaks
    );

    if (unit === 0) {
      toneState.previousBlock0EntryCount = previousEntryCount;
    }

    let modeWindow = unit;
    if (usesSwappedTransport) {
      const slotState = state.channelConversion.slots[unit];
      const previousMode = slotState.modeHint;
      const currentMode = slotState.mode;
      if (slotUsesTransitionWindow(slotState) || previousMode !== currentMode) {
        modeWindow = AT3_TONE_MODE_WINDOW_TRANSITION;
      } else {
        modeWindow =
          currentMode === AT3_CHCONV_MODE_BALANCED
            ? AT3_TONE_MODE_WINDOW_BALANCED
            : AT3_TONE_MODE_WINDOW_DOMINANT;
      }
    }

    const selectedEntryCount = planToneGainEntries(
      blocks,
      toneBlock,
      peakTimeline,
      previousEdgePeaks,
      unit,
      usesSwappedTransport,
      modeWindow,
      previousEntryCount,
      previousMaxBits
    );
    applyToneGainEnvelope(transformWork, toneBlock, unit, selectedEntryCount);

    toneBlock.entryCount = selectedEntryCount;
    toneBlock.gainIndex[selectedEntryCount] = AT3ENC_TONE_GAIN_NEUTRAL;
  }
}
