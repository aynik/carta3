/**
 * Low-mode gain-record shaping for ATRAC3plus time2freq analysis.
 *
 * This file owns three tightly-coupled behaviors that used to live behind a
 * barrel-only split: stereo record sharing, record repair across adjacent
 * bands, and post-window peak/overflow control.
 */
import { AT5_TIME2FREQ_WEIGHT_TABLE } from "../tables/encode-init.js";
import {
  at5SigprocCorrHistoryViews,
  at5SigprocIntensityBandView,
  at5SigprocTime2freqBandFlagsView,
} from "../sigproc/aux.js";
import { AT5_GAIN_SEGMENTS_MAX, AT5_T2F_BANDS_MAX, AT5_T2F_MAX_CHANNELS } from "./constants.js";
import { K0P6, K8, K20, K30, K32768, K40 } from "./fp.js";
import {
  at5GainRecordCopy,
  bandCopyTarget,
  at5GainRecordDecrementIndex,
  at5GainRecordEqual,
  at5GainRecordMetric,
  at5GainRecordNormalize,
  recordEntries,
  recordLevels,
  recordLocations,
} from "./record.js";
import {
  applyGainWindowToTimeSamples,
  blockShared,
  ensureTime2freqGainWindowScratch,
  time2freqScratch,
} from "./runtime.js";

const AT5_T2F_TIME_SAMPLES = 256;

const AT5_LOW_MODE_RECORD_MERGE_DELTA = 1;
const AT5_LOW_MODE_MAXIMA_MATCH_LOW = 0.949999988079071;
const AT5_LOW_MODE_MAXIMA_MATCH_HIGH = 1.0499999523162842;
const AT5_LOW_MODE_OVERFLOW_LIMIT = 65536;
const AT5_LOW_MODE_OVERFLOW_TRIMS_MAX = 2;
const AT5_GAIN_FLOOR_LEVEL = 6;
const AT5_GAIN_LEVEL_CAP = 0x0f;
const AT5_GAIN_SEGMENTS_LAST_INDEX = AT5_GAIN_SEGMENTS_MAX - 1;
const AT5_LOW_MODE_BAND0_SCAN_LIMIT = 4;
const AT5_LOW_MODE_BAND0_DIRECT_BOOST_LOC_LIMIT = 8;

function time2freqBandFlagWord(intensityBand, stereoBandFlags, wordIndex) {
  if (wordIndex <= 0) {
    return intensityBand[0] ?? 0;
  }
  return stereoBandFlags[wordIndex - 1] ?? 0;
}

function analysisPtr(analysisPtrs, channel, band) {
  return analysisPtrs?.[channel * AT5_T2F_BANDS_MAX + band] ?? null;
}

function ensureLowModeMaximaScratch(scratch) {
  const maximaScratch = ensureTime2freqGainWindowScratch(scratch);

  if (scratch && typeof scratch === "object") {
    scratch.tmp = maximaScratch.time;
  }

  return maximaScratch;
}

function ensureRecordMatchScratch(scratch) {
  let matchIndexes = scratch?.matchIndexes ?? scratch?.mapIdx ?? null;
  if (!(matchIndexes instanceof Int32Array) || matchIndexes.length !== AT5_GAIN_SEGMENTS_MAX) {
    matchIndexes = new Int32Array(AT5_GAIN_SEGMENTS_MAX);
  }

  if (scratch && typeof scratch === "object") {
    scratch.matchIndexes = matchIndexes;
    scratch.mapIdx = matchIndexes;
  }
  return matchIndexes;
}

function ensureLowModeCopyEligibilityScratch(scratch) {
  let copyEligibleByBand = scratch?.copyEligibleByBand ?? scratch?.bandFlags ?? null;
  if (
    !(copyEligibleByBand instanceof Int32Array) ||
    copyEligibleByBand.length !== AT5_T2F_BANDS_MAX
  ) {
    copyEligibleByBand = new Int32Array(AT5_T2F_BANDS_MAX);
  }

  if (scratch) {
    scratch.copyEligibleByBand = copyEligibleByBand;
  }
  return copyEligibleByBand;
}

