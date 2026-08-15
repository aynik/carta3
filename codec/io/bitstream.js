/**
 * Carta3 Audio Codec - Bitstream Operations
 *
 * This module provides low-level bitstream packing and unpacking operations
 * for reading and writing ATRAC bitstreams with bit-level precision.
 *
 * @param {number} bitCount
 */

function assertBitCount(bitCount) {
  if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
    throw new RangeError(
      `Bit count must be an integer in 0..32, got ${bitCount}`
    )
  }
}

export { reverseLowBits } from '../utils.js'

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
    if (
      this.bitPosition < 0 ||
      this.bitPosition + bitCount > this.buffer.length * 8
    ) {
      throw new RangeError('Bit write exceeds destination buffer')
    }
    packBits(this.buffer, this.bitPosition, value, bitCount)
    this.bitPosition += bitCount
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
    this.bitPosition += bitCount
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
    const value = unpackBits(this.buffer, this.bitPosition, bitCount)
    this.bitPosition += bitCount
    return value
  }

  /**
   * Read and sign-extend one two's-complement value.
   *
   * @param {number} bitCount Field width from zero through 32.
   * @returns {number} Signed decoded field.
   */
  readSigned(bitCount) {
    const value = unpackSignedBits(this.buffer, this.bitPosition, bitCount)
    this.bitPosition += bitCount
    return value
  }
}

/**
 * Pack bits into a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Destination buffer
 * @param {number} bitPosition - Bit position to start writing at
 * @param {number} value - Value to pack
 * @param {number} bitCount - Number of bits to pack
 * @returns {void}
 */
export function packBits(buffer, bitPosition, value, bitCount) {
  assertBitCount(bitCount)
  if (bitCount === 0) return

  let byteIndex = Math.floor(bitPosition / 8)
  let bitOffset = bitPosition % 8

  const unsignedValue = Number(value) >>> 0

  let bitsWritten = 0
  while (bitsWritten < bitCount && byteIndex < buffer.length) {
    const bitsAvailable = 8 - bitOffset
    const bitsToWrite = Math.min(bitCount - bitsWritten, bitsAvailable)

    const shift = bitCount - bitsWritten - bitsToWrite
    const valueBits = (unsignedValue >>> shift) & (2 ** bitsToWrite - 1)

    const mask = (2 ** bitsToWrite - 1) << (bitsAvailable - bitsToWrite)
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
 * @param {number} bitPosition - Bit position to start reading from
 * @param {number} bitCount - Number of bits to unpack
 * @returns {number} Unpacked unsigned value
 */
export function unpackBits(buffer, bitPosition, bitCount) {
  assertBitCount(bitCount)
  if (bitCount === 0) return 0

  let byteIndex = Math.floor(bitPosition / 8)
  let bitOffset = bitPosition % 8
  let value = 0

  for (let bitsRead = 0; bitsRead < bitCount && byteIndex < buffer.length;) {
    const bitsAvailable = 8 - bitOffset
    const bitsToRead = Math.min(bitCount - bitsRead, bitsAvailable)

    const mask = 2 ** bitsToRead - 1
    const bits = (buffer[byteIndex] >> (bitsAvailable - bitsToRead)) & mask

    value = (value * 2 ** bitsToRead + bits) >>> 0
    bitsRead += bitsToRead
    byteIndex++
    bitOffset = 0
  }

  return value
}

/**
 * Unpack signed bits from a buffer at a specific bit position
 *
 * @param {Uint8Array} buffer - Source buffer
 * @param {number} bitPosition - Bit position to start reading from
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
