/**
 * ATRAC3plus regular block transport.
 *
 * The regular block is the core ATRAC3plus payload. Keeping its pack and
 * unpack paths together makes the bit layout easier to study without chasing a
 * separate encode-only directory for the same structure.
 */
import {
  at5HcspecDescForBand,
  at5PackHcspecForBand,
  at5PackStoreFromMsb,
  at5ReadBits,
  decodeAt5Presence,
  unpackChannelSpectra,
} from "./bitstream.js";
import { AT5_IDSPCBANDS, AT5_ISPS, AT5_NSPS, at5MapCountForBandCount } from "../tables/unpack.js";
import {
  sharedMapSegmentCount,
  sharedNoiseFillCursor,
  sharedNoiseFillEnabled,
  sharedNoiseFillShift,
  sharedZeroSpectraFlag,
} from "../shared-fields.js";
import { unpackGainRecords } from "./gain.js";
import { packGainRecords } from "./gain-internal.js";
import { unpackGh } from "./gh.js";
import { packGhAt5 } from "./gh-internal.js";
import { unpackIdct } from "./idct.js";
import { packIdctChannel, setIdctTypes } from "./idct-internal.js";
import { unpackIdsf } from "./idsf.js";
import { packIdsfChannel } from "./idsf-internal.js";
import { unpackIdwl } from "./idwl.js";
import { packIdwlChannel } from "./idwl-internal.js";
import { at5ActiveBandCount } from "./block-state.js";

const AT5_ERROR_BAD_IDWL_LIMIT = 0x4;
const AT5_ERROR_BITSTREAM_OVERRUN = 0x5;

function assertRegularBlockState(block) {
  if (!block || !block.shared || !Array.isArray(block.channels)) {
    throw new TypeError("invalid AT5 regular block state");
  }
}

function captureRegularStageError(block, channel, stageState = channel) {
  const code = stageState.blockErrorCode >>> 0;
  channel.blockErrorCode = code;
  if (code !== 0) {
    block.blockErrorCode = code;
  }
}

function resetRegularBlockState(block) {
  const { shared, channels } = block;
  block.blockErrorCode = 0;
  shared.gainModeFlag = 0;
  shared.noiseFillEnabled = 0;
  shared.noiseFillShift = 0;
  shared.noiseFillCursor = 0;
  for (const channel of channels) {
    channel.blockErrorCode = 0;
  }
}

function failRegularBlockBitstreamOverrun(block, bitState) {
  if (!bitState?.error) {
    return false;
  }

  block.blockErrorCode = AT5_ERROR_BITSTREAM_OVERRUN;
  for (const channel of block.channels) {
    channel.blockErrorCode = AT5_ERROR_BITSTREAM_OVERRUN;
  }
  return true;
}

function unpackIdsfAndIdct(block, frame, bitState, idsfCount) {
  const { shared, channels, idsfShared } = block;
  shared.idsfCount = idsfCount >>> 0;
  shared.mapCount = at5MapCountForBandCount(idsfCount);
  idsfShared.idsfCount = idsfCount >>> 0;
  idsfShared.idsfGroupCount = shared.mapCount >>> 0;

  if (idsfCount === 0) {
    return true;
  }

  for (const channel of channels) {
    const modeSelect = at5ReadBits(frame, bitState, 2) >>> 0;
    channel.idsfModeSelect = modeSelect;
    if (!unpackIdsf(channel.idsfState, frame, bitState, modeSelect)) {
      captureRegularStageError(block, channel, channel.idsfState);
      return false;
    }
    captureRegularStageError(block, channel, channel.idsfState);
  }

  const gainModeFlag = at5ReadBits(frame, bitState, 1) >>> 0;
  shared.gainModeFlag = gainModeFlag;
  for (const channel of channels) {
    channel.idct.values.fill(0);
    channel.idctState.shared.maxCount = idsfCount;
    channel.idctState.shared.fixIdx = gainModeFlag;
    channel.idctState.shared.gainModeFlag = gainModeFlag;
    channel.idctTableCtx = at5ReadBits(frame, bitState, 1) >>> 0;
    channel.idctModeSelect = at5ReadBits(frame, bitState, 2) >>> 0;

    setIdctTypes(channel, idsfCount);
    if (!unpackIdct(channel.idctState, frame, bitState, channel.idctModeSelect)) {
      captureRegularStageError(block, channel, channel.idctState);
      return false;
    }
    captureRegularStageError(block, channel, channel.idctState);
  }

  return true;
}

