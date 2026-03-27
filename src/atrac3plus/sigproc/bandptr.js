import { AT5_SIGPROC_BANDS_MAX, AT5_SIGPROC_MAX_CHANNELS, AT5_SIGPROC_SLOTS } from "./constants.js";
import { bandSlotEndOffset, bandSlotOffset } from "./time-state.js";

export function at5BandPtr(table, slot, ch, band) {
  const idx =
    (slot | 0) * (AT5_SIGPROC_MAX_CHANNELS * AT5_SIGPROC_BANDS_MAX) +
    (ch | 0) * AT5_SIGPROC_BANDS_MAX +
    (band | 0);
  return table ? table[idx] : null;
}

export function buildAt5SigprocBandPtrTable(states, channels, out = null) {
  const total = AT5_SIGPROC_SLOTS * AT5_SIGPROC_MAX_CHANNELS * AT5_SIGPROC_BANDS_MAX;
  const table = Array.isArray(out) && out.length >= total ? out : new Array(total);
  table.fill(null, 0, total);

  for (let slot = 0; slot < AT5_SIGPROC_SLOTS; slot += 1) {
    for (let ch = 0; ch < (channels | 0) && ch < AT5_SIGPROC_MAX_CHANNELS; ch += 1) {
      const state = states[ch];
      if (!state?.bandSlot) {
        continue;
      }

      const ptrs = state?.bandPtrsBySlot?.[slot] ?? null;
      for (let band = 0; band < AT5_SIGPROC_BANDS_MAX; band += 1) {
        table[
          slot * (AT5_SIGPROC_MAX_CHANNELS * AT5_SIGPROC_BANDS_MAX) +
            ch * AT5_SIGPROC_BANDS_MAX +
            band
        ] =
          ptrs?.[band] ??
          state.bandSlot.subarray(bandSlotOffset(band, slot), bandSlotEndOffset(band));
      }
    }
  }

  return table;
}
