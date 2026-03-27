import {
  AT5_HC_HCSPEC,
  AT5_IDCT_INDEX,
  AT5_IDSPCBANDS,
  AT5_ISPS,
  AT5_NSPS,
} from "../tables/unpack.js";
import {
  at5DecodeSym,
  at5HcPackedSymbolCount,
  at5HcValueMask,
  at5PackStoreFromMsb,
  at5PackSym,
  at5ReadBits,
} from "./bits.js";

const AT5_SPECTRA_WORDS = 0x800;
const AT5_SPCLEV_COUNT = 5;
const AT5_HCSPEC_SCRATCH_SYMBOLS = 128;
const gHcspecScratchByBitState = new WeakMap();

function getHcspecScratch(bitState) {
  if (!bitState || typeof bitState !== "object") {
    return {
      symbols: new Uint16Array(AT5_HCSPEC_SCRATCH_SYMBOLS),
      extraCounts: new Uint8Array(AT5_HCSPEC_SCRATCH_SYMBOLS),
      extraBits: new Uint32Array(AT5_HCSPEC_SCRATCH_SYMBOLS),
    };
  }

  let scratch = gHcspecScratchByBitState.get(bitState);
  if (!scratch) {
    scratch = {
      symbols: new Uint16Array(AT5_HCSPEC_SCRATCH_SYMBOLS),
      extraCounts: new Uint8Array(AT5_HCSPEC_SCRATCH_SYMBOLS),
      extraBits: new Uint32Array(AT5_HCSPEC_SCRATCH_SYMBOLS),
    };
    gHcspecScratchByBitState.set(bitState, scratch);
  }
  return scratch;
}

const AT5_HCSPEC_MODE_COUNT = 7;
const AT5_HCSPEC_DESC_COUNT_PER_CTX = 56;
const AT5_HCSPEC_IDCT_INDEX_CTX_STRIDE = 0x1c;
const AT5_HCSPEC_IDCT_INDEX_MODE_STRIDE = 4;

function clampU32(value) {
  return value >>> 0;
}

function toInt32(value) {
  return value | 0;
}

function signExtend(raw, bits) {
  if (bits === 0) {
    return raw | 0;
  }
  const shift = 32 - bits;
  return (raw << shift) >> shift;
}

function hcspecValueBits(desc) {
  const mask = at5HcValueMask(desc) >>> 0;
  return mask === 0 ? 0 : 32 - Math.clz32(mask);
}

function clampDescIndex(index) {
  if (index >= 0 && index < AT5_HC_HCSPEC.length) {
    return index;
  }
  return 0;
}