function activeRegularChannelCount(block) {
  const channelCount = block.shared.channels >>> 0;
  if (channelCount < 1 || channelCount > 2 || block.channels.length < channelCount) {
    return 0;
  }

  return channelCount | 0;
}

function packAt5PresenceTable(table, count, dst, bitState) {
  if (!table) {
    return at5PackStoreFromMsb(0, 1, dst, bitState);
  }

  const enabled = table.enabled & 1;
  if (!at5PackStoreFromMsb(enabled, 1, dst, bitState)) {
    return false;
  }
  if (enabled === 0) {
    return true;
  }

  const mixed = table.mixed & 1;
  if (!at5PackStoreFromMsb(mixed, 1, dst, bitState)) {
    return false;
  }
  if (mixed === 0) {
    return true;
  }

  const limit = Math.min(count | 0, table.flags.length | 0);
  for (let index = 0; index < limit; index += 1) {
    if (!at5PackStoreFromMsb(table.flags[index] & 1, 1, dst, bitState)) {
      return false;
    }
  }

  return true;
}

function specialLevelBandCount(idsfCount, mapCount) {
  if (idsfCount <= 2 || mapCount === 0) {
    return 0;
  }

  const maxBand = AT5_IDSPCBANDS[mapCount - 1] ?? 0xff;
  return maxBand === 0xff ? 0 : (maxBand >>> 0) + 1;
}

export function unpackChannelBlockAt5Reg(block, frame, bitState) {
  assertRegularBlockState(block);

  const { shared, channels, idwlShared } = block;
  resetRegularBlockState(block);
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }

  const codedBandLimit = at5ReadBits(frame, bitState, 5) + 1;
  shared.codedBandLimit = codedBandLimit >>> 0;
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }
  if (codedBandLimit >= 29 && codedBandLimit <= 31) {
    block.blockErrorCode = AT5_ERROR_BAD_IDWL_LIMIT;
  }
  shared.mapSegmentCount = at5MapCountForBandCount(codedBandLimit);
  shared.zeroSpectraFlag = at5ReadBits(frame, bitState, 1) >>> 0;
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }
  idwlShared.codedBandLimit = codedBandLimit >>> 0;
  idwlShared.pairCount = 0;
  idwlShared.pairFlags.fill(0);

  for (const channel of channels) {
    channel.idwlPackMode = at5ReadBits(frame, bitState, 2) >>> 0;
    if (failRegularBlockBitstreamOverrun(block, bitState)) {
      return false;
    }
    if (!unpackIdwl(channel.idwlState, frame, bitState, channel.idwlPackMode)) {
      captureRegularStageError(block, channel, channel.idwlState);
      return false;
    }
    captureRegularStageError(block, channel, channel.idwlState);
    if (failRegularBlockBitstreamOverrun(block, bitState)) {
      return false;
    }
  }

  const stereoPair = shared.channels >>> 0 === 2;
  const idsfCount = at5ActiveBandCount(
    channels[0].idwl.values,
    stereoPair ? channels[1].idwl.values : channels[0].idwl.values,
    codedBandLimit,
    shared.channels
  );
  if (!unpackIdsfAndIdct(block, frame, bitState, idsfCount)) {
    return false;
  }
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }

  for (const channel of channels) {
    unpackChannelSpectra(channel, shared, frame, bitState);
  }
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }

  if (stereoPair) {
    decodeAt5Presence(shared.stereoSwapPresence, shared.mapCount, frame, bitState);
    decodeAt5Presence(shared.stereoFlipPresence, shared.mapCount, frame, bitState);
  }
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }

  const mapSegmentCount = sharedMapSegmentCount(shared);
  for (const channel of channels) {
    decodeAt5Presence(channel.channelPresence, mapSegmentCount, frame, bitState);
  }
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }

  for (const channel of channels) {
    if (!unpackGainRecords(channel, frame, bitState)) {
      captureRegularStageError(block, channel);
      return false;
    }
    captureRegularStageError(block, channel);
    if (failRegularBlockBitstreamOverrun(block, bitState)) {
      return false;
    }
  }

  if (!unpackGh(block, frame, bitState)) {
    for (const channel of channels) {
      captureRegularStageError(block, channel);
    }
    return false;
  }
  for (const channel of channels) {
    captureRegularStageError(block, channel);
  }
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }

  shared.noiseFillEnabled = at5ReadBits(frame, bitState, 1) >>> 0;
  if (failRegularBlockBitstreamOverrun(block, bitState)) {
    return false;
  }
  if ((shared.noiseFillEnabled | 0) !== 0) {
    shared.noiseFillShift = at5ReadBits(frame, bitState, 4) >>> 0;
    shared.noiseFillCursor = at5ReadBits(frame, bitState, 4) >>> 0;
    if (failRegularBlockBitstreamOverrun(block, bitState)) {
      return false;
    }
  }

  return true;
}

