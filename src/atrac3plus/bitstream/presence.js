import { at5ReadBits } from "./bits.js";

const AT5_PRESENCE_FLAG_SLOTS = 16;

export function createAt5PresenceTable() {
  return {
    enabled: 0,
    mixed: 0,
    flags: new Uint32Array(AT5_PRESENCE_FLAG_SLOTS),
  };
}

export function updateAt5PresenceTableBits(table, count) {
  const flagCount = count >>> 0;
  if (!table) {
    return 1;
  }

  if (flagCount === 0) {
    table.enabled = 0;
    table.mixed = 0;
    return 1;
  }

  const { flags } = table;
  const limit = Math.min(flagCount, flags?.length ?? 0);
  let enabledCount = 0;
  for (let index = 0; index < limit; index += 1) {
    enabledCount += flags[index] >>> 0;
  }

  if (enabledCount === 0) {
    table.enabled = 0;
    table.mixed = 0;
    return 1;
  }
  if (enabledCount === limit) {
    table.enabled = 1;
    table.mixed = 0;
    return 2;
  }

  table.enabled = 1;
  table.mixed = 1;
  return (limit + 2) | 0;
}

export function decodeAt5Presence(table, count, frame, bitState) {
  table.flags.fill(0);

  table.enabled = at5ReadBits(frame, bitState, 1) >>> 0;
  if (table.enabled === 0) {
    table.mixed = 0;
    return;
  }

  table.mixed = at5ReadBits(frame, bitState, 1) >>> 0;
  if (table.mixed === 0) {
    for (let index = 0; index < count && index < table.flags.length; index += 1) {
      table.flags[index] = 1;
    }
    return;
  }

  for (let index = 0; index < count && index < table.flags.length; index += 1) {
    table.flags[index] = at5ReadBits(frame, bitState, 1) >>> 0;
  }
}
