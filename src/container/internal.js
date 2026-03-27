/**
 * Package-private WAV container barrel.
 *
 * `index.js` and `node.js` expose the stable browser-safe and Node-aware
 * container surfaces. This barrel keeps the lower-level parsing, chunk
 * planning, byte handling, formatting, decode, build, and PCM writer owner
 * modules grouped under one private seam for internal tooling and focused
 * tests.
 */
import * as Build from "./wav-build.js";
import * as WavBytes from "./wav-bytes.js";
import * as Chunks from "./wav-chunks.js";
import * as Decode from "./decode.js";
import * as Format from "./wav-format.js";
import * as Parse from "./wav-parse.js";
import * as Writer from "./pcm-writer.js";

export { Build, WavBytes, Chunks, Decode, Format, Parse, Writer };
