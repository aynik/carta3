/**
 * ATRAC3 SCX encoder context construction, DBA calibration, and validation.
 */
import { CodecError } from "../../common/errors.js";
import {
  AT3_SCX_CONFIG_WORD,
  createScxChannelHistory,
  createScxChannelScratch,
} from "./channel-state.js";
import { createAt3ScxHuffTableSets } from "./huffman.js";
import { spectrumOffsetForQuantBandAt3 } from "./tables.js";

const AT3_SCX_BITRATE_KBPS = 0x84;
const AT3_SCX_ENC_MODE_FLAG = 1;
const AT3_SCX_FRAME_BYTES = 0x180;
const AT3_SCX_WORK_SIZE = 0x3afc;
const AT3_SCX_CHANNELS = 2;
const AT3_SCX_SAMPLE_RATE_HZ = 44100;

const AT3_DBA_Q_SHIFT = 11;
const AT3_DBA_Q_SCALE = 1 << AT3_DBA_Q_SHIFT;
const AT3_DBA_MAX_IQT_INDEX = 0x1f;
const AT3_DBA_ROUND_BIAS = 0xff;
const AT3_DBA_ROUND_SCALE = 1 << 8;

/**
 * SCX DBA-derived limits cached on each rotating channel state.
 *
 * The SCX context owns this calibration because channel-history construction
 * immediately derives `specGroupCount` and `componentGroupCount` from it.
 *
 * @typedef {object} Atrac3ScxDbaState
 * @property {number} value
 * @property {number} scaledQ11OverRate
 * @property {number} iqtIndexPlus1
 * @property {number} scaledQ11CeilQ8
 */

/**
 * One rotating ATRAC3 SCX per-channel encoder state.
 *
 * @typedef {object} Atrac3ScxChannelState
 * @property {number} channelIndex
 * @property {Atrac3ScxChannelState | null} prevState
 * @property {{
 *   limit: number,
 *   queuedLimit: number,
 *   activeWords: Uint32Array,
 *   queuedWords: Uint32Array,
 * }} config
 * @property {Atrac3ScxDbaState} dba
 * @property {object} globalState
 * @property {object[]} gaincParams
 * @property {object[]} mddataEntries
 * @property {object[]} tonePool
 * @property {Int32Array} idwl
 * @property {Int32Array} quidsf
 * @property {Int32Array} quantSpecs
 */

/**
 * The SCX encoder rotates one active channel state and one recycled channel
 * state per channel. The previous frame remains reachable from
 * `current.prevState`, so the runtime only needs this two-entry ring.
 *
 * @typedef {object} Atrac3ScxChannelHistory
 * @property {Atrac3ScxChannelState} current Active channel state for the frame being encoded.
 * @property {Atrac3ScxChannelState} recycled Cleared channel state reused for the next frame.
 */

/**
 * Package-private ATRAC3 SCX runtime context.
 *
 * The public SCX wrapper and focused low-level tests both work against this
 * object: top-level transport fields describe the fixed 132 kbps stream, while
 * `state` owns the rotating channel histories, Huffman sets, and per-channel
 * time2freq scratch reused across frames.
 *
 * @typedef {object} Atrac3ScxEncoderContext
 * @property {number} channels
 * @property {number} initFlag
 * @property {number} lastFrameBytes
 * @property {number} frameBytes
 * @property {Uint32Array} configWords
 * @property {Uint32Array} workSizes
 * @property {Int32Array} pcmLenHistory
 * @property {{
 *   sampleRateHz: number,
 *   channelCount: number,
 *   time2freqMode: number,
 *   encodeMode: number,
 *   frameBytes: number,
 *   outputOffset: number,
 *   huffman: { pair: object, scalar: object },
 *   channelHistories: Atrac3ScxChannelHistory[],
 *   channelScratch: object[],
 * }} state
 */

function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new CodecError(`${name} must be an integer`);
  }
  return value;
}

/** Creates one zeroed SCX DBA calibration record. */
export function createAt3DbaState() {
  return {
    value: 0,
    scaledQ11OverRate: 0,
    iqtIndexPlus1: 0,
    scaledQ11CeilQ8: 0,
  };
}

/**
 * Resolves the SCX DBA-derived quant-band and component-group limits cached on
 * each rotating channel state.
 *
 * @param {number} sampleRateHz
 * @param {number} value
 * @param {Atrac3ScxDbaState} [state]
 * @returns {Atrac3ScxDbaState}
 */
