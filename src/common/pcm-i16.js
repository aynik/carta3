/**
 * Converts one float PCM sample into a saturated 16-bit signed PCM sample.
 *
 * Internal decode pipelines use Float32 intermediates. Public decode surfaces
 * and PCM writers consume Int16 PCM, so keep this rounding/saturation policy
 * centralized.
 */
export function pcmI16FromF32Sample(sample) {
  if (sample > 32767) {
    return 32767;
  }
  if (sample < -32768) {
    return -32768;
  }
  return Math.round(sample);
}