function copyRecordTimeline(dst, src) {
  dst.entries = src.entries >>> 0;
  dst.locations.set(src.locations);
  dst.levels.set(src.levels);
}

function copyGainRecordShape(dst, src) {
  copyRecordTimeline(dst, src);
  dst.tlevFlag = src.tlevFlag | 0;
}

function incrementGainLevel(level) {
  return Math.min((level | 0) + 1, AT5_GAIN_LEVEL_CAP);
}

function lowModeLeadingLevelAboveFloor(record) {
  return (record?.entries ?? 0) !== 0 ? ((record?.levels?.[0] | 0) - AT5_GAIN_FLOOR_LEVEL) | 0 : 0;
}

function lowModeHighCorrelationThreshold(coreMode) {
  if ((coreMode | 0) < 0x13) {
    return K20;
  }
  if ((coreMode | 0) < 0x17) {
    return K30;
  }
  return K40;
}

function hasLowModeRecordActivity(prevRecord, curRecord) {
  return Boolean(
    prevRecord && curRecord && ((prevRecord.entries | 0) !== 0 || (curRecord.entries | 0) !== 0)
  );
}

function arraysMatchWithinDelta(left, right, count, maxDelta) {
  for (let i = 0; i < count; i += 1) {
    if (Math.abs((left?.[i] | 0) - (right?.[i] | 0)) > maxDelta) {
      return false;
    }
  }
  return true;
}

function recordsMatchWithinDelta(left, right, count, maxDelta = AT5_LOW_MODE_RECORD_MERGE_DELTA) {
  return (
    arraysMatchWithinDelta(recordLocations(left), recordLocations(right), count, maxDelta) &&
    arraysMatchWithinDelta(recordLevels(left), recordLevels(right), count, maxDelta)
  );
}

function ensureLowModeMaximaBuffers(out) {
  return {
    maxPre: out?.maxPre instanceof Float32Array ? out.maxPre : new Float32Array(32),
    maxPost: out?.maxPost instanceof Float32Array ? out.maxPost : new Float32Array(32),
  };
}

function storeLowModeMaximaResult(out, maxPre, maxPost) {
  if (out && typeof out === "object") {
    out.maxPre = maxPre;
    out.maxPost = maxPost;
    return out;
  }
  return { maxPre, maxPost };
}

function countMatchingRecordLocations(small, large, matchIndexes) {
  matchIndexes.fill(-1);

  const smallLocs = recordLocations(small);
  const largeLocs = recordLocations(large);
  const smallCount = recordEntries(small);
  const largeCount = recordEntries(large);

  let matchCount = 0;
  for (let smallIndex = 0; smallIndex < smallCount; smallIndex += 1) {
    for (let largeIndex = 0; largeIndex < largeCount; largeIndex += 1) {
      if ((largeLocs?.[largeIndex] | 0) !== (smallLocs?.[smallIndex] | 0)) {
        continue;
      }
      if (matchCount < AT5_GAIN_SEGMENTS_MAX) {
        matchIndexes[matchCount] = largeIndex;
      }
      matchCount += 1;
    }
  }
  return matchCount;
}