export function packChannelBlockAt5Reg(block, dst, bitState) {
  assertRegularBlockState(block);

  const channelCount = activeRegularChannelCount(block);
  if (channelCount === 0) {
    return false;
  }

  const { channels, shared } = block;
  const idwlLimit = Math.max(1, (shared.bandLimit ?? shared.codedBandLimit ?? 0) | 0);
  if (!at5PackStoreFromMsb((idwlLimit - 1) & 0x1f, 5, dst, bitState)) {
    return false;
  }
  if (!at5PackStoreFromMsb(sharedZeroSpectraFlag(shared) & 1, 1, dst, bitState)) {
    return false;
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channels[channelIndex];
    if (!at5PackStoreFromMsb(channel.idwlPackMode & 0x3, 2, dst, bitState)) {
      return false;
    }
    if (!packIdwlChannel(channel, idwlLimit, dst, bitState)) {
      return false;
    }
  }

  const idsfCount = shared.idsfCount >>> 0;
  if (idsfCount > 0) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = channels[channelIndex];
      if (!at5PackStoreFromMsb(channel.idsfModeSelect & 0x3, 2, dst, bitState)) {
        return false;
      }
      if (!packIdsfChannel(channel, dst, bitState)) {
        return false;
      }
    }

    if (!at5PackStoreFromMsb(shared.gainModeFlag & 1, 1, dst, bitState)) {
      return false;
    }

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = channels[channelIndex];
      setIdctTypes(channel, idsfCount);
      if (!at5PackStoreFromMsb(channel.idctTableCtx & 1, 1, dst, bitState)) {
        return false;
      }
      if (!at5PackStoreFromMsb(channel.idctModeSelect & 0x3, 2, dst, bitState)) {
        return false;
      }
      if (!packIdctChannel(channel, idsfCount, dst, bitState)) {
        return false;
      }
    }
  }

  const spclevCount = specialLevelBandCount(idsfCount, shared.mapCount >>> 0);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channels[channelIndex];
    const spectra = channel.scratchSpectra;
    for (let band = 0; band < idsfCount; band += 1) {
      const wl = channel.idwl.values[band] >>> 0;
      if (wl === 0) {
        continue;
      }

      const nsps = AT5_NSPS[band] >>> 0;
      if (nsps === 0) {
        continue;
      }

      const start = AT5_ISPS[band] >>> 0;
      const desc = at5HcspecDescForBand(shared, channel, band);
      if (!at5PackHcspecForBand(spectra.subarray(start, start + nsps), nsps, desc, dst, bitState)) {
        return false;
      }
    }

    for (let index = 0; index < spclevCount && index < channel.spclevIndex.length; index += 1) {
      if (!at5PackStoreFromMsb(channel.spclevIndex[index] & 0xf, 4, dst, bitState)) {
        return false;
      }
    }
  }

  if (channelCount === 2) {
    if (!packAt5PresenceTable(shared.stereoSwapPresence, shared.mapCount, dst, bitState)) {
      return false;
    }
    if (!packAt5PresenceTable(shared.stereoFlipPresence, shared.mapCount, dst, bitState)) {
      return false;
    }
  }

  const mapSegmentCount = sharedMapSegmentCount(shared);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channels[channelIndex];
    if (!packAt5PresenceTable(channel.channelPresence, mapSegmentCount, dst, bitState)) {
      return false;
    }
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = channels[channelIndex];
    if (!packGainRecords(channel, dst, bitState)) {
      return false;
    }
  }
  if (!packGhAt5(block, dst, bitState)) {
    return false;
  }

  const noiseFillEnabled = sharedNoiseFillEnabled(shared);
  if (!at5PackStoreFromMsb(noiseFillEnabled & 1, 1, dst, bitState)) {
    return false;
  }
  if ((noiseFillEnabled & 1) === 0) {
    return true;
  }

  if (!at5PackStoreFromMsb(sharedNoiseFillShift(shared) & 0xf, 4, dst, bitState)) {
    return false;
  }
  return at5PackStoreFromMsb(sharedNoiseFillCursor(shared) & 0xf, 4, dst, bitState);
}

export const AT5_CHANNEL_BLOCK_ERROR_CODES = {
  BAD_IDWL_LIMIT: AT5_ERROR_BAD_IDWL_LIMIT,
  BITSTREAM_OVERRUN: AT5_ERROR_BITSTREAM_OVERRUN,
};
