/**
 * Stable ATRAC3plus bitstream helper entrypoint.
 *
 * The implementation is split into low-level bit/symbol coding, presence-map
 * handling, and spectra/HCSPEC decoding so the codec internals can import the
 * specific layer they need while this module preserves the existing surface.
 */
export {
  at5DecodeSym,
  at5HcPackedSymbolCount,
  at5HcValueMask,
  at5PackStoreFromMsb,
  at5PackSym,
  at5ReadBits,
  at5ReadBits24,
  at5SignExtend3Bit,
  at5SignExtend5Bit,
} from "./bits.js";
export {
  createAt5PresenceTable,
  decodeAt5Presence,
  updateAt5PresenceTableBits,
} from "./presence.js";
export {
  at5DecodeHcspecSymbols,
  at5ExpandHcspecToCoeffs,
  at5HcspecDescForBand,
  at5PackHcspecForBand,
  createAt5SpectraChannelState,
  unpackChannelSpectra,
} from "./spectra.js";
