import { CodecError } from "../../common/errors.js";

/** Shared numeric-buffer and integer guards for SCX mddata stages. */
export function toInt(value) {
  return value | 0;
}

export function fpUnorderedOrLe(a, b) {
  return !(a > b);
}

export function toIntChecked(value, name) {
  if (!Number.isInteger(value)) {
    throw new CodecError(`${name} must be an integer`);
  }
  return value | 0;
}

export function ensureNumericView(value, name) {
  if (ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw new CodecError(`${name} must be an array-like numeric buffer`);
}

export function viewSlice(view, start, end) {
  if (ArrayBuffer.isView(view) && typeof view.subarray === "function") {
    return view.subarray(start, end);
  }
  if (Array.isArray(view)) {
    return view.slice(start, end);
  }
  throw new CodecError("expected an array-like numeric buffer");
}
