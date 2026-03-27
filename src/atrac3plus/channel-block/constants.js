import { AT5_Y } from "../tables/decode.js";

export { AT5_Y };

export const AT5_BANDS_MAX = 32;
export const AT5_CORE_MODE_MAX = 0x1f;
export const AT5_EXPANDED_BAND_LIMIT = 0x20;
export const AT5_EXPANDED_MAP_COUNT = 0x10;

const AT5_RESERVED_BAND_LIMIT_START = 0x1d;
const AT5_RESERVED_BAND_LIMIT_COUNT = 3;

export function at5BandLimitFallsInReservedGap(bandCount) {
  return ((bandCount | 0) - AT5_RESERVED_BAND_LIMIT_START) >>> 0 < AT5_RESERVED_BAND_LIMIT_COUNT;
}
