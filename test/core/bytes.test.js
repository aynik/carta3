import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCodecFrames, normalizeInputBytes } from "../../src/common/bytes.js";
import { buildRiffWaveBuffer, readChunkId, writeAscii } from "../../src/container/wav-bytes.js";

test("normalizeInputBytes preserves the current ArrayBuffer view window", () => {
  const source = Uint8Array.from([0, 1, 2, 3, 4, 5]);
  const input = new DataView(source.buffer, 2, 3);

  const bytes = normalizeInputBytes(input);

  assert.deepEqual(Array.from(bytes), [2, 3, 4]);
  assert.equal(bytes.buffer, source.buffer);
  assert.equal(bytes.byteOffset, 2);
  assert.equal(bytes.byteLength, 3);
});

test("normalizeInputBytes accepts SharedArrayBuffer inputs", () => {
  if (typeof SharedArrayBuffer === "undefined") {
    return;
  }

  const sab = new SharedArrayBuffer(4);
  new Uint8Array(sab).set([1, 2, 3, 4]);

  const bytes = normalizeInputBytes(sab);

  assert.deepEqual(Array.from(bytes), [1, 2, 3, 4]);
  assert.equal(bytes.buffer, sab);
  assert.equal(bytes.byteOffset, 0);
  assert.equal(bytes.byteLength, 4);
});

test("normalizeInputBytes rejects non-binary inputs", () => {
  assert.throws(
    () => normalizeInputBytes("abc"),
    /input must be an ArrayBuffer, SharedArrayBuffer, or ArrayBuffer view/
  );
});

test("normalizeCodecFrames preserves codec-specific frame validation around byte coercion", () => {
  const source = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const frames = [new DataView(source.buffer, 2, 3), source.subarray(4, 7)];

  const normalized = normalizeCodecFrames(frames, 3, "ATRAC3");

  assert.deepEqual(
    normalized.map((frame) => Array.from(frame)),
    [
      [2, 3, 4],
      [4, 5, 6],
    ]
  );
  assert.throws(() => normalizeCodecFrames([], 3, "ATRAC3"), /ATRAC3 input has no frames/);
  assert.throws(
    () => normalizeCodecFrames([new Uint8Array(2)], 3, "ATRAC3plus"),
    /invalid ATRAC3plus frame length at index 0 \(expected 3, got 2\)/
  );
  assert.throws(
    () => normalizeCodecFrames(["not-bytes"], 3, "ATRAC3"),
    /invalid ATRAC3 frame length at index 0 \(expected 3\)/
  );
});

test("writeAscii writes byte-masked code units at the requested offset", () => {
  const out = Uint8Array.from([9, 9, 9, 9, 9, 9]);

  writeAscii(out, 1, "A\u0101");

  assert.deepEqual(Array.from(out), [9, 65, 1, 9, 9, 9]);
});

test("writeAscii preserves current UTF-16 code-unit handling", () => {
  const out = new Uint8Array(2);

  writeAscii(out, 0, "\u{1f600}");

  assert.deepEqual(Array.from(out), [0x3d, 0x00]);
});

test("readChunkId reads one 4-byte RIFF chunk identifier", () => {
  const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x66, 0x6d, 0x74, 0x20]);

  assert.equal(readChunkId(bytes, 0), "RIFF");
  assert.equal(readChunkId(bytes, 4), "fmt ");
});

test("buildRiffWaveBuffer serializes padded RIFF/WAVE chunk headers in order", () => {
  const bytes = buildRiffWaveBuffer([
    { id: "JUNK", body: Uint8Array.of(0xaa) },
    { id: "data", body: Uint8Array.of(1, 2, 3, 4) },
  ]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  assert.equal(readChunkId(bytes, 0), "RIFF");
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(readChunkId(bytes, 8), "WAVE");
  assert.equal(readChunkId(bytes, 12), "JUNK");
  assert.equal(view.getUint32(16, true), 1);
  assert.equal(bytes[20], 0xaa);
  assert.equal(bytes[21], 0);
  assert.equal(readChunkId(bytes, 22), "data");
  assert.equal(view.getUint32(26, true), 4);
  assert.deepEqual(Array.from(bytes.subarray(30, 34)), [1, 2, 3, 4]);
});

test("buildRiffWaveBuffer rejects invalid chunk ids", () => {
  assert.throws(
    () => buildRiffWaveBuffer([{ id: "abc", body: new Uint8Array(0) }]),
    /invalid RIFF chunk id/
  );
  assert.throws(
    () => buildRiffWaveBuffer([{ id: "abcde", body: new Uint8Array(0) }]),
    /invalid RIFF chunk id/
  );
  assert.throws(
    () => buildRiffWaveBuffer([{ id: "A\u00e9BC", body: new Uint8Array(0) }]),
    /invalid RIFF chunk id/
  );
});
