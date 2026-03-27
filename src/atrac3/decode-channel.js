import {
  AT3_DEC_BLOCK_FLOATS,
  AT3_DEC_MAX_UNITS,
  AT3_DEC_NEUTRAL_GAIN,
  AT3_DEC_PAIR_SENTINEL_START,
} from "./constants.js";
import { rebuildAtrac3ChannelWorkArea } from "./decode-rebuild.js";
import { decodeAtrac3GroupedSpectrum } from "./decode-channel-spcode.js";
import {
  AT3_DEC_FLAG_ERROR,
  markAtrac3DecodeError,
  openAtrac3ChannelTransport,
  readAtrac3Bits,
} from "./decode-channel-transport.js";
import { decodeAtrac3TonePasses } from "./decode-channel-tone.js";

const EMPTY_ATRAC3_PAYLOAD_COVERAGE = Object.freeze({
  pairTableBlockCount: 0,
  spectrumBlockCount: 0,
  decodedBlockCount: 0,
});

function stageAtrac3PairTableSentinel(pairTable, pairCount) {
  pairTable[pairCount].start = AT3_DEC_PAIR_SENTINEL_START;
  pairTable[pairCount].gain = AT3_DEC_NEUTRAL_GAIN;
}

function decodeAtrac3GainPairUnit(state, pairTable) {
  const pairCount = readAtrac3Bits(state.bitstream, 3) & 7;

  for (let pair = 0; pair < pairCount; pair += 1) {
    const gain = readAtrac3Bits(state.bitstream, 4) & 0x0f;
    const start = (readAtrac3Bits(state.bitstream, 5) & 0x1f) << 3;
    if (pair !== 0 && start <= pairTable[pair - 1].start >>> 0) {
      markAtrac3DecodeError(state);
      break;
    }

    pairTable[pair].start = start >>> 0;
    pairTable[pair].gain = gain >>> 0;
  }

  stageAtrac3PairTableSentinel(pairTable, pairCount);
  return pairCount > 0;
}

function stageAtrac3InactiveGainPairTail(framePairTables, activeUnitCount) {
  for (let unit = activeUnitCount; unit < AT3_DEC_MAX_UNITS; unit += 1) {
    stageAtrac3PairTableSentinel(framePairTables[unit], 0);
  }
}

/**
 * Decodes the gain-ramp pair prelude for one ATRAC3 channel payload.
 *
 * Active 256-coefficient units read their staged gain-pair tables from the
 * bitstream first. Once that authored prelude ends, the inactive tail is
 * filled with neutral sentinels so the reconstruction path can treat every
 * unit table uniformly.
 *
 * @returns {number} Number of 256-coefficient units whose staged gain-pair
 *   table participates in the next rebuild span.
 */
export function stageAtrac3GainPairTables(state, framePairTables, activeUnitCount) {
  let stagedBlockCount = 0;

  for (let unit = 0; unit < activeUnitCount; unit += 1) {
    if (decodeAtrac3GainPairUnit(state, framePairTables[unit])) {
      stagedBlockCount = unit + 1;
    }
  }

  stageAtrac3InactiveGainPairTail(framePairTables, activeUnitCount);
  return stagedBlockCount;
}

function resolveAtrac3PayloadBlockCount(maxCoeffIndex) {
  return Math.ceil(maxCoeffIndex / AT3_DEC_BLOCK_FLOATS);
}

/**
 * Decodes the sparse spectral body that follows the ATRAC3 gain-pair prelude.
 *
 * This includes the optional tone-patch passes and the grouped non-tonal
 * spcodes that fill the remaining coefficient bands.
 */
function decodeAtrac3SparseSpectrumBlockCount(state, activeUnitCount, spectrum) {
  const toneMaxCoeffIndex = decodeAtrac3TonePasses(state, activeUnitCount, spectrum);
  if (toneMaxCoeffIndex === null) {
    return null;
  }

  const groupedMaxCoeffIndex = decodeAtrac3GroupedSpectrum(state, spectrum);
  return resolveAtrac3PayloadBlockCount(Math.max(toneMaxCoeffIndex, groupedMaxCoeffIndex));
}

/**
 * Decoded channel payload coverage for one ATRAC3 lane.
 *
 * @typedef {object} Atrac3ChannelPayloadDecodeResult
 * @property {number} pairTableBlockCount Number of staged gain-pair units that
 *   extend the rebuild span.
 * @property {number} spectrumBlockCount Number of decoded spectrum blocks
 *   covered by tone passes and grouped SPCODEs.
 * @property {number} decodedBlockCount Number of 256-coefficient transform
 *   blocks rebuilt from the decoded payload.
 */

/**
 * Decodes one ATRAC3 channel payload into pair tables and spectrum scratch.
 *
 * @param {object} state
 * @param {number} unitMode
 * @param {Float32Array} spectrum
 * @param {object[][]} framePairTables
 * @returns {Atrac3ChannelPayloadDecodeResult}
 */
export function decodeAtrac3ChannelPayload(state, unitMode, spectrum, framePairTables) {
  const activeUnitCount = unitMode + 1;
  const pairTableBlockCount = stageAtrac3GainPairTables(state, framePairTables, activeUnitCount);
  const spectrumBlockCount = decodeAtrac3SparseSpectrumBlockCount(state, activeUnitCount, spectrum);
  if (spectrumBlockCount === null) {
    return EMPTY_ATRAC3_PAYLOAD_COVERAGE;
  }

  return {
    pairTableBlockCount,
    spectrumBlockCount,
    decodedBlockCount: Math.max(pairTableBlockCount, spectrumBlockCount),
  };
}

/**
 * Decodes one ATRAC3 transport lane and rebuilds its overlap/add work area.
 *
 * @param {object} state
 * @param {object} channelState
 * @param {number} channelIndex
 * @returns {number}
 */
export function decodeAtrac3ChannelTransport(state, channelState, channelIndex) {
  const { bitstream, spectrumScratch } = state;
  const transportWindow = openAtrac3ChannelTransport(
    bitstream,
    channelIndex,
    channelState.transportMode
  );
  const unitMode = transportWindow.headerByte & 3;

  if (!transportWindow.headerIsValid) {
    markAtrac3DecodeError(state);
  }

  spectrumScratch.fill(0);
  if ((bitstream.flags & AT3_DEC_FLAG_ERROR) === 0) {
    // Decode the channel payload into one shared spectrum scratch buffer, then
    // rebuild the overlap/add state with the previous frame's active gain ramp
    // table while the freshly decoded ramp table stays staged for the next one.
    const payloadCoverage = decodeAtrac3ChannelPayload(
      state,
      unitMode,
      spectrumScratch,
      channelState.gainTables.staged
    );
    rebuildAtrac3ChannelWorkArea(channelState, spectrumScratch, payloadCoverage.decodedBlockCount);
  }

  if (bitstream.bitpos > transportWindow.bitLimit) {
    markAtrac3DecodeError(state);
  }

  return unitMode;
}
