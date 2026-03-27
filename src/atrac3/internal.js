/**
 * Package-private ATRAC3 barrel.
 *
 * `index.js` is the only stable public ATRAC3 surface. This barrel owns the
 * package-private ATRAC3 namespaces used by focused tests and internal
 * tooling: decode lifecycle, encode lifecycle, low-level transport helpers,
 * SCX helpers, and lookup tables. The encode namespace stays owner-shaped
 * instead of flattening runtime, channel-conversion, frame-packing, and
 * signal-path helpers into one catch-all export bag. These namespaces should
 * import their real owner files directly instead of splitting one broad module
 * back apart. The named `scx/` subsystem now owns its own package-private
 * barrel so ATRAC3 can expose one subsystem namespace without assembling SCX
 * file-by-file from the parent.
 */
import * as DecodeRebuild from "./decode-rebuild.js";
import * as DecodeRebuildBlock from "./decode-rebuild-block.js";
import * as DecodeStereo from "./decode-stereo.js";
import * as DecodeSynthesis from "./decode-synthesis.js";
import * as DecodeOutput from "./decode-output.js";
import * as Decode from "./decode.js";
import * as DecodeTables from "./decode-tables.js";
import {
  AT3_DEC_FLAG_ERROR,
  AT3_SPCODE_ERROR_FLAG,
  markAtrac3DecodeError,
  openAtrac3ChannelTransport,
  peekAtrac3Bits,
  readAtrac3Bits,
} from "./decode-channel-transport.js";
import { decodeSpcode } from "./decode-channel-spcode.js";
import { decodeAtrac3TonePasses } from "./decode-channel-tone.js";
import {
  decodeAtrac3ChannelPayload,
  decodeAtrac3ChannelTransport,
  stageAtrac3GainPairTables,
} from "./decode-channel.js";
import { createAtrac3DecoderState } from "./decoder-state.js";
import * as Decoder from "./decoder.js";
import * as EncodeTables from "./encode-tables.js";
import * as EncodeRuntime from "./encode-runtime.js";
import * as ChannelConversionAnalysis from "./channel-conversion-analysis.js";
import { at3encApplyChannelConversion } from "./channel-conversion-apply.js";
import * as ChannelRebalance from "./channel-rebalance.js";
import * as FrameLifecycle from "./frame.js";
import * as FrameOutput from "./frame-output.js";
import * as FrameChannelBody from "./frame-channel.js";
import * as FrameChannelPack from "./frame-channel-pack.js";
import * as FrameChannelSpectrum from "./frame-channel-spectrum.js";
import * as FrameChannelTone from "./frame-channel-tone.js";
import * as ProcPayloadPlan from "./proc-payload-plan.js";
import { finalizeLowBudgetBandPayload } from "./proc-payload-fit.js";
import * as ProcWords from "./proc-words.js";
import * as ProcLowBudgetTone from "./proc-low-budget-tone.js";
import * as Qmf from "./qmf.js";
import * as Scx from "./scx/internal.js";
import * as Transform from "./transform.js";

const Bitstream = {
  AT3_SPCODE_ERROR_FLAG,
  decodeSpcode,
  openAtrac3ChannelTransport,
  peekAtrac3Bits,
  readAtrac3Bits,
};
const ChannelConversion = {
  ...ChannelConversionAnalysis,
  at3encApplyChannelConversion,
};
const ProcPayload = {
  ...ProcPayloadPlan,
  finalizeLowBudgetBandPayload,
};
const Frame = {
  ...FrameLifecycle,
  ...FrameOutput,
};
const FrameChannel = {
  ...FrameChannelBody,
  ...FrameChannelPack,
  ...FrameChannelSpectrum,
  ...FrameChannelTone,
};
const Codec = {
  AT3_DEC_FLAG_ERROR,
  stageAtrac3GainPairTables,
  decodeAtrac3TonePasses,
  decodeAtrac3ChannelPayload,
  markAtrac3DecodeError,
  decodeAtrac3ChannelTransport,
  ...DecodeRebuild,
  ...DecodeRebuildBlock,
  ...DecodeStereo,
  ...DecodeSynthesis,
  ...DecodeOutput,
  ...Decode,
  createAtrac3DecoderState,
  ...Decoder,
};
const Encode = {
  Runtime: EncodeRuntime,
  ChannelConversion,
  ChannelRebalance,
  Frame,
  FrameChannel,
  ProcPayload,
  ProcLowBudgetTone,
  ProcWords,
  Qmf,
  Transform,
};
const Tables = { ...DecodeTables, ...EncodeTables };

export { Bitstream, Codec, Encode, Scx, Tables };
