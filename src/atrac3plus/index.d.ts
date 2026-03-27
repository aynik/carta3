import type {
  At5BitState,
  At5IdctSharedConfig,
  Atrac3PlusDecoderConfig,
  AtxDecodeHandleConfig,
  AtxFrameUnpackResult,
  BinaryInput,
  DecodeFrameResult,
  ParsedAtrac3PlusCodecInfo,
} from "../public-types.js";

/**
 * Stable ATRAC3plus package declarations.
 */
export class Atrac3PlusDecoder {
  constructor(config: Atrac3PlusDecoderConfig);
  readonly config: Atrac3PlusDecoderConfig;
  readonly state: unknown;
  decodeFrames(
    frames: BinaryInput[],
    factSamples?: number | null,
    factRaw?: number[] | null
  ): DecodeFrameResult;
}

export function createAtxDecodeHandle(config: AtxDecodeHandleConfig): unknown;
export function createAtrac3PlusDecoderState(config: Atrac3PlusDecoderConfig): unknown;
export function parseAtrac3PlusCodecBytes(
  codecBytes: Uint8Array,
  frameBytes: number
): ParsedAtrac3PlusCodecInfo;

export const AT5_CHANNEL_BLOCK_ERROR_CODES: Record<string, number>;
export function at5ActiveBandCount(
  idwlA: ArrayLike<number>,
  idwlB: ArrayLike<number>,
  limit: number,
  channelCount: number
): number;
export function createAt5RegularBlockState(channelCount: number): unknown;
export function unpackChannelBlockAt5Reg(
  block: unknown,
  frame: BinaryInput,
  bitState: At5BitState
): boolean;

export const ATX_FRAME_UNPACK_ERROR_CODES: Record<string, number>;
export function unpackAtxFrame(handle: unknown, frame: BinaryInput): AtxFrameUnpackResult;

export const AT5_GH_ERROR_CODES: Record<string, number>;
export function clearAt5GhSlot(slot: unknown): void;
export function createAt5GhChannelState(
  channelIndex: number,
  block0?: unknown,
  shared?: unknown
): unknown;
export function createAt5GhSharedState(channelCount: number): unknown;
export function unpackGh(block: unknown, frame: BinaryInput, bitState: At5BitState): boolean;

export const AT5_IDWL_ERROR_CODES: Record<string, number>;
export function createAt5IdwlChannelState(
  channelIndex: number,
  shared: unknown,
  block0?: unknown
): unknown;
export function createAt5IdwlSharedState(mdspecGroupCount: number): unknown;
export function unpackIdwl(
  channel: unknown,
  frame: BinaryInput,
  bitState: At5BitState,
  packMode: number
): boolean;

export const AT5_IDSF_ERROR_CODES: Record<string, number>;
export function createAt5IdsfChannelState(
  channelIndex: number,
  shared: unknown,
  block0?: unknown
): unknown;
export function createAt5IdsfSharedState(idsfCount: number): unknown;
export function unpackIdsf(
  channel: unknown,
  frame: BinaryInput,
  bitState: At5BitState,
  modeSelect: number
): boolean;

export const AT5_IDCT_ERROR_CODES: Record<string, number>;
export function createAt5IdctChannelState(
  channelIndex: number,
  shared: unknown,
  block0?: unknown
): unknown;
export function createAt5IdctSharedState(config?: At5IdctSharedConfig): unknown;
export function unpackIdct(
  channel: unknown,
  frame: BinaryInput,
  bitState: At5BitState,
  modeSelect: number
): boolean;

export function backwardTransformAt5(
  src: Float32Array,
  outPtrs: Float32Array[],
  gainBlocksA: unknown,
  gainBlocksB: unknown,
  blocks: number,
  overlap: Float32Array
): void;
export function copyGainRecordToGaincBlock(record: unknown, outBlock: unknown): void;
export function createAt5GaincBlock(): unknown;
export function winormalMdct128ExAt5(
  src: Float32Array,
  dst: Float32Array,
  win: Float32Array,
  flag: number
): void;

export function at5DecodeHcspecSymbols(
  desc: unknown,
  frame: BinaryInput,
  bitState: At5BitState,
  symbolsOut: Int32Array,
  symbolCount: number
): number;
export function at5ExpandHcspecToCoeffs(
  symbols: Int32Array,
  symbolCount: number,
  width: number,
  out: Int16Array
): void;
export function at5HcspecDescForBand(shared: unknown, channel: unknown, band: number): unknown;
export function createAt5SpectraChannelState(): unknown;
export function unpackChannelSpectra(
  channel: unknown,
  shared: unknown,
  frame: BinaryInput,
  bitState: At5BitState
): boolean;

export function addSeqAt5(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float32Array,
  count: number
): void;
export function invmixSeqAt5(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float32Array,
  count: number
): void;
export function mixSeqAt5(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float32Array,
  count: number
): void;
export function subSeqAt5(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float32Array,
  count: number
): void;

export function synthesisWavAt5(
  ctx: unknown,
  out: Float32Array,
  offset: number,
  count: number,
  mode: number,
  flipFlag: number,
  flipMode: number
): void;

export const AT5_GAIN_ERROR_CODES: Record<string, number>;
export const AT5_GAIN_RECORDS: number;
export function clearAt5GainRecords(channel: unknown): void;
export function createAt5GainChannelState(channelIndex: number, block0?: unknown): unknown;
export function unpackGainIdlev(
  channel: unknown,
  frame: BinaryInput,
  bitState: At5BitState,
  mode: number
): boolean;
export function unpackGainIdloc(
  channel: unknown,
  frame: BinaryInput,
  bitState: At5BitState,
  mode: number
): boolean;
export function unpackGainNgc(
  channel: unknown,
  frame: BinaryInput,
  bitState: At5BitState,
  mode: number
): boolean;
export function unpackGainRecords(
  channel: unknown,
  frame: BinaryInput,
  bitState: At5BitState
): boolean;

export function createAt5PresenceTable(): unknown;
export function decodeAt5Presence(
  table: unknown,
  count: number,
  frame: BinaryInput,
  bitState: At5BitState
): void;
