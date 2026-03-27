import { AT5_SG_SHAPE_INDEX } from "../tables/encode-init.js";
import { at5MapCountForBandCount } from "../tables/unpack.js";
import { extractGhwaveAt5 } from "../ghwave/internal.js";
import { checkChannelCorrelationAt5 } from "../math.js";
import {
  AT5_T2F_BANDS_MAX,
  at5T2fAlignTlevFlagsStereo,
  at5T2fAdjustBand0RecordFromBand1,
  at5T2fComputeCorrAverage,
  at5T2fComputeTlevForChannel,
  at5T2fCorrByBandFromAux,
  at5T2fCopyRecordsStereoLowModes,
  at5T2fGaincSetup,
  at5T2fLowModeMaximaAndOverflow,
  at5T2fMdctOutputs,
  at5T2fMergeAdjacentBandRecords,
  at5T2fMergeCloseRecordsBetweenChannels,
  at5T2fThresholdTable,
  time2freqScratch,
} from "../time2freq/internal.js";
import { at5SigprocBandRow, at5SigprocCorrHistoryViews, at5SigprocShiftAux } from "./aux.js";
import { at5BandPtr, buildAt5SigprocBandPtrTable } from "./bandptr.js";
import { at5SigprocRotateChannelBlocks } from "./blocks.js";
import {
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_CORR_SAMPLES,
  AT5_SIGPROC_INTENSITY_DEFAULT,
  AT5_SIGPROC_MAX_CHANNELS,
} from "./constants.js";
import { at5SigprocAnalyzeChannel } from "./filterbank-analysis.js";
import { at5SigprocApplyIntensityStereo, at5SigprocUpdateDbDiff } from "./stereo.js";
import { at5SigprocShiftTimeState } from "./time-state.js";

const AT5_SIGPROC_GHWAVE_ANALYSIS_BASE = 4 * (AT5_SIGPROC_MAX_CHANNELS * AT5_SIGPROC_BANDS_MAX);

function clampSigprocChannelCount(channelCount) {
  let channels = channelCount | 0;
  if (channels > AT5_SIGPROC_MAX_CHANNELS) {
    channels = AT5_SIGPROC_MAX_CHANNELS;
  }
  return channels;
}

function populateActiveSigprocStates(timeStates, scratch) {
  let activeStates = scratch?.activeStates ?? null;
  if (!Array.isArray(activeStates) || activeStates.length !== AT5_SIGPROC_MAX_CHANNELS) {
    activeStates = new Array(AT5_SIGPROC_MAX_CHANNELS).fill(null);
    if (scratch && typeof scratch === "object") {
      scratch.activeStates = activeStates;
    }
  }
  for (let ch = 0; ch < AT5_SIGPROC_MAX_CHANNELS; ch += 1) {
    activeStates[ch] = timeStates[ch] ?? null;
  }
  return activeStates;
}

function analyzeSigprocChannelsAt5({
  inputPtrs,
  activeStates,
  channels,
  bandPtrTable,
  scratch,
  sigprocTrace,
  callIndex,
}) {
  const hasSigprocTrace = sigprocTrace && typeof sigprocTrace.onDump === "function";
  for (let ch = 0; ch < channels; ch += 1) {
    const state = activeStates[ch];
    const pcm = inputPtrs[ch];
    if (!state || !pcm) {
      continue;
    }

    at5SigprocShiftTimeState(state);

    let slot8BandPtrs = scratch?.slot8BandPtrs?.[ch] ?? null;
    if (!Array.isArray(slot8BandPtrs) || slot8BandPtrs.length !== AT5_SIGPROC_BANDS_MAX) {
      slot8BandPtrs = new Array(AT5_SIGPROC_BANDS_MAX);
      if (scratch && typeof scratch === "object") {
        let slot8Root = scratch.slot8BandPtrs;
        if (!Array.isArray(slot8Root)) {
          slot8Root = new Array(AT5_SIGPROC_MAX_CHANNELS);
        } else if (slot8Root.length < AT5_SIGPROC_MAX_CHANNELS) {
          const resized = new Array(AT5_SIGPROC_MAX_CHANNELS);
          for (let index = 0; index < slot8Root.length; index += 1) {
            resized[index] = slot8Root[index];
          }
          slot8Root = resized;
        }
        slot8Root[ch] = slot8BandPtrs;
        scratch.slot8BandPtrs = slot8Root;
      }
    }
    for (let band = 0; band < AT5_SIGPROC_BANDS_MAX; band += 1) {
      slot8BandPtrs[band] = at5BandPtr(bandPtrTable, 8, ch, band);
    }

    const trace = hasSigprocTrace
      ? { ...sigprocTrace, callIndex: callIndex | 0, ch: ch | 0 }
      : null;
    at5SigprocAnalyzeChannel(state, pcm, slot8BandPtrs, trace);
  }
}

