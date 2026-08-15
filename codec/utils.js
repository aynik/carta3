/** Carta3 Audio Codec - Shared numerical and composition helpers. */

const numericBits = new DataView(new ArrayBuffer(8))

/**
 * Add two values and round the result to IEEE-754 float32 precision.
 *
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
export function float32Add(left, right) {
  return Math.fround(left + right)
}

/**
 * Subtract two values and round the result to IEEE-754 float32 precision.
 *
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
export function float32Subtract(left, right) {
  return Math.fround(left - right)
}

/**
 * Multiply two values and round the result to IEEE-754 float32 precision.
 *
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
export function float32Multiply(left, right) {
  return Math.fround(left * right)
}

/**
 * Reinterpret one unsigned 32-bit word as an IEEE-754 float32 value.
 *
 * @param {number} bits
 * @returns {number}
 */
export function float32FromBits(bits) {
  numericBits.setUint32(0, bits, true)
  return numericBits.getFloat32(0, true)
}

/**
 * Reinterpret one float32-rounded value as an unsigned 32-bit word.
 *
 * @param {number} value
 * @returns {number}
 */
export function float32ToBits(value) {
  numericBits.setFloat32(0, value, true)
  return numericBits.getUint32(0, true)
}

/**
 * Reinterpret one unsigned 64-bit word as an IEEE-754 float64 value.
 *
 * @param {number} bits
 * @returns {number}
 */
export function float64FromBits(bits) {
  numericBits.setBigUint64(0, BigInt(bits), true)
  return numericBits.getFloat64(0, true)
}

/**
 * Return the maximum absolute value in one half-open array range.
 *
 * @param {ArrayLike<number>} values
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number}
 */
export function absoluteMaximum(values, start = 0, end = values.length) {
  let maximum = 0
  for (let index = start; index < end; index++) {
    const magnitude = Math.abs(values[index])
    if (magnitude > maximum) maximum = magnitude
  }
  return maximum
}

/**
 * Reverse the low `bitCount` bits of an unsigned integer.
 *
 * @param {number} value Unsigned source value.
 * @param {number} bitCount Number of low bits to reverse, from 0 through 32.
 * @returns {number} Unsigned reversed bit field.
 */
export function reverseLowBits(value, bitCount) {
  if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
    throw new RangeError(
      `Bit count must be an integer in 0..32, got ${bitCount}`
    )
  }
  let source = Number(value) >>> 0
  let reversed = 0
  for (let index = 0; index < bitCount; index++) {
    reversed = (reversed * 2 + (source & 1)) >>> 0
    source >>>= 1
  }
  return reversed
}

/**
 * Compose stateful stage factories once and return the reusable frame path.
 *
 * @template TContext, TValue
 * @param {TContext} context Shared stage ownership and persistent state.
 * @param {...function(TContext): function(TValue): TValue} stages Ordered stage factories.
 * @returns {function(TValue): TValue} Reusable composed frame operation.
 */
export function pipe(context, ...stages) {
  const operations = stages.map((stage) => stage(context))
  return (input) =>
    operations.reduce((value, operation) => operation(value), input)
}
