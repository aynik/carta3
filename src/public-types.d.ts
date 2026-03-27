/**
 * Shared public type definitions for the package entrypoints.
 *
 * Runtime modules are grouped by public barrels, while this file keeps the
 * value-agnostic data shapes in one place so `index.d.ts`, `browser.d.ts`,
 * and the subsystem declaration barrels can all reference the same types.
 */
export type BinaryInput = ArrayBuffer | ArrayBufferView;

export interface DecodeFrameResult {
  pcm: Int16Array;
}

export interface ParsedAtracFormatBase {
  formatTag: number;
  channels: number;
  sampleRate: number;
  avgBytesPerSec: number;
  bitrateKbps: number;
  frameBytes: number;
  frameSamples: number;
  bitsPerSample: number;
}

export interface ParsedAtrac3Format extends ParsedAtracFormatBase {
  codec: "atrac3";
  atrac3Flag: number;
}

export interface ParsedAtrac3PlusFormat extends ParsedAtracFormatBase {
  codec: "atrac3plus";
  channelMask: number;
  atracxVersion: number;
  atracxCodecBytes: Uint8Array;
  atracxReserved: Uint8Array;
}

export type ParsedAtracFormat = ParsedAtrac3Format | ParsedAtrac3PlusFormat;

interface ParsedAtracContainerFields {
  factSamples: number | null;
  factRaw: number[];
  frameCount: number;
  dataSize: number;
  frames: Uint8Array[];
}

export interface ParsedAtrac3Container extends ParsedAtrac3Format, ParsedAtracContainerFields {}

export interface ParsedAtrac3PlusContainer
  extends ParsedAtrac3PlusFormat, ParsedAtracContainerFields {}

export type ParsedAtracContainer = ParsedAtrac3Container | ParsedAtrac3PlusContainer;

export interface PcmBufferWriter {
  pcm: Int16Array;
  toPcmWavBuffer(): Uint8Array;
}

export interface PcmWriter extends PcmBufferWriter {
  writePcmWav(outputPath: string): Promise<void>;
}

/**
 * Browser-safe decoded ATRAC WAV result: parsed container metadata plus the
 * in-memory PCM writer contract.
 */
export interface DecodedAtracBuffer extends PcmBufferWriter {
  metadata: ParsedAtracContainer;
}

export interface ParsedPcm16Wav {
  formatTag: number;
  channels: number;
  sampleRate: number;
  avgBytesPerSec: number;
  blockAlign: number;
  bitsPerSample: number;
  dataSize: number;
  samples: Int16Array;
}

export interface ParsedFactChunk {
  sampleCount: number | null;
  raw: number[];
}

export interface WavChunk {
  id: string;
  size: number;
  offset: number;
  body: Uint8Array;
}

/** Node-only extension of the shared decoded ATRAC buffer result. */
export interface DecodedAtracContainer extends DecodedAtracBuffer, PcmWriter {}

/**
 * Optional container `fact` metadata that influences the final public trim
 * window after frame decode.
 *
 * Decoder-state construction does not consume these fields directly. They stay
 * available on container-derived config objects because wrapper callers often
 * carry stream layout and trim metadata together, but the actual trim decision
 * happens at the per-call decode boundary.
 */
export interface AtracDecodeTrimMetadata {
  factSamples?: number | null;
  factRaw?: number[] | null;
}

/**
 * ATRAC3 decoder metadata.
 *
 * The runtime resolves the transport layout from `bitrateKbps` and
 * `frameBytes`, optionally refined by `atrac3Flag`. `channels` remains a
 * caller-controlled output preference on the reusable decoder wrapper, so it
 * may be omitted and can differ from the authored stream layout.
 */
export interface Atrac3DecoderConfig extends AtracDecodeTrimMetadata {
  channels?: number;
  sampleRate?: number;
  frameBytes: number;
  bitrateKbps?: number;
  atrac3Flag?: number;
}

export interface Atrac3PlusDecoderConfig extends AtracDecodeTrimMetadata {
  channels: number;
  sampleRate: number;
  frameBytes: number;
  frameSamples: number;
  bitrateKbps?: number;
  atracxVersion?: number;
  atracxCodecBytes?: Uint8Array;
  atracxReserved?: Uint8Array;
}

interface AtracEncodeProfileBase {
  bitrateKbps: number;
  channels: number;
  sampleRate: number;
  frameSamples: number;
  frameBytes: number;
  codecInfo: number;
  encoderDelaySamples: number;
  factBaseDelaySamples: number;
  factValueDelaySamples: number;
}

export interface Atrac3EncodeProfile extends AtracEncodeProfileBase {
  codec: "atrac3";
  codecKind: 3;
  encodeAlgorithm: 0 | 1;
  encodeVariant: "atrac3-algorithm0" | "atrac3-scx";
  mode: number;
  atrac3Flag: number;
}