function updateSigprocBandLayout(shared, blocks, channels, ispsIndex) {
  const resolvedIspsIndex = ((shared.encodeFlags >>> 0) & 0x7c) !== 0 ? 0x20 : ispsIndex | 0;
  const bandCount = at5MapCountForBandCount(resolvedIspsIndex);

  if (blocks) {
    for (let ch = 0; ch < channels; ch += 1) {
      if (blocks[ch]) {
        blocks[ch].gainActiveCount = bandCount;
      }
    }
  }

  shared.channels = channels >>> 0;
  shared.idsfCount = resolvedIspsIndex >>> 0;
  shared.codedBandLimit = resolvedIspsIndex >>> 0;
  shared.bandCount =
    resolvedIspsIndex < 1 ? 0 : ((AT5_SG_SHAPE_INDEX[(resolvedIspsIndex | 0) - 1] ?? 0) + 1) >>> 0;
  shared.mapSegmentCount = bandCount;
  return bandCount;
}

function updateStereoCorrelationHistoryAt5(aux, scratch, shared, bandPtrTable, bandCount) {
  const corrHistory = at5SigprocCorrHistoryViews(aux);
  let slot1Left = scratch?.slot1Left ?? null;
  if (!Array.isArray(slot1Left) || slot1Left.length !== AT5_SIGPROC_BANDS_MAX) {
    slot1Left = new Array(AT5_SIGPROC_BANDS_MAX);
    if (scratch && typeof scratch === "object") {
      scratch.slot1Left = slot1Left;
    }
  }
  let slot1Right = scratch?.slot1Right ?? null;
  if (!Array.isArray(slot1Right) || slot1Right.length !== AT5_SIGPROC_BANDS_MAX) {
    slot1Right = new Array(AT5_SIGPROC_BANDS_MAX);
    if (scratch && typeof scratch === "object") {
      scratch.slot1Right = slot1Right;
    }
  }
  for (let band = 0; band < bandCount; band += 1) {
    slot1Left[band] = at5BandPtr(bandPtrTable, 1, 0, band);
    slot1Right[band] = at5BandPtr(bandPtrTable, 1, 1, band);
  }

  const correlation = at5SigprocBandRow(corrHistory.metric0, 1);
  const leftPower = at5SigprocBandRow(corrHistory.metric1, 1);
  const rightPower = at5SigprocBandRow(corrHistory.metric2, 1);
  checkChannelCorrelationAt5(
    slot1Left,
    slot1Right,
    AT5_SIGPROC_CORR_SAMPLES,
    bandCount,
    correlation,
    leftPower,
    rightPower,
    scratch?.corr ?? null
  );

  const prevFlags = at5SigprocBandRow(corrHistory.flags, 0);
  const curFlags = at5SigprocBandRow(corrHistory.flags, 1);
  for (let band = 0; band < bandCount; band += 1) {
    const scale = prevFlags[band] === 0 ? leftPower[band] * 8 : leftPower[band] * 4;
    curFlags[band] = correlation[band] > 0 && rightPower[band] > scale ? 1 : 0;
  }

  if (!shared.swapMap) {
    shared.swapMap = new Uint32Array(AT5_SIGPROC_BANDS_MAX);
  }
  for (let band = 0; band < bandCount; band += 1) {
    shared.swapMap[band] = prevFlags[band];
  }
}

function hasSpectrumBuffers(quantizedSpectraByChannel, bitallocSpectraByChannel) {
  return (
    Array.isArray(quantizedSpectraByChannel) &&
    Array.isArray(bitallocSpectraByChannel) &&
    quantizedSpectraByChannel.length > 0 &&
    bitallocSpectraByChannel.length > 0
  );
}

