import { at5HcPackedSymbolCount } from "../bitstream/internal.js";
import {
  AT5_HC_GROUP_MASK_BY_MODE,
  AT5_HC_GROUP_Q_BY_MODE,
  AT5_HC_SPEC_LIMIT_BY_TBL,
  AT5_MASK_Q,
} from "../tables/encode-bitalloc.js";
import { AT5_HC_HCSPEC, AT5_IDCT_INDEX } from "../tables/unpack.js";
import { CodecError } from "../../common/errors.js";
import { quantAt5 } from "./quantize.js";

function absI16ToU16(value) {
  const v = value | 0;
  return v < 0 ? -v & 0xffff : v & 0xffff;
}

function at5AbsCoeffsAndNonzeroCount(srcI16, dstU16, count) {
  let nonzero = 0;
  for (let i = 0; i < (count | 0); i += 1) {
    const value = srcI16[i] | 0;
    nonzero += value !== 0 ? 1 : 0;
    dstU16[i] = absI16ToU16(value);
  }
  return nonzero | 0;
}

function at5HuffLen(codes4, symbol) {
  const sym = symbol | 0;
  const idx = (sym * 4 + 2) | 0;
  return codes4[idx] | 0;
}

function countHuffmanBits(data, limit, codes4, nonzeroChunkSize) {
  const chunkSize = nonzeroChunkSize | 0;
  if (chunkSize === 0) {
    return 0;
  }

  let bits = 0;
  for (let i = 0; i < (limit | 0); i += 4) {
    const w0 = data[i + 0] | 0;
    const w1 = data[i + 1] | 0;
    const w2 = data[i + 2] | 0;
    const w3 = data[i + 3] | 0;

    if (chunkSize === 2) {
      bits += 2;
      for (let pair = 0; pair < 4; pair += 2) {
        if (((data[i + pair] | data[i + pair + 1]) & 0xffff) === 0) {
          continue;
        }
        bits += at5HuffLen(codes4, data[i + pair]);
        bits += at5HuffLen(codes4, data[i + pair + 1]);
      }
      continue;
    }

    if (chunkSize === 4) {
      bits += 1;
      if (((w0 | w1 | w2 | w3) & 0xffff) === 0) {
        continue;
      }
    }

    bits += at5HuffLen(codes4, w0);
    bits += at5HuffLen(codes4, w1);
    bits += at5HuffLen(codes4, w2);
    bits += at5HuffLen(codes4, w3);
  }
  return bits | 0;
}

function packGroupedSymbols(srcBytes, count, mode, q, maskIn, dstU16) {
  const cnt = count | 0;
  const m = mode | 0;
  const qq = q | 0;
  const maskQ = AT5_MASK_Q[qq] >>> 0;
  const shiftBits = qq & 31;

  if (m === 1) {
    const srcU16 = new Uint16Array(srcBytes.buffer, srcBytes.byteOffset, cnt);
    const mask16 = maskIn & 0xffff;
    for (let i = 0; i < cnt; i += 1) {
      dstU16[i] = srcU16[i] & mask16;
    }
    return;
  }

  if (m !== 2 && m !== 4) {
    return;
  }

  const rowStride = m << 1;
  const chunkBytes = rowStride << 2;
  const chunkCoeffs = m << 2;

  for (let srcIndex = 0, outIndex = 0, processed = 0; processed < cnt; processed += chunkCoeffs) {
    let packed = 0;
    for (let column = 0; column < m; column += 1) {
      let groupWord = 0;
      for (let row = 0; row < 4; row += 1) {
        groupWord = ((groupWord << 8) | srcBytes[srcIndex + column * 2 + row * rowStride]) >>> 0;
      }
      packed = (((packed << shiftBits) >>> 0) | (groupWord & maskQ)) >>> 0;
    }

    dstU16[outIndex + 0] = (packed >>> 24) & 0xff;
    dstU16[outIndex + 1] = (packed >>> 16) & 0xff;
    dstU16[outIndex + 2] = (packed >>> 8) & 0xff;
    dstU16[outIndex + 3] = packed & 0xff;

    srcIndex += chunkBytes;
    outIndex += 0x4;
  }
}

function hcspecDescForQuantCost(ctxId, tblIndex, mode, idctCand) {
  const ctx = ctxId & 1;
  const m = mode | 0;
  if (m <= 0) {
    return AT5_HC_HCSPEC[0];
  }

  const modeIndex = (m - 1) | 0;
  let idctIndex = idctCand | 0;
  if ((tblIndex | 0) === 0) {
    const idctBase = ((ctx * 7 + modeIndex) * 4) | 0;
    idctIndex = AT5_IDCT_INDEX[idctBase + (idctCand | 0)] | 0;
  }

  const descIndex = (ctx * 56 + idctIndex * 7 + modeIndex) | 0;
  return AT5_HC_HCSPEC[descIndex] ?? AT5_HC_HCSPEC[0];
}

