/**
 * ATRAC3 SCX gain-control metadata is stored in a 16-word block:
 * word 0 holds the entry count, words 1..7 hold end-band positions,
 * and words 8..14 hold gain ids. `maxFirst` tracks the strongest peak
 * in the first half-window for repeat-gain planning.
 */
import { CodecError } from "../../common/errors.js";

export const AT3_GAIN_CONTROL_BLOCK_WORDS = 16;
export const AT3_GAIN_CONTROL_ENTRY_LIMIT = 7;
export const AT3_GAIN_CONTROL_COUNT_INDEX = 0;
const AT3_GAIN_CONTROL_END_BASE = 1;
const AT3_GAIN_CONTROL_GAIN_ID_BASE = 8;
const AT3_ATTACK_GAIN_BASELINE = 4;
const AT3_ATTACK_GAIN_SPREAD_THRESHOLD = 3;

/**
 * One mutable SCX gain-control block.
 *
 * `words` stays packed in the authored 16-word transport layout. `maxFirst`
 * is analysis-only metadata used while planning repeat-gain carryover and is
 * intentionally kept outside that packed word view.
 *
 * @typedef {object} At3GainControlBlock
 * @property {Uint32Array} words
 * @property {number} maxFirst
 */

function isAt3GainControlBlock(block) {
  return (
    block &&
    typeof block === "object" &&
    block.words instanceof Uint32Array &&
    block.words.length >= AT3_GAIN_CONTROL_BLOCK_WORDS
  );
}

export function getAt3GainControlWords(block) {
  if (isAt3GainControlBlock(block)) {
    return block.words;
  }
  if (ArrayBuffer.isView(block) || Array.isArray(block)) {
    return block;
  }
  throw new CodecError("block must be an array-like numeric buffer");
}

export function createAt3GainControlBlock() {
  return {
    words: new Uint32Array(AT3_GAIN_CONTROL_BLOCK_WORDS),
    maxFirst: 0,
  };
}

export function createAt3GainControlBlocks(count) {
  return Array.from({ length: count }, createAt3GainControlBlock);
}

export function clearAt3GainControlBlock(block) {
  const gainControlBlock = isAt3GainControlBlock(block) ? block : null;
  if (!gainControlBlock) {
    throw new CodecError("block must be an ATRAC3 SCX gain-control block");
  }

  gainControlBlock.words.fill(0);
  gainControlBlock.maxFirst = 0;
  return gainControlBlock;
}

export function getAt3GainControlCount(block) {
  return getAt3GainControlWords(block)[AT3_GAIN_CONTROL_COUNT_INDEX] | 0;
}

export function setAt3GainControlCount(block, count) {
  getAt3GainControlWords(block)[AT3_GAIN_CONTROL_COUNT_INDEX] = count >>> 0;
}

export function hasAt3GainControl(block) {
  return getAt3GainControlCount(block) !== 0;
}

export function at3GainControlEndIndex(entryIndex) {
  return AT3_GAIN_CONTROL_END_BASE + entryIndex;
}

export function getAt3GainControlEnd(block, entryIndex) {
  return getAt3GainControlWords(block)[at3GainControlEndIndex(entryIndex)] | 0;
}

export function setAt3GainControlEnd(block, entryIndex, end) {
  getAt3GainControlWords(block)[at3GainControlEndIndex(entryIndex)] = end >>> 0;
}

export function at3GainControlGainIdIndex(entryIndex) {
  return AT3_GAIN_CONTROL_GAIN_ID_BASE + entryIndex;
}

export function getAt3GainControlGainId(block, entryIndex) {
  return getAt3GainControlWords(block)[at3GainControlGainIdIndex(entryIndex)] | 0;
}

export function setAt3GainControlGainId(block, entryIndex, gainId) {
  getAt3GainControlWords(block)[at3GainControlGainIdIndex(entryIndex)] = gainId >>> 0;
}

export function setAt3GainControlEntry(block, entryIndex, end, gainId) {
  setAt3GainControlEnd(block, entryIndex, end);
  setAt3GainControlGainId(block, entryIndex, gainId);
}

export function getAt3GainControlMaxFirst(block) {
  return isAt3GainControlBlock(block) ? block.maxFirst : 0;
}

export function setAt3GainControlMaxFirst(block, maxFirst) {
  if (!isAt3GainControlBlock(block)) {
    throw new CodecError("block must be an ATRAC3 SCX gain-control block");
  }
  block.maxFirst = maxFirst;
}

export function isAt3GainControlAttack(block) {
  const gainControlWords = getAt3GainControlWords(block);
  const count = getAt3GainControlCount(gainControlWords);
  let maxGainId = AT3_ATTACK_GAIN_BASELINE;
  let minGainId = AT3_ATTACK_GAIN_BASELINE;

  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const gainId = getAt3GainControlGainId(gainControlWords, entryIndex);
    if (gainId > maxGainId) {
      maxGainId = gainId;
    }
    if (gainId < minGainId) {
      minGainId = gainId;
    }
  }

  return maxGainId - minGainId >= AT3_ATTACK_GAIN_SPREAD_THRESHOLD ? 1 : 0;
}
