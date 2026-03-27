/**
 * Node public package declarations.
 *
 * Keep this declaration root aligned with `src/index.js`: the root package
 * surface is composed from the stable codec, encoder, and Node container
 * subpath barrels, while shared public-only types stay in `public-types.d.ts`.
 */
export type {
  BinaryInput,
  DecodeFrameResult,
  ParsedAtracFormat,
  ParsedAtrac3Format,
  ParsedAtrac3PlusFormat,
  ParsedAtracContainer,
  ParsedAtrac3Container,
  ParsedAtrac3PlusContainer,
  ParsedPcm16Wav,
  ParsedFactChunk,
  WavChunk,
  PcmBufferWriter,
  PcmWriter,
  DecodedAtracContainer,
  DecodedAtracBuffer,
  AtracDecodeTrimMetadata,
  Atrac3DecoderConfig,
  Atrac3PlusDecoderConfig,
  Atrac3EncodeProfile,
  Atrac3PlusEncodeProfile,
  AtracEncodeProfile,
  Atrac3EncodeWavFormat,
  Atrac3PlusEncodeWavFormat,
  AtracEncodeWavFormat,
  AtracEncodedFrameInput,
  BuildAtracWavOptions,
  AtracEncodePcmStagingRequest,
  AtracEncodePadPlan,
  PreparedAtracEncodeFrames,
  Atrac3ScxEncodeOptions,
  Atrac3ScxEncodeResult,
  Atrac3ScxEncodeWavResult,
  AtracEncodeDebugFrame,
  AtracEncodeDebug,
  AtracEncodeOptions,
  AtracEncodeResult,
  AtracEncodeWavResult,
  At5BitState,
  At5IdctSharedConfig,
  AtxDecodeHandleConfig,
  AtxFrameUnpackResult,
  ParsedAtrac3PlusCodecInfo,
} from "./public-types.js";

export * from "./atrac3/index.js";
export * from "./atrac3plus/index.js";
export * from "./encoders/index.js";
export * from "./container/node.js";