function collectTime2freqBuffers(blocks, channelCount, scratch) {
  let prevBufs = scratch?.prevBufs ?? null;
  if (!Array.isArray(prevBufs) || prevBufs.length !== AT5_SIGPROC_MAX_CHANNELS) {
    prevBufs = new Array(AT5_SIGPROC_MAX_CHANNELS).fill(null);
    if (scratch && typeof scratch === "object") {
      scratch.prevBufs = prevBufs;
    }
  }

  let curBufs = scratch?.curBufs ?? null;
  if (!Array.isArray(curBufs) || curBufs.length !== AT5_SIGPROC_MAX_CHANNELS) {
    curBufs = new Array(AT5_SIGPROC_MAX_CHANNELS).fill(null);
    if (scratch && typeof scratch === "object") {
      scratch.curBufs = curBufs;
    }
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const block = blocks?.[channelIndex] ?? null;
    prevBufs[channelIndex] = block?.prevBuf ?? block?.bufB ?? null;
    curBufs[channelIndex] = block?.curBuf ?? block?.bufA ?? null;
  }

  return { prevBufs, curBufs };
}

function applyLowModeRecordAdjustmentsAt5(curBufs, channelCount, bandCount, time2freqState) {
  if ((channelCount | 0) === 2) {
    for (let band = 0; band < bandCount; band += 1) {
      at5T2fMergeCloseRecordsBetweenChannels(
        curBufs[0]?.records?.[band],
        curBufs[1]?.records?.[band],
        time2freqState
      );
    }
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    at5T2fAdjustBand0RecordFromBand1(
      curBufs[channelIndex],
      channelCount === 2 ? curBufs[channelIndex ^ 1] : null,
      channelCount,
      channelIndex,
      bandCount
    );
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    at5T2fMergeAdjacentBandRecords(curBufs[channelIndex], bandCount);
  }
}

function runSigprocGhwaveStageAt5({
  blocks,
  bandPtrTable,
  sharedCoreMode,
  channelCount,
  disableGh,
}) {
  if (!blocks || disableGh) {
    return false;
  }

  const blockState = blocks[0]?.blockState ?? null;
  if (
    ((blockState?.sinusoidEncodeFlag ?? 0) | 0) === 0 ||
    ((blockState?.isMode4Block ?? 0) | 0) !== 0
  ) {
    return false;
  }

  extractGhwaveAt5(
    blocks,
    bandPtrTable,
    AT5_SIGPROC_GHWAVE_ANALYSIS_BASE,
    sharedCoreMode,
    AT5_SIGPROC_BANDS_MAX,
    channelCount,
    null
  );
  return true;
}

function runSigprocTime2freqStageAt5({
  aux,
  blocks,
  bandPtrTable,
  quantizedSpectraByChannel,
  bitallocSpectraByChannel,
  runTime2freq,
  encodeMode,
  shared,
  resolvedCoreMode,
  channelCount,
  blockMode,
  bandCount,
  setGaincFn,
  detectGaincDataNewFn,
}) {
  const hasSpectra = hasSpectrumBuffers(quantizedSpectraByChannel, bitallocSpectraByChannel);
  if (!runTime2freq && !hasSpectra) {
    return null;
  }

  const scratch = aux?.scratch ?? null;
  const { prevBufs, curBufs } = collectTime2freqBuffers(blocks, channelCount, scratch);
  if (
    !prevBufs[0] ||
    !curBufs[0] ||
    !hasSpectra ||
    quantizedSpectraByChannel.length < channelCount ||
    bitallocSpectraByChannel.length < channelCount
  ) {
    return null;
  }

  const corrByBand = at5T2fCorrByBandFromAux(aux);
  const corrAvg = at5T2fComputeCorrAverage(corrByBand, bandCount);
  const tlevThresholds = at5T2fThresholdTable(shared, resolvedCoreMode);
  const time2freqState = time2freqScratch(aux);
  const stereoJointStage = (blockMode | 0) === 3 && channelCount === 2 && Boolean(corrByBand);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const curBuf = curBufs[channelIndex];
    if (!curBuf) {
      continue;
    }

    at5T2fComputeTlevForChannel(
      curBuf,
      bandPtrTable,
      channelIndex * AT5_T2F_BANDS_MAX,
      shared,
      resolvedCoreMode,
      tlevThresholds,
      time2freqState
    );
  }

  if (stereoJointStage) {
    at5T2fAlignTlevFlagsStereo(blocks, curBufs[0], curBufs[1], corrByBand, bandCount);
  }

  at5T2fGaincSetup(
    blocks,
    bandPtrTable,
    prevBufs,
    curBufs,
    channelCount,
    bandCount,
    resolvedCoreMode,
    corrByBand,
    corrAvg,
    setGaincFn,
    detectGaincDataNewFn
  );

  if (stereoJointStage && ((shared.encodeFlagCc ?? 0) | 0) === 0) {
    at5T2fCopyRecordsStereoLowModes(
      blocks,
      prevBufs[0],
      prevBufs[1],
      curBufs[0],
      curBufs[1],
      resolvedCoreMode,
      corrByBand,
      aux
    );
  }

  const applyLowModeGainAdjust =
    (encodeMode | 0) !== 2 &&
    ((resolvedCoreMode < 0x10 && channelCount === 1) ||
      (resolvedCoreMode < 0x14 && channelCount === 2));
  if (applyLowModeGainAdjust) {
    applyLowModeRecordAdjustmentsAt5(curBufs, channelCount, bandCount, time2freqState);
  }

  const maxima = applyLowModeGainAdjust
    ? at5T2fLowModeMaximaAndOverflow(
        prevBufs,
        curBufs,
        bandPtrTable,
        channelCount,
        bandCount,
        aux?.scratch?.t2fMaxima ?? null
      )
    : null;

  at5T2fMdctOutputs(
    prevBufs,
    curBufs,
    bandPtrTable,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
    channelCount,
    bandCount,
    encodeMode | 0,
    time2freqState
  );

  return {
    maxima,
    corrAvg,
    corrByBand,
  };
}

