export function at5SigprocRotateChannelBlocks(blocks, channels) {
  if (!blocks) {
    return;
  }

  for (let ch = 0; ch < (channels | 0); ch += 1) {
    const block = blocks[ch];
    if (!block) {
      continue;
    }

    // Swap gain-record buffers so the "current" frame becomes the "previous" one.
    // Keep legacy bufA/bufB aliases in sync for older code paths.
    const curBuf = block.curBuf ?? block.bufA;
    const prevBuf = block.prevBuf ?? block.bufB;
    block.prevBuf = curBuf;
    block.curBuf = prevBuf;
    block.bufA = block.curBuf;
    block.bufB = block.prevBuf;

    if (Array.isArray(block.slots) && block.slots.length >= 5) {
      const first = block.slots[0];
      for (let i = 0; i < 4; i += 1) {
        block.slots[i] = block.slots[i + 1];
      }
      block.slots[4] = first;
    }
  }
}
