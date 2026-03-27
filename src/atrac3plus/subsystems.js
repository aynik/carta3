/**
 * ATRAC3plus modules grouped by codec subsystem.
 *
 * Stable subsystem entrypoints such as `ChannelBlock`, `Gainc`, `Ghwave`,
 * `Sigproc`, and `Time2freq` live at the codec root so internal callers do
 * not need to reach through incidental folders. `ChannelBlock` intentionally
 * exposes only the encode-facing block lifecycle, while low-level bitstream
 * plumbing and DSP helpers stay in `internal.js`.
 */
import * as ChannelBlock from "./channel-block/index.js";
import * as Codec from "./codec.js";
import * as Gainc from "./gainc/index.js";
import * as Ghwave from "./ghwave/index.js";
import * as Sigproc from "./sigproc/index.js";
import * as Time2freq from "./time2freq/index.js";

export { ChannelBlock, Codec, Gainc, Ghwave, Sigproc, Time2freq };
