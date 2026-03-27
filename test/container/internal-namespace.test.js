import assert from "node:assert/strict";
import test from "node:test";

import * as ContainerInternal from "../../src/container/internal.js";
import * as Build from "../../src/container/wav-build.js";
import * as WavBytes from "../../src/container/wav-bytes.js";
import * as Chunks from "../../src/container/wav-chunks.js";
import * as Decode from "../../src/container/decode.js";
import * as Format from "../../src/container/wav-format.js";
import * as Parse from "../../src/container/wav-parse.js";
import * as Writer from "../../src/container/pcm-writer.js";

test("container internal namespace groups private owner modules", () => {
  assert.equal(ContainerInternal.Build, Build);
  assert.equal(ContainerInternal.WavBytes, WavBytes);
  assert.equal(ContainerInternal.Chunks, Chunks);
  assert.equal(ContainerInternal.Decode, Decode);
  assert.equal(ContainerInternal.Format, Format);
  assert.equal(ContainerInternal.Parse, Parse);
  assert.equal(ContainerInternal.Writer, Writer);
});

test("container owner modules keep WAV format parsing separate from stream parsing", () => {
  assert.equal(typeof Format.parseAtracFormat, "function");
  assert.equal(typeof Parse.parseAtracWavBuffer, "function");
  assert.equal(typeof Parse.parsePcm16WavBuffer, "function");
  assert.equal("parseAtracFormat" in Parse, false);
});
