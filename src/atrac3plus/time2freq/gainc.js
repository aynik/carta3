import { AT5_T2F_BANDS_MAX } from "./constants.js";
import { K2, K30, KHALF } from "./fp.js";
import { at5GainRecordClearUnusedTail } from "./record.js";
import { at5T2fComputeCorrAverage, blockHeader, blockShared } from "./runtime.js";

function maybeReuseStereoMinAllHistory(prevBufs, band, corrByBand, corrAvg) {
  if (!corrByBand || corrByBand[band] <= K30 || corrAvg <= K30) {
    return;
  }

  const leftPrev = prevBufs?.[0]?.records?.[band];
  const rightPrev = prevBufs?.[1]?.records?.[band];
  if (!leftPrev || !rightPrev) {
    return;
  }

  const leftMinAll = leftPrev.minAll ?? 0;
  const rightMinAll = rightPrev.minAll ?? 0;
  const ratio = leftMinAll / rightMinAll;
  if (ratio > KHALF && ratio < K2) {
    rightPrev.minAll = leftMinAll;
  }
}

function resetCcGainRecord(record) {
  record.minAll = 0;
  record.ampScaledMax = 0;
  record.attackSeedLimit = 0;
  record.derivMaxAll = 0;
  record.derivSeedLimit = 0;
  record.ampSlotMaxSum = 0;
  record.derivSlotMaxSum = 0;
  at5GainRecordClearUnusedTail(record);
}

export function at5T2fGaincSetup(
  blocks,
  analysisPtrs,
  prevBufs,
  curBufs,
  channelCount,
  bandCount,
  coreMode,
  corrByBand = null,
  corrAvg = at5T2fComputeCorrAverage(corrByBand, bandCount),
  setGaincFn = null,
  detectGaincDataNewFn = null
) {
  const channels = channelCount | 0;
  const block0 = blocks?.[0] ?? null;
  if (!block0 || channels <= 0) {
    return;
  }

  if ((blockHeader(block0)?.blockState?.isMode4Block | 0) !== 0) {
    return;
  }

  const shared = blockShared(block0);
  if (!shared) {
    return;
  }

  if (((shared.encodeFlagCc ?? 0) | 0) !== 0) {
    if (typeof detectGaincDataNewFn === "function") {
      detectGaincDataNewFn(
        blocks,
        analysisPtrs,
        prevBufs,
        curBufs,
        channelCount,
        bandCount,
        coreMode
      );
    }

    for (let channel = 0; channel < channels; channel += 1) {
      const curBuf = curBufs?.[channel] ?? null;
      if (!curBuf) {
        continue;
      }

      for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
        resetCcGainRecord(curBuf.records[band]);
      }
    }
  } else if (typeof setGaincFn === "function") {
    for (let band = AT5_T2F_BANDS_MAX - 1; band >= 0; band -= 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        if (channel === 1) {
          maybeReuseStereoMinAllHistory(prevBufs, band, corrByBand, corrAvg);
        }

        setGaincFn(
          blocks,
          analysisPtrs?.[channel * AT5_T2F_BANDS_MAX + band] ?? null,
          band,
          channel,
          prevBufs?.[channel] ?? null,
          curBufs?.[channel] ?? null,
          bandCount
        );
      }
    }
  }

  for (let channel = 0; channel < channels; channel += 1) {
    const curBuf = curBufs?.[channel] ?? null;
    if (!curBuf) {
      continue;
    }

    for (let band = 0; band < AT5_T2F_BANDS_MAX; band += 1) {
      if ((curBuf.records[band]?.attackPoints ?? 0) <= 0) {
        curBuf.records[band].attackFirst = 0;
      }
    }
  }
}
