import { ATRAC3_TRANSPORT_SWAPPED_TAIL } from "./profiles.js";

export const AT3_DEC_FLAG_ERROR = 0x2;
export const AT3_SPCODE_ERROR_FLAG = AT3_DEC_FLAG_ERROR;

const AT3_DEC_CHANNEL_HEADER_BITS = 0x10;
const AT3_DEC_PRIMARY_HEADER_MASK = 0xfc;
const AT3_DEC_PRIMARY_HEADER_VALUE = 0xa0;
const AT3_DEC_SWAPPED_HEADER_INDEX = 1;
const AT3_DEC_SWAPPED_HEADER_MASK = 0x0c;
const AT3_DEC_SWAPPED_HEADER_VALUE = 0x0c;
const AT3_DEC_SWAP_PADDING_BYTE = 0xf8;

/** Reads an arbitrary bit window without advancing the ATRAC3 channel cursor. */
export function peekAtrac3Bits(stream, bitpos, bits) {
  const width = bits | 0;
  if (width <= 0) {
    return 0;
  }
  if (width > 32) {
    throw new RangeError(`ATRAC3 bitstream peek width must be <= 32 (got ${width})`);
  }

  const pos = bitpos >>> 0;
  const byteIndex = pos >>> 3;
  const bitOffset = pos & 7;
  const requiredBytes = ((bitOffset + width + 7) >>> 3) >>> 0;
  if (byteIndex + requiredBytes > stream.length) {
    throw new RangeError("ATRAC3 bitstream peek exceeds buffer length");
  }

  if (width <= 16 && requiredBytes <= 2) {
    const b0 = stream[byteIndex];
    const b1 = requiredBytes > 1 ? stream[byteIndex + 1] : 0;
    const word = ((b0 << 8) | b1) >>> 0;
    const shift = 16 - width - bitOffset;
    const mask = (1 << width) - 1;
    return (word >>> shift) & mask;
  }

  let accum = 0n;
  for (let i = 0; i < requiredBytes; i += 1) {
    accum = (accum << 8n) | BigInt(stream[byteIndex + i]);
  }
  const totalBits = requiredBytes * 8;
  const shift = BigInt(totalBits - width - bitOffset);
  const mask = (1n << BigInt(width)) - 1n;
  return Number((accum >> shift) & mask);
}

/** Reads one ATRAC3 channel bitfield and advances the channel cursor. */
export function readAtrac3Bits(bitstream, bits) {
  const width = bits | 0;
  if (width <= 0) {
    return 0;
  }

  const flags = bitstream.flags ?? 0;

  const bitpos = bitstream.bitpos >>> 0;
  const nextPos = bitpos + width;
  if (width > 32) {
    bitstream.flags = flags | AT3_DEC_FLAG_ERROR;
    bitstream.bitpos = nextPos;
    return 0;
  }
  const bitLimit = bitstream.bitLimit ?? Infinity;
  if (nextPos > bitLimit) {
    bitstream.flags = flags | AT3_DEC_FLAG_ERROR;
    bitstream.bitpos = nextPos;
    return 0;
  }

  const stream = bitstream.stream;
  const byteIndex = bitpos >>> 3;
  const bitOffset = bitpos & 7;
  const requiredBytes = ((bitOffset + width + 7) >>> 3) >>> 0;
  if (byteIndex + requiredBytes > stream.length) {
    bitstream.flags = flags | AT3_DEC_FLAG_ERROR;
    bitstream.bitpos = nextPos;
    return 0;
  }

  const value = peekAtrac3Bits(stream, bitpos, width);
  bitstream.bitpos = nextPos;
  return value;
}

/**
 * Marks the current ATRAC3 frame decode as failed through the shared sticky
 * bitstream flag.
 */
export function markAtrac3DecodeError(state) {
  // Frame decode reports failure through one sticky flag, not per-site detail.
  state.bitstream.flags |= AT3_DEC_FLAG_ERROR;
}

/**
 * Opened ATRAC3 transport window for one channel payload.
 *
 * @typedef {object} Atrac3ChannelTransport
 * @property {number} headerByte
 * @property {number} bitLimit
 * @property {boolean} headerIsValid
 */

/** Opens one ATRAC3 channel payload according to the selected transport mode. */
export function openAtrac3ChannelTransport(bitstream, channelIndex, transportMode) {
  const baseStream = bitstream.baseStream ?? bitstream.stream;
  const { stepBytes } = bitstream;
  let headerByte;
  let bitLimit;
  let headerMask;
  let headerValue;

  if (transportMode === ATRAC3_TRANSPORT_SWAPPED_TAIL) {
    const payloadStartByte = (bitstream.bitpos + 7) >>> 3;
    let payloadEndByte = stepBytes - 1;
    while (payloadEndByte > 0 && baseStream[payloadEndByte] === AT3_DEC_SWAP_PADDING_BYTE) {
      payloadEndByte -= 1;
    }

    const reopenedPrefixBytes = payloadEndByte + 1;
    const payloadBytes = reopenedPrefixBytes - payloadStartByte;
    headerByte = baseStream[payloadEndByte - AT3_DEC_SWAPPED_HEADER_INDEX];
    bitLimit = payloadBytes * 8 + AT3_DEC_CHANNEL_HEADER_BITS;
    headerMask = AT3_DEC_SWAPPED_HEADER_MASK;
    headerValue = AT3_DEC_SWAPPED_HEADER_VALUE;

    // Low-bitrate stereo stores the secondary lane as a reversed tail payload.
    // The current cursor only changes how much of that reversed prefix remains
    // readable after the header reopens at byte 1.
    const swappedStream =
      bitstream.swappedStream && bitstream.swappedStream.length >= baseStream.length
        ? bitstream.swappedStream
        : new Uint8Array(baseStream.length);
    swappedStream.set(baseStream);
    swappedStream.subarray(0, reopenedPrefixBytes).reverse();
    bitstream.baseStream ??= baseStream;
    bitstream.swappedStream = swappedStream;
    bitstream.stream = swappedStream;
    bitstream.bitpos = AT3_DEC_CHANNEL_HEADER_BITS;
    bitstream.bitLimit = bitLimit;
  } else {
    bitstream.baseStream ??= baseStream;
    bitstream.stream = baseStream;
    const channelStartByte = channelIndex * stepBytes;
    headerByte = baseStream[channelStartByte];
    bitLimit = ((channelStartByte + stepBytes) << 3) + AT3_DEC_CHANNEL_HEADER_BITS;
    headerMask = AT3_DEC_PRIMARY_HEADER_MASK;
    headerValue = AT3_DEC_PRIMARY_HEADER_VALUE;
    bitstream.bitpos = (channelStartByte << 3) + 8;
    bitstream.bitLimit = bitLimit;
  }

  return {
    headerByte,
    bitLimit,
    headerIsValid: (headerByte & headerMask) === headerValue,
  };
}
