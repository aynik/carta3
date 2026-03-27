/**
 * Internal ATRAC3plus subsystem map.
 *
 * The stable codec root in `index.js` exposes the major analysis, block, and
 * codec lifecycle stages. Lower-level bitstream, DSP, codec, channel-block,
 * and gain-control helper surfaces stay here.
 */
import * as Bitstream from "./bitstream/internal.js";
import * as ChannelBlock from "./channel-block/internal.js";
import * as Codec from "./codec-internal.js";
import * as Dsp from "./dsp.js";
import * as Gainc from "./gainc/internal.js";
import * as Ghwave from "./ghwave/internal.js";
import * as Sigproc from "./sigproc/internal.js";
import * as Time2freq from "./time2freq/internal.js";

export { Bitstream, ChannelBlock, Codec, Dsp, Gainc, Ghwave, Sigproc, Time2freq };