/**
 * Runs the ATRAC3plus front-end analysis for one frame: filterbank analysis,
 * stereo metrics, optional GH extraction, and the time2freq handoff.
 */
export function at5SigprocAnalyzeFrame(options = {}) {
  const {
    inputPtrs,
    timeStates,
    shared,
    aux,
    blocks = null,
    quantizedSpectraByChannel = null,
    bitallocSpectraByChannel = null,
    runTime2freq = false,
    encodeMode = 0,
    coreMode = null,
    setGaincFn = null,
    detectGaincDataNewFn = null,
    channelCount = 1,
    blockMode = 1,
    ispsIndex = 0,
    callIndex = 0,
    sigprocTrace = null,
    disableGh = false,
    returnSummary = true,
  } = options;
  const channels = clampSigprocChannelCount(channelCount);
  if (channels <= 0 || !timeStates || !shared || !aux || !inputPtrs) {
    return null;
  }

  const scratch = aux?.scratch ?? null;
  const sharedCoreMode = (shared.coreMode ?? 0) | 0;
  const resolvedCoreMode = (coreMode ?? sharedCoreMode) | 0;

  at5SigprocShiftAux(aux);
  if (blocks) {
    at5SigprocRotateChannelBlocks(blocks, channels);
  }
  shared.encodeFlags = (((shared.encodeFlags ?? 0) * 2) & 0x7e) >>> 0;

  const activeStates = populateActiveSigprocStates(timeStates, scratch);
  const bandPtrTable = buildAt5SigprocBandPtrTable(
    activeStates,
    channels,
    scratch?.bandPtrTable ?? null
  );
  if (scratch && typeof scratch === "object") {
    scratch.bandPtrTable = bandPtrTable;
  }
  analyzeSigprocChannelsAt5({
    inputPtrs,
    activeStates,
    channels,
    bandPtrTable,
    scratch,
    sigprocTrace,
    callIndex,
  });

  if (channels === 2) {
    at5SigprocUpdateDbDiff(aux, bandPtrTable);
  }
  if ((blockMode | 0) === 3) {
    at5SigprocApplyIntensityStereo(aux, shared, bandPtrTable, sharedCoreMode, channels);
  } else {
    aux.intensityBand[0] = AT5_SIGPROC_INTENSITY_DEFAULT;
  }

  runSigprocGhwaveStageAt5({
    blocks,
    bandPtrTable,
    sharedCoreMode,
    channelCount: channels,
    disableGh,
  });

  const bandCount = updateSigprocBandLayout(shared, blocks, channels, ispsIndex);

  if (channels === 2) {
    updateStereoCorrelationHistoryAt5(aux, scratch, shared, bandPtrTable, bandCount);
  }

  const time2freq = runSigprocTime2freqStageAt5({
    aux,
    blocks,
    bandPtrTable,
    quantizedSpectraByChannel,
    bitallocSpectraByChannel,
    runTime2freq,
    encodeMode,
    shared,
    resolvedCoreMode,
    channelCount: channels,
    blockMode,
    bandCount,
    setGaincFn,
    detectGaincDataNewFn,
  });

  if (!returnSummary) {
    return null;
  }

  return {
    bandPtrTable,
    bandCount,
    channels,
    time2freq,
  };
}
