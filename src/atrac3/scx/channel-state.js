/**
 * ATRAC3 SCX rotating channel-state and scratch allocation.
 */
import { createAt3GainControlBlocks } from "./gainc-layout.js";
import {
  createAt3Time2freqTable,
  getAt3Time2freqMdctBlocks,
  getAt3Time2freqNoGainScratch,
} from "./time2freq.js";

export const AT3_SCX_CONFIG_WORD = 0xc0;

const AT3_SCX_FRAME_SAMPLES = 1024;
const AT3_TIME2FREQ_BLOCKS = 4;
const AT3_MDDATA_MAX_BANDS = 32;
const AT3_MDDATA_SPEC_GROUPS = 0x100;
const AT3_MDDATA_ENTRY_POOL_COUNT = 31;
const AT3_MDDATA_GROUP_FLAGS = 4;
const AT3_MDDATA_MAX_OUTER = 16;
const AT3_MDDATA_MAX_LISTS = 7;
const AT3_TONE_POOL_COUNT = 64;
const AT3_DEFAULT_CONFIG_WORD = 3;
const AT3_DEFAULT_CONFIG_LIMIT = 0x0f;

function createMddataEntry() {
  return {
    huffTableBaseIndex: 0,
    twiddleId: 0,
    huffTableSetIndex: 0,
    groupFlags: new Int32Array(AT3_MDDATA_GROUP_FLAGS),
    listCounts: new Int32Array(AT3_MDDATA_MAX_OUTER),
    lists: Array.from(
      { length: AT3_MDDATA_MAX_OUTER },
      () => new Uint32Array(AT3_MDDATA_MAX_LISTS)
    ),
  };
}

function createTonePoolEntry() {
  return {
    start: 0,
    scaleFactorIndex: 0,
    coefficients: new Int32Array(8),
    twiddleId: 0,
    huffTableBaseIndex: 0,
    huffTableSetIndex: 0,
  };
}

export function createScxChannelScratch() {
  const time2freq = createAt3Time2freqTable();

  return {
    spectra: new Float32Array(AT3_SCX_FRAME_SAMPLES),
    transformed: new Float32Array(AT3_SCX_FRAME_SAMPLES),
    time2freq,
    mdctBlocks: getAt3Time2freqMdctBlocks(time2freq),
    noGainScratch: getAt3Time2freqNoGainScratch(time2freq),
  };
}

function createScxChannelState(channelIndex, globalState, dba) {
  const activeWords = new Uint32Array(AT3_TIME2FREQ_BLOCKS).fill(AT3_DEFAULT_CONFIG_WORD);

  return {
    specGroupCount: dba.iqtIndexPlus1,
    componentGroupCount: dba.scaledQ11CeilQ8,
    componentMode: 0,
    specTableIndex: 0,
    mddataEntryIndex: 0,
    toneCount: 0,
    scratchFlag: 0,
    config: {
      limit: AT3_DEFAULT_CONFIG_LIMIT,
      queuedLimit: AT3_DEFAULT_CONFIG_LIMIT,
      activeWords,
      queuedWords: new Uint32Array(activeWords),
    },
    unitBytes: AT3_SCX_CONFIG_WORD,
    packedNbytes: 0,
    prevState: null,
    dba: {
      value: dba.value,
      scaledQ11OverRate: dba.scaledQ11OverRate,
      iqtIndexPlus1: dba.iqtIndexPlus1,
      scaledQ11CeilQ8: dba.scaledQ11CeilQ8,
    },
    channelIndex,
    globalState,
    gaincParams: createAt3GainControlBlocks(AT3_TIME2FREQ_BLOCKS),
    mddataEntries: Array.from({ length: AT3_MDDATA_ENTRY_POOL_COUNT }, createMddataEntry),
    tonePool: Array.from({ length: AT3_TONE_POOL_COUNT }, createTonePoolEntry),
    idwl: new Int32Array(AT3_MDDATA_MAX_BANDS),
    quidsf: new Int32Array(AT3_MDDATA_MAX_BANDS),
    quantSpecs: new Int32Array(AT3_MDDATA_SPEC_GROUPS * 4),
  };
}

/**
 * The SCX runtime keeps one active and one recycled channel state per lane,
 * with `current.prevState` pointing at the previous frame snapshot.
 */
export function createScxChannelHistory(channelIndex, globalState, dba) {
  const previous = createScxChannelState(channelIndex, globalState, dba);
  const current = createScxChannelState(channelIndex, globalState, dba);
  const recycled = createScxChannelState(channelIndex, globalState, dba);

  current.prevState = previous;
  previous.prevState = previous;
  recycled.prevState = previous;

  return { current, recycled };
}
