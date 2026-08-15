/** Carta3 Audio Codec - Layered channel bitstream emission. */

import { writeResidualSymbols } from '../coding/residual.js'
import { AllocationWorkView } from '../coding/work.js'
import {
  PAIR_BLOCK_GAIN_COUNT_WORD,
  PAIR_BLOCK_GAIN_LEVEL_OFFSET,
} from '../core/constants.js'
import { BitCounter } from './bitstream.js'
import {
  IndependentChannelHeader,
  JointStereoHeader,
  SpectrumAllocation,
} from './syntax.js'

/** Bit sink implementing the layered channel's two-byte merge behavior. */
class LayerBitEmitter {
  /** Wrap a frame destination at an absolute starting bit position. */
  constructor(output, bitPosition) {
    this.output = output
    this.bitPosition = bitPosition
  }

  /** Write one value using the layered channel's two-byte merge behavior. */
  write(value, width) {
    const byteIndex = this.bitPosition >> 3
    const bitOffset = this.bitPosition & 7
    const shift = 16 - width - bitOffset
    const shifted = (value << (shift & 0x1f)) >>> 0
    if (byteIndex + 1 < this.output.length) {
      this.output[byteIndex + 1] = shifted & 0xff
      this.output[byteIndex] |= (shifted >>> 8) & 0xff
    } else if (byteIndex < this.output.length) {
      this.output[byteIndex] |= (shifted >>> 8) & 0xff
    }
    this.bitPosition += width
  }
}

/** Return the exact syntax cost of one pair-block gain record. */
function pairBlockGainBits(block) {
  return 3 + block[PAIR_BLOCK_GAIN_COUNT_WORD] * 9
}

/**
 * Count gain-control syntax for all active transform units.
 * @param {Uint32Array[]} pairBlocks Layer pair-block records.
 * @param {number} unitCount Number of active transform units.
 * @returns {number} Exact gain syntax cost in bits.
 */
export function countLayerGainBits(pairBlocks, unitCount) {
  let bits = 0
  for (let unit = 0; unit < unitCount; unit++) {
    bits += pairBlockGainBits(pairBlocks[unit])
  }
  return bits
}

/** Write gain syntax for every active transform unit. */
function writePairBlockGains(pairBlocks, unitCount, sink) {
  for (let unit = 0; unit < unitCount; unit++) {
    const block = pairBlocks[unit]
    const count = block[PAIR_BLOCK_GAIN_COUNT_WORD]
    sink.write(count, 3)
    for (let entry = 0; entry < count; entry++) {
      sink.write(block[PAIR_BLOCK_GAIN_LEVEL_OFFSET + entry], 4)
      sink.write(block[entry], 5)
    }
  }
}

/** Reinterpret residual spectrum words as a zero-copy Float32 view. */
function residualSpectrumView(words) {
  const allocation = new AllocationWorkView(words)
  const residual = allocation.residualSpectrum()
  if (!residual) return null
  return new Float32Array(residual.buffer, residual.byteOffset, residual.length)
}

/** Traverse one complete layered channel through an arbitrary bit sink. */
function writeLayeredChannel(
  layer,
  work,
  sink,
  { previousOutput = 0, gainSelectors = new Int32Array(4) } = {}
) {
  const allocation = new AllocationWorkView(work)
  const spectrum = residualSpectrumView(work)
  if (!spectrum) throw new RangeError('Missing ATRAC3 residual spectrum')
  const unitCount = allocation.unitCount
  if (layer.stereoFlag !== 0) {
    const header = JointStereoHeader.create(
      previousOutput,
      gainSelectors,
      (unitCount - 1) >>> 0
    )
    sink.write(header.first, 8)
    sink.write(header.second, 8)
  } else {
    IndependentChannelHeader.fromUnitCount(unitCount).pack(sink)
  }

  writePairBlockGains(layer.pairBlocks, unitCount, sink)
  if (allocation.toneRegionCount !== 0) {
    throw new RangeError('Layered ATRAC3 tone emission is not yet ported')
  }
  sink.write(0, 5)

  const bandCount = allocation.activeBandCount
  const modes = new Int32Array(32)
  const scaleFactors = new Int32Array(32)
  for (let band = 0; band < bandCount; band++) {
    modes[band] = allocation.mode(band)
    scaleFactors[band] = allocation.scaleFactor(band)
  }
  new SpectrumAllocation(bandCount, 0, modes, scaleFactors).pack(sink)
  for (let band = 0; band < bandCount; band++) {
    const mode = modes[band]
    if (mode !== 0) {
      writeResidualSymbols(spectrum, band, mode, scaleFactors[band], sink)
    }
  }
  return sink.bitPosition
}

/**
 * Count one layered channel exactly without constructing a frame image.
 * @param {object} layer Completed transformed layer state.
 * @param {Int32Array} work Completed allocation image.
 * @param {object} [options] Shared-layout header selectors.
 * @returns {number} Exact channel length in bits, starting at bit zero.
 */
export function countLayeredChannelBits(layer, work, options = {}) {
  return writeLayeredChannel(layer, work, new BitCounter(), options)
}

/**
 * Pack one layered channel. The caller owns frame clearing and atomic commit.
 * Tone syntax is currently rejected because the ported allocator emits none.
 *
 * @param {object} layer Completed transformed layer state.
 * @param {Int32Array} work Completed allocation image.
 * @param {number} outputOffsetBytes Byte-aligned frame destination offset.
 * @param {Uint8Array} output Caller-cleared complete frame image.
 * @param {object} [options] Shared-layout header and overflow options.
 * @returns {number} Absolute ending bit position in `output`.
 */
export function packLayeredChannel(
  layer,
  work,
  outputOffsetBytes,
  output,
  {
    previousOutput = 0,
    gainSelectors = new Int32Array(4),
    allowOverflow = false,
  } = {}
) {
  if (!Number.isInteger(outputOffsetBytes) || outputOffsetBytes < 0) {
    throw new RangeError('ATRAC3 layered output offset must be non-negative')
  }
  const headerBytes = layer.stereoFlag !== 0 ? 2 : 1
  if (outputOffsetBytes + headerBytes > output.length) {
    throw new RangeError('ATRAC3 layered channel header exceeds output')
  }
  const sink = new LayerBitEmitter(output, outputOffsetBytes * 8)
  const end = writeLayeredChannel(layer, work, sink, {
    previousOutput,
    gainSelectors,
  })
  if (!allowOverflow && end > output.length * 8) {
    throw new RangeError('ATRAC3 layered channel payload exceeds output')
  }
  return end
}
