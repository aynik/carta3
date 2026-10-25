/**
 * Carta3 Audio Codec - Bitstream Operations
 *
 * This module provides low-level bitstream packing and unpacking operations
 * for reading and writing ATRAC bitstreams with bit-level precision.
 */

/**
 * Reject field widths outside the shared bitstream primitive's safe range.
 *
 * @param {number} bitCount
 * @returns {void}
 */
function assertBitCount(bitCount) {
  if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
    throw new RangeError(
      `Bit count must be an integer in 0..32, got ${bitCount}`
    )
  }
}

/** Reusable MSB-first writer used by ATRAC3 syntax objects. */
export class BitWriter {
  /**
   * Wrap a destination buffer at an optional initial bit position.
   *
   * @param {Uint8Array} buffer Caller-owned destination bytes.
   * @param {number} [bitPosition] Initial absolute bit position.
   */
  constructor(buffer, bitPosition = 0) {
    this.buffer = buffer
    this.bitPosition = bitPosition
  }

  /**
   * Write one unsigned value in MSB-first order.
   *
   * @param {number} value Unsigned low-bit field to write.
   * @param {number} bitCount Field width from zero through 32.
   * @returns {void}
   */
  write(value, bitCount) {
    assertBitCount(bitCount)
    const position = this.bitPosition
    if (position < 0 || position + bitCount > this.buffer.length * 8) {
      throw new RangeError('Bit write exceeds destination buffer')
    }
    packBits(this.buffer, position, value, bitCount)
    this.bitPosition = position + bitCount
  }
}

/** Destination-free syntax sink used for exact bit accounting. */
export class BitCounter {
  /**
   * Start exact accounting at an optional existing bit position.
   *
   * @param {number} [bitPosition] Initial absolute bit position.
   */
  constructor(bitPosition = 0) {
    this.bitPosition = bitPosition
  }

  /**
   * Account for one write without materializing destination bytes.
   *
   * @param {number} _value Ignored value accepted for writer compatibility.
   * @param {number} bitCount Field width from zero through 32.
   * @returns {void}
   */
  write(_value, bitCount) {
    assertBitCount(bitCount)
    const position = this.bitPosition
    this.bitPosition = position + bitCount
  }
}

/** Reusable zero-padded MSB-first reader used by ATRAC3 syntax objects. */
export class BitReader {
  /**
   * Wrap a zero-padded source at an optional initial bit position.
   *
   * @param {Uint8Array} buffer Source bytes with required over-read padding.
   * @param {number} [bitPosition] Initial absolute bit position.
   */
  constructor(buffer, bitPosition = 0) {
    this.buffer = buffer
    this.bitPosition = bitPosition
  }

  /**
   * Read one unsigned MSB-first value.
   *
   * @param {number} bitCount Field width from zero through 32.
   * @returns {number} Unsigned decoded field.
   */
  read(bitCount) {
    if (bitCount === 1) {
      /** @type {i32} */
      const position = this.bitPosition
      /** @type {Uint8Array} */
      const buffer = this.buffer
      const value = (buffer[position >> 3] >>> (7 - (position & 7))) & 1
      this.bitPosition = position + 1
      return value
    }
    const position = this.bitPosition
    const value = unpackBits(this.buffer, position, bitCount)
    this.bitPosition = position + bitCount
    return value
  }

  /**
   * Read and sign-extend one two's-complement value.
   *
   * @param {number} bitCount Field width from zero through 32.
   * @returns {number} Signed decoded field.
   */
  readSigned(bitCount) {
    const position = this.bitPosition
    const value = unpackSignedBits(this.buffer, position, bitCount)
    this.bitPosition = position + bitCount
    return value
  }
}

/**
 * Pack bits into a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Destination buffer
 * @param {i32} bitPosition - Bit position to start writing at
 * @param {number} value - Value to pack
 * @param {number} bitCount - Number of bits to pack
 * @returns {void}
 * @nativeUnchecked Callers use nonnegative bit positions; the byte loop
 * checks its upper bound.
 */
export function packBits(buffer, bitPosition, value, bitCount) {
  assertBitCount(bitCount)
  if (bitCount === 0) return

  const width = bitCount | 0
  const byteLength = buffer.length
  let byteIndex = bitPosition >> 3
  let bitOffset = bitPosition & 7

  const signedValue = Number(value) | 0

  let bitsWritten = 0
  while (bitsWritten < width && byteIndex < byteLength) {
    const bitsAvailable = 8 - bitOffset
    const bitsToWrite = Math.min(width - bitsWritten, bitsAvailable)

    const shift = width - bitsWritten - bitsToWrite
    const valueBits = (signedValue >>> shift) & ((1 << bitsToWrite) - 1)

    const mask = ((1 << bitsToWrite) - 1) << (bitsAvailable - bitsToWrite)
    buffer[byteIndex] =
      (buffer[byteIndex] & ~mask) | (valueBits << (bitsAvailable - bitsToWrite))

    bitsWritten += bitsToWrite
    byteIndex++
    bitOffset = 0
  }
}

/**
 * Unpack bits from a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Source buffer
 * @param {i32} bitPosition - Bit position to start reading from
 * @param {number} bitCount - Number of bits to unpack
 * @returns {number} Unpacked unsigned value
 * @nativeUnchecked Callers use nonnegative bit positions; the byte loop
 * checks its upper bound.
 */
export function unpackBits(buffer, bitPosition, bitCount) {
  assertBitCount(bitCount)
  if (bitCount === 0) return 0

  const width = bitCount | 0
  const byteLength = buffer.length
  let byteIndex = bitPosition >> 3
  let bitOffset = bitPosition & 7
  let value = 0

  for (let bitsRead = 0; bitsRead < width && byteIndex < byteLength;) {
    const bitsAvailable = 8 - bitOffset
    const bitsToRead = Math.min(width - bitsRead, bitsAvailable)

    const mask = (1 << bitsToRead) - 1
    const bits = (buffer[byteIndex] >> (bitsAvailable - bitsToRead)) & mask

    value = (value << bitsToRead) | bits
    bitsRead += bitsToRead
    byteIndex++
    bitOffset = 0
  }

  return value >>> 0
}

/**
 * Unpack signed bits from a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Source buffer
 * @param {i32} bitPosition - Bit position to start reading from
 * @param {number} bitCount - Number of bits to unpack
 * @returns {number} Unpacked signed value (two's complement)
 */
export function unpackSignedBits(buffer, bitPosition, bitCount) {
  assertBitCount(bitCount)
  if (bitCount === 0) return 0
  const value = unpackBits(buffer, bitPosition, bitCount)
  const signBit = 2 ** (bitCount - 1)
  return value >= signBit ? value - 2 ** bitCount : value
}