export function at5PackHcspecForBand(coeffs, coeffCount, desc, dst, bitState) {
  const groupSize = desc?.coeffsPerSymbol >>> 0;
  const nonzeroChunkSize = desc?.nonzeroChunkSize >>> 0;
  const usesSeparateSignBits = desc?.usesSeparateSignBits >>> 0;
  const valueBits = hcspecValueBits(desc) >>> 0;
  const valueMask = at5HcValueMask(desc) >>> 0;
  const packedCount = at5HcPackedSymbolCount(desc, coeffCount);
  if (packedCount === 0 || groupSize === 0) {
    return true;
  }

  const { symbols, extraCounts, extraBits } = getHcspecScratch(bitState);

  for (let symbolIndex = 0; symbolIndex < packedCount; symbolIndex += 1) {
    let symbol = 0;
    let extra = 0;
    let extraCount = 0;

    for (let coeffIndex = 0; coeffIndex < groupSize; coeffIndex += 1) {
      const index = symbolIndex * groupSize + coeffIndex;
      const coeff = index < coeffCount ? toInt32(coeffs[index]) : 0;

      const raw =
        usesSeparateSignBits === 0
          ? clampU32(coeff) & valueMask
          : (Math.abs(coeff) >>> 0) & valueMask;
      const shiftBits = valueBits * (groupSize - coeffIndex - 1);
      symbol |= raw << (shiftBits & 31);

      if (usesSeparateSignBits !== 0 && raw !== 0) {
        extra = (extra << 1) | (coeff < 0 ? 1 : 0);
        extraCount += 1;
      }
    }

    symbols[symbolIndex] = symbol & 0xffff;
    extraCounts[symbolIndex] = extraCount & 0xff;
    extraBits[symbolIndex] = clampU32(extra);
  }

  if (nonzeroChunkSize <= 1) {
    for (let index = 0; index < packedCount; index += 1) {
      const symbol = symbols[index] >>> 0;
      if (!at5PackSym(desc, symbol, dst, bitState)) {
        return false;
      }
      if (usesSeparateSignBits !== 0 && symbol !== 0) {
        const count = extraCounts[index] >>> 0;
        if (count !== 0 && !at5PackStoreFromMsb(extraBits[index], count, dst, bitState)) {
          return false;
        }
      }
    }
    return true;
  }

  const chunkSize = nonzeroChunkSize >>> 0;
  let position = 0;

  while (position < packedCount) {
    const end = position + chunkSize <= packedCount ? position + chunkSize : packedCount;

    let anyNonzero = 0;
    for (let index = position; index < end; index += 1) {
      if (symbols[index] >>> 0 !== 0) {
        anyNonzero = 1;
        break;
      }
    }

    if (!at5PackStoreFromMsb(anyNonzero, 1, dst, bitState)) {
      return false;
    }
    if (anyNonzero === 0) {
      position = end;
      continue;
    }

    for (let index = position; index < end; index += 1) {
      const symbol = symbols[index] >>> 0;
      if (!at5PackSym(desc, symbol, dst, bitState)) {
        return false;
      }
      if (usesSeparateSignBits !== 0 && symbol !== 0) {
        const count = extraCounts[index] >>> 0;
        if (count !== 0 && !at5PackStoreFromMsb(extraBits[index], count, dst, bitState)) {
          return false;
        }
      }
    }

    position = end;
  }

  return true;
}

export function at5HcspecDescForBand(shared, channel, band) {
  const mode = channel.idwl.values[band] >>> 0;
  const idctValue = channel.idct.values[band] >>> 0;
  const context = channel.idctTableCtx & 1;

  if (mode === 0) {
    return AT5_HC_HCSPEC[0];
  }

  let idctIndex = idctValue;
  if (shared.gainModeFlag >>> 0 === 0) {
    const tableIndex =
      mode * AT5_HCSPEC_IDCT_INDEX_MODE_STRIDE +
      idctValue +
      context * AT5_HCSPEC_IDCT_INDEX_CTX_STRIDE;
    idctIndex = AT5_IDCT_INDEX[tableIndex] ?? 0;
  }

  const modeIndex = mode - 1;
  const descIndex =
    context * AT5_HCSPEC_DESC_COUNT_PER_CTX + idctIndex * AT5_HCSPEC_MODE_COUNT + modeIndex;
  return AT5_HC_HCSPEC[clampDescIndex(descIndex)];
}

export function at5DecodeHcspecSymbols(
  symbols,
  extraCounts,
  extraBits,
  packedCount,
  desc,
  frame,
  bitState
) {
  const groupSize = desc?.coeffsPerSymbol >>> 0;
  const nonzeroChunkSize = desc?.nonzeroChunkSize >>> 0;
  const usesSeparateSignBits = desc?.usesSeparateSignBits >>> 0;
  const valueBits = hcspecValueBits(desc) >>> 0;
  const valueMask = at5HcValueMask(desc) >>> 0;

  for (let index = 0; index < packedCount; index += 1) {
    symbols[index] = 0;
    extraCounts[index] = 0;
    extraBits[index] = 0;
  }
  if (packedCount === 0) {
    return;
  }

  const chunkSize = nonzeroChunkSize > 1 ? nonzeroChunkSize : 1;
  let position = 0;

  while (position < packedCount) {
    let decodeChunk = true;
    if (nonzeroChunkSize > 1) {
      decodeChunk = at5ReadBits(frame, bitState, 1) !== 0;
    }

    const end = Math.min(position + chunkSize, packedCount);
    if (!decodeChunk) {
      position = end;
      continue;
    }

    for (let index = position; index < end; index += 1) {
      const symbol = at5DecodeSym(desc, frame, bitState) >>> 0;
      symbols[index] = symbol;

      if (usesSeparateSignBits !== 0 && symbol !== 0) {
        let count = 0;
        for (let coeffIndex = 0; coeffIndex < groupSize; coeffIndex += 1) {
          const shift = valueBits * (groupSize - coeffIndex - 1);
          if ((symbol & (valueMask << (shift & 31))) !== 0) {
            count += 1;
          }
        }

        extraCounts[index] = count;
        extraBits[index] = count === 0 ? 0 : at5ReadBits(frame, bitState, count);
      }
    }

    position = end;
  }
}