function canPromoteSparseStereoRecord(small, large, matchIndexes, matchCount) {
  const largeCount = recordEntries(large);
  const smallCount = recordEntries(small);
  if (matchCount <= 1 || matchCount !== largeCount - 1) {
    return false;
  }

  const smallLevels = recordLevels(small);
  const largeLevels = recordLevels(large);
  for (let i = 0; i < matchCount - 1; i += 1) {
    const curLargeIndex = matchIndexes[i];
    const nextLargeIndex = matchIndexes[i + 1];
    const smallDrop = (smallLevels?.[i] | 0) - (smallLevels?.[i + 1] | 0);
    const largeDrop = (largeLevels?.[curLargeIndex] | 0) - (largeLevels?.[nextLargeIndex] | 0);
    if (Math.abs(smallDrop - largeDrop) > AT5_LOW_MODE_RECORD_MERGE_DELTA) {
      return false;
    }
  }

  const firstDiff = Math.abs((largeLevels?.[0] | 0) - (smallLevels?.[0] | 0));
  const lastDiff = Math.abs(
    (largeLevels?.[largeCount - 1] | 0) - (smallLevels?.[smallCount - 1] | 0)
  );
  return (
    firstDiff <= AT5_LOW_MODE_RECORD_MERGE_DELTA && lastDiff <= AT5_LOW_MODE_RECORD_MERGE_DELTA
  );
}

function mergeAdjacentRecordEnvelope(primary, secondary, count) {
  const primaryLocs = recordLocations(primary);
  const secondaryLocs = recordLocations(secondary);
  const primaryLevels = recordLevels(primary);
  const secondaryLevels = recordLevels(secondary);

  for (let i = 0; i < count; i += 1) {
    primaryLocs[i] = Math.min(primaryLocs?.[i] | 0, secondaryLocs?.[i] | 0) >>> 0;
    primaryLevels[i] = Math.max(primaryLevels?.[i] | 0, secondaryLevels?.[i] | 0) >>> 0;
  }
}

function findDominantBand1Location(record) {
  const count = recordEntries(record);
  if (count <= 0) {
    return { location: -1, score: 0 };
  }

  const locations = recordLocations(record);
  const levels = recordLevels(record);
  let bestLocation = locations?.[count - 1] | 0;
  let bestScore = (levels?.[count - 1] | 0) - AT5_GAIN_FLOOR_LEVEL;

  for (let i = 0; i < count - 1; i += 1) {
    const drop = (levels?.[i] | 0) - (levels?.[i + 1] | 0);
    if (drop <= bestScore) {
      continue;
    }
    bestScore = drop;
    bestLocation = locations?.[i] | 0;
  }

  return { location: bestLocation, score: bestScore };
}

function higherBandsSupportBand0Location(curBuf, bandLimit, location) {
  const scanLimit = Math.min(bandLimit, AT5_LOW_MODE_BAND0_SCAN_LIMIT);
  for (let band = 2; band < scanLimit; band += 1) {
    const record = curBuf.records[band];
    const count = recordEntries(record);
    if (count <= 0) {
      return false;
    }

    const locations = recordLocations(record);
    let foundNearbyLocation = false;
    for (let i = 0; i < count; i += 1) {
      if (Math.abs(location - (locations?.[i] | 0)) <= AT5_LOW_MODE_RECORD_MERGE_DELTA) {
        foundNearbyLocation = true;
        break;
      }
    }
    if (!foundNearbyLocation) {
      return false;
    }
  }
  return true;
}

function seedBand0FromPeer(record0, peerBuf, channelCount, location) {
  if ((channelCount | 0) !== 2 || recordEntries(record0) !== 0 || !peerBuf) {
    return false;
  }
  if (at5GainRecordMetric(peerBuf.records[1]) <= 1) {
    return false;
  }

  record0.entries = 1;
  recordLocations(record0)[0] = location >>> 0;
  recordLevels(record0)[0] = 7;
  return true;
}

