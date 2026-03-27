import { createAt5PresenceTable, createAt5SpectraChannelState } from "./bitstream.js";
import { createAt5GainChannelState } from "./gain.js";
import { createAt5GhChannelState, createAt5GhSharedState } from "./gh.js";
import { createAt5IdctChannelState, createAt5IdctSharedState } from "./idct.js";
import { createAt5IdsfChannelState, createAt5IdsfSharedState } from "./idsf.js";
import { createAt5IdwlChannelState, createAt5IdwlSharedState } from "./idwl.js";

const AT5_CHANNELS_MIN = 1;
const AT5_CHANNELS_MAX = 2;

export function at5ActiveBandCount(idwlA, idwlB, limit, channelCount) {
  let count = limit >>> 0;
  const stereoPair = channelCount >>> 0 === 2;

  while (count > 0) {
    const band = count - 1;
    if (idwlA[band] >>> 0 !== 0 || (stereoPair && idwlB[band] >>> 0 !== 0)) {
      break;
    }
    count -= 1;
  }

  return count >>> 0;
}

function createRegularChannelState(
  channelIndex,
  shared,
  idwlShared,
  idsfShared,
  ghShared,
  block0 = null
) {
  const idwlState = createAt5IdwlChannelState(channelIndex, idwlShared, block0?.idwlState ?? null);
  const idsfState = createAt5IdsfChannelState(channelIndex, idsfShared, block0?.idsfState ?? null);
  const idctState = createAt5IdctChannelState(
    channelIndex,
    createAt5IdctSharedState({ fixIdx: 0, maxCount: 0, gainModeFlag: 0 }),
    block0?.idctState ?? null
  );
  const spectraState = createAt5SpectraChannelState();
  const gainState = createAt5GainChannelState(channelIndex, block0?.gainState ?? null);
  const ghState = createAt5GhChannelState(channelIndex, block0?.ghState ?? null, ghShared);

  return {
    channelIndex,
    shared,
    block0,
    blockErrorCode: 0,
    idwlPackMode: 0,
    idsfModeSelect: 0,
    idctTableCtx: 0,
    idctModeSelect: 0,
    idwl: idwlState.idwl,
    idsf: idsfState.idsf,
    idct: idctState.idct,
    gain: gainState.gain,
    gh: ghState.gh,
    scratchSpectra: spectraState.scratchSpectra,
    spclevIndex: spectraState.spclevIndex,
    channelPresence: createAt5PresenceTable(),
    idwlState,
    idsfState,
    idctState,
    gainState,
    ghState,
  };
}

export function createAt5RegularBlockState(channelCount) {
  if (
    !Number.isInteger(channelCount) ||
    channelCount < AT5_CHANNELS_MIN ||
    channelCount > AT5_CHANNELS_MAX
  ) {
    throw new RangeError(`invalid AT5 regular block channel count: ${channelCount}`);
  }

  const shared = {
    channels: channelCount >>> 0,
    stereoFlag: channelCount === 2 ? 1 : 0,
    codedBandLimit: 0,
    idsfCount: 0,
    mapCount: 0,
    mapSegmentCount: 0,
    channelPresenceMapCount: 0,
    gainModeFlag: 0,
    noiseFillEnabled: 0,
    noiseFillShift: 0,
    noiseFillCursor: 0,
    zeroSpectraFlag: 0,
    usedBitCount: 0,
    stereoFlipPresence: createAt5PresenceTable(),
    stereoSwapPresence: createAt5PresenceTable(),
  };
  const idwlShared = createAt5IdwlSharedState(0);
  const idsfShared = createAt5IdsfSharedState(0);
  const ghShared = createAt5GhSharedState(channelCount);

  const baseChannel = createRegularChannelState(0, shared, idwlShared, idsfShared, ghShared);
  baseChannel.block0 = baseChannel;
  baseChannel.idwlState.block0 = baseChannel.idwlState;
  baseChannel.idsfState.block0 = baseChannel.idsfState;
  baseChannel.idctState.block0 = baseChannel.idctState;
  baseChannel.gainState.block0 = baseChannel.gainState;
  baseChannel.ghState.block0 = baseChannel.ghState;

  const channels =
    channelCount === 1
      ? [baseChannel]
      : [
          baseChannel,
          createRegularChannelState(1, shared, idwlShared, idsfShared, ghShared, baseChannel),
        ];

  return {
    shared,
    blockErrorCode: 0,
    channels,
    idwlShared,
    idsfShared,
    ghShared,
  };
}