export interface Atrac3PlusEncodeProfile extends AtracEncodeProfileBase {
  codec: "atrac3plus";
  codecKind: 5;
  encodeAlgorithm: 1;
  encodeVariant: "atrac3plus";
  mode: number;
  channelMask: number;
  atracxCodecBytes: Uint8Array;
}

export type AtracEncodeProfile = Atrac3EncodeProfile | Atrac3PlusEncodeProfile;

interface AtracEncodeWavFormatBase {
  formatTag: number;
  formatChunkBytes: number;
  channels: number;
  sampleRate: number;
  avgBytesPerSec: number;
  blockAlign: number;
  bitsPerSample: number;
  frameSamples: number;
}

export interface Atrac3EncodeWavFormat extends AtracEncodeWavFormatBase {
  codec: "atrac3";
  atrac3Flag: number;
}

export interface Atrac3PlusEncodeWavFormat extends AtracEncodeWavFormatBase {
  codec: "atrac3plus";
  extSize: number;
  samplesPerBlock: number;
  channelMask: number;
  atracxVersion: number;
  atracxCodecBytes: Uint8Array;
  atracxReserved: Uint8Array;
}

export type AtracEncodeWavFormat = Atrac3EncodeWavFormat | Atrac3PlusEncodeWavFormat;

/**
 * Encoded ATRAC payload accepted by the shared WAV container builder.
 *
 * The builder accepts either one contiguous payload view already aligned to
 * frame boundaries or an array of per-frame views.
 */
export type AtracEncodedFrameInput = BinaryInput | BinaryInput[];

export interface BuildAtracWavOptions {
  profile: AtracEncodeProfile;
  encodedFrames: AtracEncodedFrameInput;
  totalSamples: number;
  loopStart?: number;
  loopEnd?: number;
  factMode?: 0 | 1;
  validateTrim?: boolean;
}

export interface AtracEncodePadPlan {
  alignedSampleCount: number;
  padSamples: number;
  dropInitialOutputFrames: number;
}

export interface PreparedAtracEncodeFrame {
  pcm: Int16Array;
  sampleCount: number;
}

export interface AtracEncodePcmStagingRequest {
  pcmI16: Int16Array;
  channels: number;
  frameSamples: number;
  factParam: number;
  encoderDelaySamples: number;
}

export interface PreparedAtracEncodeFrames {
  stagedFrames: PreparedAtracEncodeFrame[];
  padSamples: number;
  dropInitialOutputFrames: number;
}

export interface Atrac3ScxEncodeOptions {
  bitrateKbps?: number;
  channels?: number;
  sampleRate?: number;
  loopStart?: number;
  loopEnd?: number;
  factMode?: 0 | 1;
  context?: unknown | null;
}

export interface Atrac3ScxEncodeResult {
  profile: Atrac3EncodeProfile;
  encodedFrames: Uint8Array[];
  totalSamples: number;
  context: unknown;
}

export interface Atrac3ScxEncodeWavResult extends Atrac3ScxEncodeResult {
  buffer: Uint8Array;
}

export interface AtracEncodeDebugFrame extends Record<string, unknown> {
  outputFrameIndex: number;
}

export interface AtracEncodeDebug {
  frames: AtracEncodeDebugFrame[];
}

/**
 * Package-level ATRAC encode request.
 *
 * `bitrateKbps`, `channels`, `sampleRate`, `loopStart`, `loopEnd`, `factMode`,
 * and `context` belong to the shared routed wrapper request. `encodeMode`,
 * `useExactQuant`, `maxOutputFrames`, and `collectDebug` are consumed only when
 * the selected profile routes to ATRAC3plus.
 */
export interface AtracEncodeOptions {
  codec?: "atrac3" | "atrac3plus";
  bitrateKbps?: number;
  channels?: number;
  sampleRate?: number;
  loopStart?: number;
  loopEnd?: number;
  factMode?: 0 | 1;
  encodeMode?: number;
  useExactQuant?: boolean;
  maxOutputFrames?: number | null;
  collectDebug?: boolean;
  context?: unknown | null;
}

export interface AtracEncodeResult {
  profile: AtracEncodeProfile;
  encodedFrames: Uint8Array[];
  totalSamples: number;
  context: unknown;
  debug?: AtracEncodeDebug | null;
}

export interface AtracEncodeWavResult extends AtracEncodeResult {
  buffer: Uint8Array;
}

export interface At5BitState {
  bitpos: number;
}

export interface At5IdctSharedConfig {
  fixIdx?: number;
  maxCount?: number;
  gainModeFlag?: number;
}

export interface AtxDecodeHandleConfig {
  sampleRate: number;
  mode: number;
  frameBytes: number;
  outputChannels: number;
}

export interface AtxFrameUnpackResult {
  ok: boolean;
  errorCode: number;
  bitpos: number;
}

export interface ParsedAtrac3PlusCodecInfo {
  sampleRateCode: number | null;
  sampleRate: number | null;
  mode: number | null;
  derivedFrameBytes: number;
}