function updateBand0FromDominantLocation(record, location, seededFromPeer) {
  const count = recordEntries(record);
  if (count <= 0) {
    return;
  }

  const lastIndex = count - 1;
  const locations = recordLocations(record);
  const levels = recordLevels(record);

  if (lastIndex < AT5_GAIN_SEGMENTS_LAST_INDEX && location < (locations?.[0] | 0)) {
    for (let i = count - 1; i >= 0; i -= 1) {
      locations[i + 1] = locations[i];
      levels[i + 1] = levels[i];
    }
    locations[0] = location >>> 0;
    levels[0] = incrementGainLevel(levels?.[1] | 0);
    record.entries = count + 1;
    return;
  }

  if (lastIndex < AT5_GAIN_SEGMENTS_LAST_INDEX && (locations?.[lastIndex] | 0) < location) {
    locations[count] = location >>> 0;
    levels[count] = 7;
    for (let i = count - 1; i >= 0; i -= 1) {
      levels[i] = incrementGainLevel(levels?.[i] | 0);
    }
    record.entries = count + 1;
    return;
  }

  if (seededFromPeer || location >= AT5_LOW_MODE_BAND0_DIRECT_BOOST_LOC_LIMIT) {
    return;
  }

  for (let i = 0; i < count - 1; i += 1) {
    if ((levels?.[i] | 0) < (levels?.[i + 1] | 0)) {
      return;
    }
  }
  if ((levels?.[lastIndex] | 0) < AT5_GAIN_FLOOR_LEVEL) {
    return;
  }
  if (Math.abs((locations?.[0] | 0) - location) > AT5_LOW_MODE_RECORD_MERGE_DELTA) {
    return;
  }
  levels[0] = incrementGainLevel(levels?.[0] | 0);
}

function computePostWindowPeak(src, prevRecord, curRecord, scratch) {
  const { time } = scratch;
  time.set(src.subarray(0, AT5_T2F_TIME_SAMPLES));
  applyGainWindowToTimeSamples(time, prevRecord, curRecord, scratch);
  return at5MaxAbs256(time);
}

function shouldReduceGainOverflow(prePeak, postPeak, preScale, postLimit) {
  return postPeak > postLimit || postPeak > prePeak * preScale;
}

function shouldPreferSharedLowModeRecord(prev0Record, prev1Record, cur0Record, cur1Record) {
  const leftLead = lowModeLeadingLevelAboveFloor(cur0Record);
  const rightLead = lowModeLeadingLevelAboveFloor(cur1Record);
  if (leftLead < 1 || leftLead - rightLead < 2) {
    return true;
  }

  const prev0Min = prev0Record?.minAll ?? 0;
  const prev1Min = prev1Record?.minAll ?? 0;
  return prev1Min <= prev0Min && prev1Min < K32768;
}

function copyPreferredStereoRecord(record0, record1) {
  const { dst, src } = bandCopyTarget(record0, record1);
  at5GainRecordCopy(dst, src);
}

function hasSharedStereoNeighborhood(intensityBand, stereoBandFlags, band) {
  const firstWord = band < AT5_T2F_BANDS_MAX - 1 ? band : band - 1;
  for (let word = firstWord; word < firstWord + 3; word += 1) {
    if (time2freqBandFlagWord(intensityBand, stereoBandFlags, word) === 0) {
      return false;
    }
  }
  return true;
}

function shouldCopyModerateCorrelationBand(
  band,
  correlation,
  intensityStartBand,
  intensityBand,
  stereoBandFlags
) {
  return (
    correlation > AT5_TIME2FREQ_WEIGHT_TABLE[band] &&
    intensityStartBand < band &&
    hasSharedStereoNeighborhood(intensityBand, stereoBandFlags, band)
  );
}

function syncStereoBandFlags(stereoBandFlags, records0, records1) {
  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    stereoBandFlags[band] = at5GainRecordEqual(records0[band], records1[band]) ? 1 : 0;
  }
}

function shouldCopyLowCorrelationBand(
  band,
  copyEligibleByBand,
  stereoBandFlags,
  corrByBand,
  corrLead,
  corrFloor
) {
  return (
    stereoBandFlags[band] === 0 &&
    copyEligibleByBand[band] !== 0 &&
    corrByBand[band] >= corrFloor &&
    corrLead[band] >= corrFloor
  );
}

