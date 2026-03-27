/**
 * Browser-safe public package entrypoint.
 *
 * This surface intentionally omits Node-only helpers such as filesystem-backed
 * container decoding. It is composed from the curated browser-safe subpath
 * barrels so the root package surface stays aligned with the same owner
 * boundaries that external callers can also import directly.
 */
export * from "./atrac3/index.js";
export * from "./atrac3plus/index.js";
export * from "./encoders/index.js";
export * from "./container/index.js";
