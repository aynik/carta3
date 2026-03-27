import { AT3_SFB_OFFSETS } from "./encode-tables.js";
import {
  AT3ENC_PROC_ACTIVE_BANDS_WORD,
  at3encProcBandModesView,
  at3encProcBandSelectorsView,
} from "./proc-layout.js";
import { getNontoneQuantMode } from "./proc-quant-modes.js";
import { at3BandScaleFromMode } from "./proc-quant-scale.js";
import { at3encPackBitsU16, at3encPackTableU16, at3encQuantIdxF32 } from "./frame-channel-pack.js";

/**
 * Writes the ATRAC3 non-tone spectral payload for one packed channel body:
 * active band count, band modes, claimed selectors, and packed coefficients.
 */
export function writeAtrac3SpectralPayload(procWords, spectrum, out, bitpos) {
  const bandCount = procWords[AT3ENC_PROC_ACTIVE_BANDS_WORD];
  const bandModes = at3encProcBandModesView(procWords);
  const bandSelectors = at3encProcBandSelectorsView(procWords);

  bitpos = at3encPackBitsU16(out, bitpos, (bandCount << 1) - 2, 6);
  for (let band = 0; band < bandCount; band += 1) {
    bitpos = at3encPackBitsU16(out, bitpos, bandModes[band], 3);
  }

  for (let band = 0; band < bandCount; band += 1) {
    if (bandModes[band] !== 0) {
      bitpos = at3encPackBitsU16(out, bitpos, bandSelectors[band], 6);
    }
  }

  for (let band = 0; band < bandCount; band += 1) {
    const bandMode = bandModes[band];
    const quantMode = getNontoneQuantMode(bandMode);
    if (quantMode?.bandPackTable === null) {
      continue;
    }

    const scale = at3BandScaleFromMode(bandMode, bandSelectors[band]);
    const start = AT3_SFB_OFFSETS[band];
    const end = AT3_SFB_OFFSETS[band + 1];
    const { bandPackTable, bandPackMask, bandPackCoefficients } = quantMode;

    for (let index = start; index < end; index += bandPackCoefficients) {
      let packedIndex = at3encQuantIdxF32(spectrum[index], scale, bandPackMask);
      if (bandPackCoefficients === 2) {
        packedIndex =
          (packedIndex << 2) | at3encQuantIdxF32(spectrum[index + 1], scale, bandPackMask);
      }
      bitpos = at3encPackTableU16(out, bitpos, bandPackTable, packedIndex);
    }
  }

  return bitpos;
}