export function at5MaxAbs256(src) {
  if (!src) {
    return 0;
  }

  let maxv = Math.abs(src[0]);
  for (let i = 1; i < AT5_T2F_TIME_SAMPLES; i += 1) {
    const value = Math.abs(src[i]);
    if (value > maxv) {
      maxv = value;
    }
  }
  return maxv;
}

export function at5T2fComputeMaxima(
  prevBufs,
  curBufs,
  analysisPtrs,
  channelCount,
  bandCount,
  maxPre,
  maxPost,
  scratch = null
) {
  if (!prevBufs || !curBufs || !analysisPtrs || !maxPre || !maxPost) {
    return;
  }

  const total = AT5_T2F_MAX_CHANNELS * AT5_T2F_BANDS_MAX;
  maxPre.fill(0, 0, total);
  maxPost.fill(0, 0, total);
  const maximaScratch = ensureLowModeMaximaScratch(scratch);

  for (let band = 0; band < bandCount; band += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) {
      const prevRecord = prevBufs[ch]?.records?.[band];
      const curRecord = curBufs[ch]?.records?.[band];
      if (!hasLowModeRecordActivity(prevRecord, curRecord)) {
        continue;
      }

      const src = analysisPtr(analysisPtrs, ch, band);
      if (!src) {
        continue;
      }

      const { time } = maximaScratch;
      time.set(src.subarray(0, AT5_T2F_TIME_SAMPLES));
      const index = ch * AT5_T2F_BANDS_MAX + band;
      maxPre[index] = at5MaxAbs256(time);
      applyGainWindowToTimeSamples(time, prevRecord, curRecord, maximaScratch);
      maxPost[index] = at5MaxAbs256(time);
    }
  }
}

export function at5T2fAdjustMaximaStereo(maxPre, maxPost, bandCount, k0p95, k1p05) {
  if (!maxPre || !maxPost) {
    return;
  }

  for (let band = 0; band < bandCount; band += 1) {
    const swap = !(maxPost[band] > maxPre[band]);
    const leftIndex = band + (swap ? 0 : AT5_T2F_BANDS_MAX);
    const rightIndex = band + (swap ? AT5_T2F_BANDS_MAX : 0);

    {
      const leftValue = maxPre[leftIndex];
      const rightValue = maxPre[rightIndex];
      if (rightValue * k1p05 > leftValue) {
        const merged = leftValue < rightValue ? rightValue : leftValue;
        maxPre[leftIndex] = merged;
        maxPre[rightIndex] = merged;
      }
    }

    {
      const leftValue = maxPost[leftIndex];
      const rightValue = maxPost[rightIndex];
      const low = rightValue * k0p95;
      const high = rightValue * k1p05;
      if (leftValue > low && leftValue < high) {
        const merged = leftValue < rightValue ? rightValue : leftValue;
        maxPost[leftIndex] = merged;
        maxPost[rightIndex] = merged;
      }
    }
  }
}

