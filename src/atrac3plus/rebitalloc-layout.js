const AT5_REBITALLOC_WORD_BYTES = 4;
const AT5_REBITALLOC_PACK_STATE_HEADER_WORDS = 3;
const AT5_REBITALLOC_BAND_SLOTS = 32;

const AT5_REBITALLOC_PACK_MODE_OFFSET = 0;
const AT5_REBITALLOC_PACK_BAND_COUNT_OFFSET = AT5_REBITALLOC_WORD_BYTES;
const AT5_REBITALLOC_PACK_FLAG_OFFSET = AT5_REBITALLOC_WORD_BYTES * 2;
const AT5_REBITALLOC_PACK_TYPES_OFFSET =
  AT5_REBITALLOC_PACK_STATE_HEADER_WORDS * AT5_REBITALLOC_WORD_BYTES;
const AT5_REBITALLOC_MIRROR_CONFIG_BYTES = AT5_REBITALLOC_PACK_TYPES_OFFSET;
const AT5_REBITALLOC_SPEC_INDEX_OFFSET =
  AT5_REBITALLOC_PACK_TYPES_OFFSET + AT5_REBITALLOC_BAND_SLOTS * AT5_REBITALLOC_WORD_BYTES;
const AT5_REBITALLOC_BASE_INDEX_WORD_OFFSET =
  AT5_REBITALLOC_SPEC_INDEX_OFFSET + AT5_REBITALLOC_BAND_SLOTS * AT5_REBITALLOC_WORD_BYTES;

const AT5_REBITALLOC_PACK_STATE_BYTES = AT5_REBITALLOC_SPEC_INDEX_OFFSET;
const AT5_REBITALLOC_SCRATCH_BYTES =
  AT5_REBITALLOC_BASE_INDEX_WORD_OFFSET + AT5_REBITALLOC_WORD_BYTES;

/**
 * Shared byte layout used by the live rebitalloc scratch and the compact
 * mirror copied back onto runtime channels after the solve commits.
 */

function dataViewForBytes(bytes, minimumByteLength) {
  return bytes instanceof Uint8Array && bytes.byteLength >= minimumByteLength
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : null;
}

function createAt5RebitallocPackState(bytes) {
  const view = dataViewForBytes(bytes, AT5_REBITALLOC_PACK_STATE_BYTES);
  if (!view) {
    return null;
  }

  const types = new Uint32Array(
    bytes.buffer,
    bytes.byteOffset + AT5_REBITALLOC_PACK_TYPES_OFFSET,
    AT5_REBITALLOC_BAND_SLOTS
  );
  return {
    bytes,
    types,
    get mode() {
      return view.getUint32(AT5_REBITALLOC_PACK_MODE_OFFSET, true);
    },
    set mode(value) {
      view.setUint32(AT5_REBITALLOC_PACK_MODE_OFFSET, value >>> 0, true);
    },
    get bandCount() {
      return view.getUint32(AT5_REBITALLOC_PACK_BAND_COUNT_OFFSET, true);
    },
    set bandCount(value) {
      view.setUint32(AT5_REBITALLOC_PACK_BAND_COUNT_OFFSET, value >>> 0, true);
    },
    get flag() {
      return view.getUint32(AT5_REBITALLOC_PACK_FLAG_OFFSET, true);
    },
    set flag(value) {
      view.setUint32(AT5_REBITALLOC_PACK_FLAG_OFFSET, value >>> 0, true);
    },
  };
}

export function at5RebitallocPackState(value) {
  const packState = value?.packState ?? value?.rebitallocMirror ?? null;
  if (
    packState?.bytes instanceof Uint8Array &&
    packState?.types instanceof Uint32Array &&
    packState.types.length === AT5_REBITALLOC_BAND_SLOTS
  ) {
    return packState;
  }

  const bytes = value?.packStateBytes ?? value?.rebitallocMirrorBytes ?? value?.bytes ?? value;
  return createAt5RebitallocPackState(bytes);
}

export function readAt5RebitallocMirrorConfig(value) {
  const bytes = value?.rebitallocMirrorBytes ?? value;
  const view = dataViewForBytes(bytes, AT5_REBITALLOC_MIRROR_CONFIG_BYTES);
  if (!view) {
    return null;
  }

  return {
    mode: view.getInt32(AT5_REBITALLOC_PACK_MODE_OFFSET, true),
    bandCount: view.getInt32(AT5_REBITALLOC_PACK_BAND_COUNT_OFFSET, true),
    flag: view.getUint32(AT5_REBITALLOC_PACK_FLAG_OFFSET, true),
  };
}

export function createAt5RebitallocScratch() {
  const bytes = new Uint8Array(AT5_REBITALLOC_SCRATCH_BYTES);
  const packStateBytes = bytes.subarray(0, AT5_REBITALLOC_PACK_STATE_BYTES);
  const packState = createAt5RebitallocPackState(packStateBytes);
  const baseSpecIndexWord = new Uint32Array(
    bytes.buffer,
    bytes.byteOffset + AT5_REBITALLOC_BASE_INDEX_WORD_OFFSET,
    1
  );

  return {
    bytes,
    packState,
    packStateBytes,
    specIndexByBand: new Int32Array(
      bytes.buffer,
      bytes.byteOffset + AT5_REBITALLOC_SPEC_INDEX_OFFSET,
      AT5_REBITALLOC_BAND_SLOTS
    ),
    baseSpecIndexWord,
  };
}

function ensureAt5RebitallocMirror(channel) {
  let bytes = channel?.rebitallocMirrorBytes ?? null;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < AT5_REBITALLOC_PACK_STATE_BYTES) {
    bytes = new Uint8Array(AT5_REBITALLOC_PACK_STATE_BYTES);
    if (channel) {
      channel.rebitallocMirrorBytes = bytes;
    }
  }

  const existingMirror = channel?.rebitallocMirror ?? null;
  if (existingMirror?.bytes === bytes && existingMirror?.types instanceof Uint32Array) {
    return existingMirror;
  }

  const mirror = createAt5RebitallocPackState(bytes);
  if (channel && mirror) {
    channel.rebitallocMirror = mirror;
  }
  return mirror;
}

export function copyAt5RebitallocMirror(channel, scratch, bandCount) {
  const source = at5RebitallocPackState(scratch);
  if (!source) {
    return;
  }
  const target = ensureAt5RebitallocMirror(channel);
  if (!target) {
    return;
  }

  target.bytes.fill(0);
  target.mode = source.mode;
  target.bandCount = source.bandCount;
  target.flag = source.flag;

  const limit = Math.max(0, Math.min(bandCount | 0, source.types.length, target.types.length));
  target.types.set(source.types.subarray(0, limit), 0);
}
