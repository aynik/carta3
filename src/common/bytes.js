import { CodecError } from "./errors.js";

export function normalizeInputBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    const { buffer, byteOffset, byteLength } = input;
    return new Uint8Array(buffer, byteOffset, byteLength);
  }
  throw new TypeError("input must be an ArrayBuffer, SharedArrayBuffer, or ArrayBuffer view");
}

/**
 * Normalizes one authored codec frame list while preserving codec-specific
 * empty-input and frame-size validation messages.
 */
export function normalizeCodecFrames(frames, frameBytes, codecName) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new CodecError(`${codecName} input has no frames`);
  }

  const normalizedFrames = new Array(frames.length);
  const invalidFrameMessageBase = `invalid ${codecName} frame length`;

  for (const [index, frame] of frames.entries()) {
    if (!(frame instanceof ArrayBuffer) && !ArrayBuffer.isView(frame)) {
      throw new CodecError(`${invalidFrameMessageBase} at index ${index} (expected ${frameBytes})`);
    }

    const bytes = normalizeInputBytes(frame);
    if (bytes.length !== frameBytes) {
      throw new CodecError(
        `${invalidFrameMessageBase} at index ${index} (expected ${frameBytes}, got ${bytes.length})`
      );
    }

    normalizedFrames[index] = bytes;
  }

  return normalizedFrames;
}