export function at5T2fReduceGainOverflow(
  prevBufs,
  curBufs,
  analysisPtrs,
  channelCount,
  bandCount,
  maxPre,
  maxPost,
  k8,
  k65536,
  scratch = null
) {
  const maximaScratch = ensureLowModeMaximaScratch(scratch);

  for (let band = 0; band < bandCount; band += 1) {
    const recordsEqualInitial =
      channelCount === 2 &&
      at5GainRecordEqual(curBufs[0]?.records?.[band], curBufs[1]?.records?.[band]);

    for (let ch = 0; ch < channelCount; ch += 1) {
      const prevRecord = prevBufs[ch]?.records?.[band];
      const curRecord = curBufs[ch]?.records?.[band];
      if (!hasLowModeRecordActivity(prevRecord, curRecord)) {
        continue;
      }

      const index = ch * AT5_T2F_BANDS_MAX + band;
      const prePeak = maxPre[index];
      if (!shouldReduceGainOverflow(prePeak, maxPost[index], k8, k65536)) {
        continue;
      }

      let attempts = 0;
      while (
        (curRecord.entries | 0) > 0 &&
        shouldReduceGainOverflow(prePeak, maxPost[index], k8, k65536) &&
        attempts < AT5_LOW_MODE_OVERFLOW_TRIMS_MAX
      ) {
        const decrementIndex = at5GainRecordDecrementIndex(curRecord);
        if (decrementIndex < 0) {
          break;
        }

        curRecord.levels[decrementIndex] -= 1;
        at5GainRecordNormalize(curRecord);

        const src = analysisPtr(analysisPtrs, ch, band);
        if (!src) {
          break;
        }

        maxPost[index] = computePostWindowPeak(src, prevRecord, curRecord, maximaScratch);
        attempts += 1;
      }
    }

    if (!recordsEqualInitial) {
      continue;
    }

    const left = curBufs[0]?.records?.[band];
    const right = curBufs[1]?.records?.[band];
    if (!left || !right || at5GainRecordEqual(left, right)) {
      continue;
    }

    const leftMetric = at5GainRecordMetric(left);
    const rightMetric = at5GainRecordMetric(right);
    const winner = rightMetric < leftMetric ? right : left;
    const loser = rightMetric < leftMetric ? left : right;
    copyGainRecordShape(loser, winner);
  }
}

export function at5T2fLowModeMaximaAndOverflow(
  prevBufs,
  curBufs,
  analysisRows,
  channelCount,
  bandCount,
  out = null
) {
  const { maxPre, maxPost } = ensureLowModeMaximaBuffers(out);
  at5T2fComputeMaxima(
    prevBufs,
    curBufs,
    analysisRows,
    channelCount,
    bandCount,
    maxPre,
    maxPost,
    out
  );

  if ((channelCount | 0) === 2) {
    at5T2fAdjustMaximaStereo(
      maxPre,
      maxPost,
      bandCount | 0,
      AT5_LOW_MODE_MAXIMA_MATCH_LOW,
      AT5_LOW_MODE_MAXIMA_MATCH_HIGH
    );
  }

  at5T2fReduceGainOverflow(
    prevBufs,
    curBufs,
    analysisRows,
    channelCount | 0,
    bandCount | 0,
    maxPre,
    maxPost,
    K8,
    AT5_LOW_MODE_OVERFLOW_LIMIT,
    out
  );

  return storeLowModeMaximaResult(out, maxPre, maxPost);
}

export function at5T2fCopyRecordsStereoLowModes(
  blocks,
  prev0,
  prev1,
  cur0,
  cur1,
  coreMode,
  corrByBand,
  sharedAux = null
) {
  if (!blocks || !blocks[0] || !blocks[1] || !prev0 || !prev1 || !cur0 || !cur1 || !corrByBand) {
    return;
  }

  const shared = blockShared(blocks[0]);
  if (!shared || ((shared.encodeFlagCc ?? 0) | 0) !== 0 || (coreMode | 0) >= 0x18) {
    return;
  }

  const scratch = time2freqScratch(sharedAux);
  const corrHistory = at5SigprocCorrHistoryViews(sharedAux ?? blocks[0]);
  const intensityBand = at5SigprocIntensityBandView(sharedAux ?? blocks[0]);
  const stereoBandFlags = at5SigprocTime2freqBandFlagsView(sharedAux ?? blocks[0]);
  const corrLead = corrHistory.metric0Lead;
  if (
    !(corrLead instanceof Float32Array) ||
    !(intensityBand instanceof Uint32Array) ||
    !(stereoBandFlags instanceof Uint32Array)
  ) {
    return;
  }

  const copyEligibleByBand = ensureLowModeCopyEligibilityScratch(scratch);
  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    copyEligibleByBand[band] = shouldPreferSharedLowModeRecord(
      prev0.records[band],
      prev1.records[band],
      cur0.records[band],
      cur1.records[band]
    )
      ? 1
      : 0;
  }

  const corrHigh = lowModeHighCorrelationThreshold(coreMode);
  const intensityStartBand = intensityBand[0] >>> 0;
  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    if (copyEligibleByBand[band] === 0) {
      continue;
    }

    const correlation = corrByBand[band];
    if (
      correlation > corrHigh ||
      shouldCopyModerateCorrelationBand(
        band,
        correlation,
        intensityStartBand,
        intensityBand,
        stereoBandFlags
      )
    ) {
      copyPreferredStereoRecord(cur0.records[band], cur1.records[band]);
    }
  }

  syncStereoBandFlags(stereoBandFlags, cur0.records, cur1.records);

  const corrLow = corrHigh * K0P6;
  for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
    if (
      shouldCopyLowCorrelationBand(
        band,
        copyEligibleByBand,
        stereoBandFlags,
        corrByBand,
        corrLead,
        corrLow
      )
    ) {
      copyPreferredStereoRecord(cur0.records[band], cur1.records[band]);
      stereoBandFlags[band] = 1;
    }
  }
}

