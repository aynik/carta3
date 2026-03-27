export function ghBitWidth(value) {
  return Math.max(1, 32 - Math.clz32(value >>> 0));
}