export function initDbaAt3(sampleRateHz, value, state = createAt3DbaState()) {
  const sampleRate = assertInteger(sampleRateHz, "sampleRateHz");
  if (sampleRate <= 0) {
    throw new CodecError("sampleRateHz must be > 0");
  }

  const dbaValue = assertInteger(value, "value");
  state.value = dbaValue;
  state.scaledQ11OverRate = 0;
  state.iqtIndexPlus1 = 0;
  state.scaledQ11CeilQ8 = 0;

  if (dbaValue <= 0) {
    return state;
  }

  state.scaledQ11OverRate = Math.trunc((dbaValue * AT3_DBA_Q_SCALE) / sampleRate);
  state.iqtIndexPlus1 = 1;
  while (
    state.iqtIndexPlus1 <= AT3_DBA_MAX_IQT_INDEX &&
    spectrumOffsetForQuantBandAt3(state.iqtIndexPlus1) < state.scaledQ11OverRate
  ) {
    state.iqtIndexPlus1 += 1;
  }

  state.scaledQ11CeilQ8 = Math.trunc(
    (state.scaledQ11OverRate + AT3_DBA_ROUND_BIAS) / AT3_DBA_ROUND_SCALE
  );
  return state;
}

/**
 * Creates the fixed stereo SCX runtime used by the 132 kbps ATRAC3 path.
 *
 * @param {number} [bitrateKbps=132]
 * @param {number} [modeFlag=1]
 * @returns {Atrac3ScxEncoderContext}
 */
export function createAtrac3ScxEncoderContext(
  bitrateKbps = AT3_SCX_BITRATE_KBPS,
  modeFlag = AT3_SCX_ENC_MODE_FLAG
) {
  if (bitrateKbps !== AT3_SCX_BITRATE_KBPS || modeFlag !== AT3_SCX_ENC_MODE_FLAG) {
    throw new CodecError(
      `unsupported ATRAC3 SCX encoder config: bitrate=${bitrateKbps} mode=${modeFlag}`
    );
  }

  const huffTables = createAt3ScxHuffTableSets();
  const encoderState = {
    sampleRateHz: AT3_SCX_SAMPLE_RATE_HZ,
    channelCount: AT3_SCX_CHANNELS,
    time2freqMode: modeFlag,
    encodeMode: 0,
    frameBytes: AT3_SCX_FRAME_BYTES,
    outputOffset: 0,
    huffman: {
      pair: huffTables.huffTablesA,
      scalar: huffTables.huffTablesB,
    },
    channelHistories: [],
    channelScratch: Array.from({ length: AT3_SCX_CHANNELS }, createScxChannelScratch),
  };
  const dba = initDbaAt3(AT3_SCX_SAMPLE_RATE_HZ, AT3_SCX_WORK_SIZE, createAt3DbaState());
  encoderState.channelHistories = Array.from({ length: AT3_SCX_CHANNELS }, (_, channelIndex) =>
    createScxChannelHistory(channelIndex, encoderState, dba)
  );

  return {
    channels: AT3_SCX_CHANNELS,
    initFlag: 1,
    lastFrameBytes: AT3_SCX_FRAME_BYTES,
    state: encoderState,
    frameBytes: AT3_SCX_FRAME_BYTES,
    configWords: new Uint32Array([AT3_SCX_CONFIG_WORD, AT3_SCX_CONFIG_WORD]),
    workSizes: new Uint32Array([AT3_SCX_WORK_SIZE, AT3_SCX_WORK_SIZE]),
    pcmLenHistory: new Int32Array([1024, 1024, 1024]),
  };
}

/**
 * Identifies a reusable raw ATRAC3 SCX encoder context.
 *
 * Wrapper runtimes keep this object under `runtime.encoderContext`, while low-
 * level callers may pass it directly when resuming an existing stream.
 *
 * @param {unknown} context
 * @returns {context is Atrac3ScxEncoderContext}
 */
export function isAtrac3ScxEncoderContext(context) {
  const encoderState = context?.state;
  const channelHistories = encoderState?.channelHistories;
  return (
    context &&
    typeof context === "object" &&
    context.frameBytes === AT3_SCX_FRAME_BYTES &&
    context.pcmLenHistory instanceof Int32Array &&
    context.pcmLenHistory.length >= 3 &&
    encoderState &&
    typeof encoderState === "object" &&
    encoderState.channelCount === AT3_SCX_CHANNELS &&
    Array.isArray(channelHistories) &&
    channelHistories.length >= AT3_SCX_CHANNELS &&
    channelHistories
      .slice(0, AT3_SCX_CHANNELS)
      .every((history) => history?.current && history?.recycled) &&
    Array.isArray(encoderState.channelScratch) &&
    encoderState.channelScratch.length >= AT3_SCX_CHANNELS
  );
}