export function at5T2fMergeCloseRecordsBetweenChannels(record0, record1, scratch = null) {
  if (!record0 || !record1) {
    return;
  }

  const sparse = recordEntries(record1) <= recordEntries(record0) ? record1 : record0;
  const dense = sparse === record0 ? record1 : record0;
  const sparseCount = recordEntries(sparse);
  const denseCount = recordEntries(dense);

  if (denseCount !== sparseCount && denseCount > 0 && sparseCount > 0) {
    const matchIndexes = ensureRecordMatchScratch(scratch);
    const matchCount = countMatchingRecordLocations(sparse, dense, matchIndexes);
    if (canPromoteSparseStereoRecord(sparse, dense, matchIndexes, matchCount)) {
      copyRecordTimeline(sparse, dense);
    }
  }

  if (at5GainRecordEqual(record0, record1)) {
    return;
  }

  const count0 = recordEntries(record0);
  const count1 = recordEntries(record1);
  if (count0 !== count1 || count0 <= 0 || !recordsMatchWithinDelta(record0, record1, count0)) {
    return;
  }

  mergeAdjacentRecordEnvelope(record0, record1, count0);
  copyRecordTimeline(record1, record0);
  at5GainRecordNormalize(record0);
  at5GainRecordNormalize(record1);
}

export function at5T2fAdjustBand0RecordFromBand1(
  curBuf,
  peerBuf,
  channelCount,
  _channelIndex,
  bandLimit
) {
  if (!curBuf || bandLimit <= 1) {
    return;
  }

  const band0Record = curBuf.records[0];
  const band1Record = curBuf.records[1];
  const { location: bestLocation, score: bestScore } = findDominantBand1Location(band1Record);
  if (
    bestScore <= 1 ||
    !higherBandsSupportBand0Location(curBuf, bandLimit, bestLocation) ||
    at5GainRecordMetric(band0Record) > 2
  ) {
    return;
  }

  const seededFromPeer = seedBand0FromPeer(band0Record, peerBuf, channelCount, bestLocation);
  updateBand0FromDominantLocation(band0Record, bestLocation, seededFromPeer);
  at5GainRecordNormalize(band0Record);
}

export function at5T2fMergeAdjacentBandRecords(curBuf, bandLimit) {
  if (!curBuf || bandLimit <= 3) {
    return;
  }

  for (let band = 2; band < bandLimit - 1; band += 1) {
    const left = curBuf.records[band];
    const right = curBuf.records[band + 1];
    const count = recordEntries(left);
    if (
      count <= 0 ||
      count !== recordEntries(right) ||
      at5GainRecordEqual(left, right) ||
      !recordsMatchWithinDelta(left, right, count)
    ) {
      continue;
    }

    mergeAdjacentRecordEnvelope(left, right, count);
    at5GainRecordNormalize(left);
  }
}
