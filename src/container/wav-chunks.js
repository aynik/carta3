import { CodecError } from "../common/errors.js";
import { resolveAtracEncodeFactPlan } from "../common/atrac-fact.js";
import { roundDivU32 } from "../common/math.js";
import { writeAtracFormatBody } from "./wav-format.js";

const FMT_CHUNK_ID = "fmt ";
const FACT_CHUNK_ID = "fact";
const SMPL_CHUNK_ID = "smpl";
const DATA_CHUNK_ID = "data";
const NANOSECONDS_PER_SECOND = 1_000_000_000;
const SMPL_MIDI_UNITY_NOTE = 60;
const SMPL_SAMPLER_DATA_BYTES = 24;
const SMPL_CHUNK_BYTES = 60;
const FACT_MODE_ALIGNED_ONLY = 0;
const FACT_MODE_WITH_PARAM = 1;
const FACT_TOTAL_SAMPLES_OFFSET = 0;
const FACT_ALIGNED_SAMPLES_OFFSET = 4;
const FACT_PARAM_OFFSET = 8;
const SMPL_SAMPLE_PERIOD_OFFSET = 8;
const SMPL_MIDI_UNITY_NOTE_OFFSET = 12;
const SMPL_LOOP_COUNT_OFFSET = 28;
const SMPL_SAMPLER_DATA_OFFSET = 32;
const SMPL_LOOP_START_OFFSET = 44;
const SMPL_LOOP_END_OFFSET = 48;
const U32_MAX = 0xffffffff;

function assertU32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new CodecError(`invalid ${name}: ${value}`);
  }
  return value >>> 0;
}

function createAtracLoopChunkBody(format, loopStart, loopEnd, loopSampleBase) {
  const out = new Uint8Array(SMPL_CHUNK_BYTES);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const sampleRate = format?.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > U32_MAX) {
    throw new CodecError(`invalid smpl sampleRate: ${sampleRate}`);
  }

  // The authored loop writer uses a single forward loop with no manufacturer,
  // product, or SMPTE metadata. Only the sample period and loop points vary.
  view.setUint32(SMPL_SAMPLE_PERIOD_OFFSET, roundDivU32(NANOSECONDS_PER_SECOND, sampleRate), true);
  view.setUint32(SMPL_MIDI_UNITY_NOTE_OFFSET, SMPL_MIDI_UNITY_NOTE, true);
  view.setUint32(SMPL_LOOP_COUNT_OFFSET, 1, true);
  view.setUint32(SMPL_SAMPLER_DATA_OFFSET, SMPL_SAMPLER_DATA_BYTES, true);
  view.setUint32(
    SMPL_LOOP_START_OFFSET,
    assertU32(loopStart + loopSampleBase, "smpl loopStart"),
    true
  );
  view.setUint32(SMPL_LOOP_END_OFFSET, assertU32(loopEnd + loopSampleBase, "smpl loopEnd"), true);
  return out;
}

/**
 * Creates the authored ATRAC RIFF/WAV chunk sequence in wire order.
 *
 * The shared container builder owns RIFF framing, while this owner is
 * responsible for the ATRAC-specific chunk policy: serialized `fmt`, resolved
 * `fact`, optional authored `smpl`, and the final `data` payload chunk.
 */
export function createAtracWavChunks({
  format,
  profile,
  dataBytes,
  totalSamples,
  loopStart = -1,
  loopEnd = -1,
  factMode = 1,
}) {
  if (!(dataBytes instanceof Uint8Array)) {
    throw new CodecError("dataBytes must be a Uint8Array");
  }

  const totalSamplesU32 = assertU32(totalSamples, "totalSamples");

  const formatBody = new Uint8Array(format.formatChunkBytes);
  const formatView = new DataView(formatBody.buffer, formatBody.byteOffset, formatBody.byteLength);
  const formatEndOffset = writeAtracFormatBody(formatBody, formatView, 0, format);
  if (formatEndOffset !== formatBody.length) {
    throw new CodecError(
      `internal ATRAC fmt sizing mismatch: wrote ${formatEndOffset}, expected ${formatBody.length}`
    );
  }

  const { factParam, alignedSampleCount } = resolveAtracEncodeFactPlan(profile, loopEnd);
  const alignedSampleCountU32 = assertU32(alignedSampleCount, "alignedSampleCount");
  let storedFactParam = null;
  let loopSampleBase = alignedSampleCountU32;

  switch (factMode) {
    case FACT_MODE_ALIGNED_ONLY:
      break;
    case FACT_MODE_WITH_PARAM:
      storedFactParam = assertU32(factParam, "factParam");
      loopSampleBase = storedFactParam;
      break;
    default:
      throw new CodecError(`unsupported factMode: ${factMode}`);
  }

  const factBody = new Uint8Array(
    storedFactParam === null ? FACT_PARAM_OFFSET : FACT_PARAM_OFFSET + 4
  );
  const factView = new DataView(factBody.buffer, factBody.byteOffset, factBody.byteLength);
  factView.setUint32(FACT_TOTAL_SAMPLES_OFFSET, totalSamplesU32, true);
  factView.setUint32(FACT_ALIGNED_SAMPLES_OFFSET, alignedSampleCountU32, true);
  if (storedFactParam !== null) {
    factView.setUint32(FACT_PARAM_OFFSET, storedFactParam, true);
  }

  const chunks = [
    { id: FMT_CHUNK_ID, body: formatBody },
    { id: FACT_CHUNK_ID, body: factBody },
  ];

  if (loopStart >= 0) {
    chunks.push({
      id: SMPL_CHUNK_ID,
      body: createAtracLoopChunkBody(format, loopStart, loopEnd, loopSampleBase),
    });
  }
  chunks.push({ id: DATA_CHUNK_ID, body: dataBytes });

  return chunks;
}