export function at5ExpandHcspecToCoeffs(
  out,
  outCount,
  symbols,
  extraCounts,
  extraBits,
  packedCount,
  desc
) {
  const groupSize = desc?.coeffsPerSymbol >>> 0;
  const usesSeparateSignBits = desc?.usesSeparateSignBits >>> 0;
  const valueBits = hcspecValueBits(desc) >>> 0;
  const valueMask = at5HcValueMask(desc) >>> 0;

  let outPosition = 0;
  for (let symbolIndex = 0; symbolIndex < packedCount && outPosition < outCount; symbolIndex += 1) {
    const symbol = symbols[symbolIndex] >>> 0;
    let signMask = 0;
    if (usesSeparateSignBits !== 0) {
      const count = extraCounts[symbolIndex] >>> 0;
      signMask = count === 0 ? 0 : 1 << ((count - 1) & 31);
    }

    for (let coeffIndex = 0; coeffIndex < groupSize && outPosition < outCount; coeffIndex += 1) {
      const shift = valueBits * (groupSize - coeffIndex - 1);
      const raw = (symbol >>> (shift & 31)) & valueMask;
      let value = 0;

      if (usesSeparateSignBits === 0) {
        value = signExtend(raw, valueBits);
      } else if (raw !== 0) {
        const negative = signMask !== 0 ? (extraBits[symbolIndex] & signMask) !== 0 : false;
        signMask >>>= 1;
        value = negative ? -raw : raw;
      }

      out[outPosition] = value;
      outPosition += 1;
    }
  }
}

function decodeSpectraBand(channel, shared, frame, bitState, band) {
  const mode = channel.idwl.values[band] >>> 0;
  if (mode === 0) {
    return;
  }

  const coeffCount = AT5_NSPS[band] ?? 0;
  if (coeffCount === 0) {
    return;
  }

  const desc = at5HcspecDescForBand(shared, channel, band);
  const packedCount = at5HcPackedSymbolCount(desc, coeffCount);

  const { symbols, extraCounts, extraBits } = getHcspecScratch(bitState);
  at5DecodeHcspecSymbols(symbols, extraCounts, extraBits, packedCount, desc, frame, bitState);

  const start = AT5_ISPS[band] ?? 0;
  const output = channel.scratchSpectra.subarray(start);
  at5ExpandHcspecToCoeffs(output, coeffCount, symbols, extraCounts, extraBits, packedCount, desc);
}

export function createAt5SpectraChannelState() {
  return {
    scratchSpectra: new Int16Array(AT5_SPECTRA_WORDS),
    spclevIndex: new Uint32Array(AT5_SPCLEV_COUNT).fill(0xf),
  };
}

export function unpackChannelSpectra(channel, shared, frame, bitState) {
  channel.scratchSpectra.fill(0);
  channel.spclevIndex.fill(0xf);

  const bandCount = shared.idsfCount >>> 0;
  for (let band = 0; band < bandCount; band += 1) {
    decodeSpectraBand(channel, shared, frame, bitState, band);
  }

  if (bandCount > 2 && shared.mapCount >>> 0 > 0) {
    const lastMap = (shared.mapCount >>> 0) - 1;
    const maxBand = AT5_IDSPCBANDS[lastMap] ?? 0xff;
    if (maxBand !== 0xff) {
      const count = (maxBand >>> 0) + 1;
      for (let index = 0; index < count && index < channel.spclevIndex.length; index += 1) {
        channel.spclevIndex[index] = at5ReadBits(frame, bitState, 4);
      }
    }
  }
}