function prepareQuantCostTables(ctxId, mode, offset, scale, count, spec, block) {
  const scratch = block?.quantScratch;
  if (!scratch) {
    throw new CodecError("quantNontoneNspecsAt5: missing block.quantScratch");
  }
  const ctx = ctxId | 0;
  const m = mode | 0;
  const off = offset >>> 0;
  const n = count >>> 0;
  const quantBuf = scratch.quantBufI16;
  const groupedTables = [
    null,
    scratch.groupedMode1U16,
    scratch.groupedMode2U16,
    null,
    scratch.groupedMode4U16,
  ];
  const extraTables = [
    null,
    scratch.absBufU16,
    scratch.absGroupedMode2U16,
    null,
    scratch.absGroupedMode4U16,
  ];
  const mask = AT5_HC_GROUP_MASK_BY_MODE[m] ?? 0;
  const q = AT5_HC_GROUP_Q_BY_MODE[m] ?? 0;

  quantAt5(spec, quantBuf, m, off, scale, n);

  if (m === 1) {
    packGroupedSymbols(scratch.quantBufBytes, n, 4, q, mask, groupedTables[4]);
  }

  const needsAbsCount = m !== 1 || ctx === 0;
  const nonzeroCount = needsAbsCount ? at5AbsCoeffsAndNonzeroCount(quantBuf, extraTables[1], n) : 0;

  const absGroupMode = m <= 3 ? (m >= 2 ? 4 : ctx === 0 ? 2 : 0) : m >= 6 ? 2 : 0;
  if (absGroupMode !== 0) {
    const hiIndex = m + 8;
    packGroupedSymbols(
      scratch.absBufBytes,
      n,
      absGroupMode,
      AT5_HC_GROUP_Q_BY_MODE[hiIndex] ?? 0,
      AT5_HC_GROUP_MASK_BY_MODE[hiIndex] ?? 0,
      extraTables[absGroupMode]
    );
  }

  if ((m >= 2 && m <= 5) || (m === 1 && ctx === 0)) {
    packGroupedSymbols(scratch.quantBufBytes, n, 2, q, mask, groupedTables[2]);
  }

  if (m === 3 || m >= 6 || (m === 4 && ctx === 1) || (m === 5 && ctx === 0)) {
    packGroupedSymbols(scratch.quantBufBytes, n, 1, q, mask, groupedTables[1]);
  }

  return { nonzeroCount, groupedTables, extraTables };
}

export function quantNontoneNspecsAt5(ctxId, band, mode, offset, scale, count, spec, work, block) {
  const ctx = ctxId | 0;
  const m = mode | 0;
  const n = count >>> 0;

  if (n === 0 || m <= 0 || m > 7) {
    return;
  }

  const tblIndex = block?.bitallocHeader?.tblIndex ?? 0;
  const limit = AT5_HC_SPEC_LIMIT_BY_TBL[tblIndex | 0] | 0;
  if (limit <= 0) {
    return;
  }

  const prepared = prepareQuantCostTables(ctx, m, offset, scale, n, spec, block);
  const bandBase = (band | 0) << 3;
  for (let i = 0; i < limit; i += 1) {
    const desc = hcspecDescForQuantCost(ctx, tblIndex, m, i);
    const codes4 = desc?.codes;
    if (!(codes4 instanceof Uint8Array)) {
      work.costsByBand[bandBase + i] = 0xffff;
      continue;
    }

    const usesSeparateSignBits = desc?.usesSeparateSignBits >>> 0;
    const groupSize = desc?.coeffsPerSymbol >>> 0;
    const shiftedCount = at5HcPackedSymbolCount(desc, n);
    const baseCost = usesSeparateSignBits !== 0 ? prepared.nonzeroCount : 0;
    const data = (usesSeparateSignBits !== 0 ? prepared.extraTables : prepared.groupedTables)[
      groupSize
    ];
    if (!(data instanceof Uint16Array)) {
      work.costsByBand[bandBase + i] = 0xffff;
      continue;
    }
    work.costsByBand[bandBase + i] =
      (baseCost + countHuffmanBits(data, shiftedCount, codes4, desc?.nonzeroChunkSize ?? 0)) &
      0xffff;
  }
}
