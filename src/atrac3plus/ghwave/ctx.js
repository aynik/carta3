export function analysisCtxForSlot(slot, band) {
  if (!slot || !Array.isArray(slot.records)) {
    return null;
  }
  const b = band | 0;
  if (b < 0 || b >= slot.records.length) {
    return null;
  }
  return slot.records[b] ?? null;
}

export function analysisCtxForSlotConst(slot, band) {
  return analysisCtxForSlot(slot, band);
}
