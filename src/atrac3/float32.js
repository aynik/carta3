/**
 * ATRAC3 bit-pattern Float32 helpers.
 *
 * ATRAC3 keeps several tables and per-block maxima in packed IEEE-754 word
 * form. This owner file handles the raw bit-to-float conversion used by the
 * transform and proc quantization paths.
 */
const F32_VIEW = new DataView(new ArrayBuffer(4));

export function bitsToFloat32(bits) {
  F32_VIEW.setUint32(0, bits >>> 0, false);
  return F32_VIEW.getFloat32(0, false);
}
