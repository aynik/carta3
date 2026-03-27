import {
  AT5_SIGPROC_BANDS_MAX,
  AT5_SIGPROC_FRAME_SAMPLES,
  AT5_SIGPROC_SLOTS,
  AT5_SIGPROC_SUBSAMPLES,
  AT5_SIGPROC_TAIL_SAMPLES,
  AT5_SIGPROC_WINDOW_SAMPLES,
} from "./constants.js";

// Layout helpers for the per-channel band-slot ring buffer.
export function bandSlotOffset(band, slot, sample = 0) {
  return (
    band * (AT5_SIGPROC_SLOTS * AT5_SIGPROC_SUBSAMPLES) + slot * AT5_SIGPROC_SUBSAMPLES + sample
  );
}

export function bandSlotEndOffset(band) {
  return bandSlotOffset(band, AT5_SIGPROC_SLOTS);
}

export function createAt5Time2freqState() {
  const bandSlot = new Float32Array(
    AT5_SIGPROC_BANDS_MAX * AT5_SIGPROC_SLOTS * AT5_SIGPROC_SUBSAMPLES
  );
  const bandPtrsBySlot = Array.from(
    { length: AT5_SIGPROC_SLOTS },
    () => new Array(AT5_SIGPROC_BANDS_MAX)
  );
  for (let slot = 0; slot < AT5_SIGPROC_SLOTS; slot += 1) {
    for (let band = 0; band < AT5_SIGPROC_BANDS_MAX; band += 1) {
      bandPtrsBySlot[slot][band] = bandSlot.subarray(
        bandSlotOffset(band, slot),
        bandSlotEndOffset(band)
      );
    }
  }

  // Per-channel sigproc scratch to avoid allocating a full window + band scratch on every frame.
  const window = new Float32Array(AT5_SIGPROC_WINDOW_SAMPLES);
  const windowPtrsByN = new Array(AT5_SIGPROC_SUBSAMPLES);
  for (let n = 0; n < AT5_SIGPROC_SUBSAMPLES; n += 1) {
    const xStart = 16 + n * 16;
    windowPtrsByN[n] = window.subarray(xStart, xStart + AT5_SIGPROC_TAIL_SAMPLES);
  }

  return {
    bandSlot,
    bandPtrsBySlot,
    tail: new Float32Array(AT5_SIGPROC_TAIL_SAMPLES),

    window,
    windowPtrsByN,
    windowTail: window.subarray(
      AT5_SIGPROC_FRAME_SAMPLES,
      AT5_SIGPROC_FRAME_SAMPLES + AT5_SIGPROC_TAIL_SAMPLES
    ),
    poly: new Float32Array(AT5_SIGPROC_BANDS_MAX),
    polyX87: new Float64Array(AT5_SIGPROC_BANDS_MAX),
    polyAcc: new Float64Array(AT5_SIGPROC_BANDS_MAX),
    bands: new Float32Array(AT5_SIGPROC_BANDS_MAX),
  };
}

export function at5SigprocShiftTimeState(state) {
  if (!state?.bandSlot) {
    return;
  }

  const bandSlot = state.bandSlot;
  for (let band = 0; band < AT5_SIGPROC_BANDS_MAX; band += 1) {
    const base = bandSlotOffset(band, 0);
    const end = bandSlotOffset(band, AT5_SIGPROC_SLOTS);
    bandSlot.copyWithin(base, base + AT5_SIGPROC_SUBSAMPLES, end);
    bandSlot.fill(0, bandSlotOffset(band, AT5_SIGPROC_SLOTS - 1), end);
  }
}
