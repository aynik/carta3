const ATX_GH_BAND_COUNT = 16;
const ATX_GH_HALF_WINDOW_SAMPLES = 128;
const ATX_GH_WINDOW_SAMPLES = 256;
const ATX_GH_GATE_STRIDE = 4;
const ATX_GH_OVERLAP_MARGIN = 32;

function gateSampleIndex(idlocValue) {
  return (idlocValue | 0) * ATX_GH_GATE_STRIDE;
}

function bindGhEntry(state, entry) {
  state.entryCount = entry?.entryCount | 0;
  state.entries = entry?.entries ?? null;
  return state;
}

function resetGhBandSynthesisState(state, entry) {
  state.hasLeftFade = 0;
  state.hasRightFade = 0;
  state.leftIndex = 0;
  state.rightIndex = ATX_GH_WINDOW_SAMPLES;
  return bindGhEntry(state, entry);
}

function currentEntryHasStandaloneStart(entry) {
  return (entry?.idlocFlag0 | 0) !== 0 && (entry?.idlocValue1 | 0) > (entry?.idlocValue0 | 0);
}

export function createAt5GhBandSynthesisState() {
  return resetGhBandSynthesisState(
    {
      hasLeftFade: 0,
      hasRightFade: 0,
      leftIndex: 0,
      rightIndex: ATX_GH_WINDOW_SAMPLES,
      entryCount: 0,
      entries: null,
    },
    null
  );
}

export function createAt5GhSlotSynthesisState() {
  return Array.from({ length: ATX_GH_BAND_COUNT }, () => createAt5GhBandSynthesisState());
}

export function resolveGhBandStart(previousEntry, currentEntry) {
  if (!currentEntryHasStandaloneStart(currentEntry)) {
    if ((previousEntry?.idlocFlag0 | 0) === 0) {
      return { hasLeftFade: 0, leftIndex: 0 };
    }

    return {
      hasLeftFade: 1,
      leftIndex: gateSampleIndex(previousEntry?.idlocValue0),
    };
  }

  return {
    hasLeftFade: 1,
    leftIndex: gateSampleIndex(currentEntry?.idlocValue0) + ATX_GH_HALF_WINDOW_SAMPLES,
  };
}

function resolveCurrentBandEnd(currentEntry) {
  if ((currentEntry?.idlocFlag1 | 0) === 0) {
    return { hasRightFade: 0, rightIndex: ATX_GH_WINDOW_SAMPLES };
  }

  return {
    hasRightFade: 1,
    rightIndex: gateSampleIndex(currentEntry?.idlocValue1) + ATX_GH_HALF_WINDOW_SAMPLES,
  };
}

export function resolveGhBandEnd(previousEntry, currentEntry, leftIndex) {
  const previousEndIndex = gateSampleIndex(previousEntry?.idlocValue1);
  if ((previousEntry?.idlocFlag1 | 0) === 0 || previousEndIndex < (leftIndex | 0)) {
    return resolveCurrentBandEnd(currentEntry);
  }

  return {
    hasRightFade: 1,
    rightIndex: previousEndIndex,
  };
}

function clampGhBandRightIndex(rightIndex) {
  return Math.min((rightIndex | 0) + ATX_GH_GATE_STRIDE, ATX_GH_WINDOW_SAMPLES);
}

export function resolveGhBandSynthesisState(
  previousEntry,
  currentEntry,
  state = createAt5GhBandSynthesisState()
) {
  const currentState = resetGhBandSynthesisState(state, currentEntry);
  const { hasLeftFade, leftIndex } = resolveGhBandStart(previousEntry, currentEntry);
  currentState.hasLeftFade = hasLeftFade;
  currentState.leftIndex = leftIndex;

  const end = resolveGhBandEnd(previousEntry, currentEntry, leftIndex);
  currentState.hasRightFade = end.hasRightFade;
  currentState.rightIndex = clampGhBandRightIndex(end.rightIndex);
  return currentState;
}

export function shouldUseSeparateGhOverlapWindows(previousState, currentState) {
  const previousCount = previousState?.entryCount | 0;
  const currentCount = currentState?.entryCount | 0;
  if (previousCount < 1 || currentCount < 1) {
    return true;
  }

  return (previousState?.rightIndex | 0) - ATX_GH_OVERLAP_MARGIN < (currentState?.leftIndex | 0);
}

export function shouldApplyPreviousGhOverlapWindow(previousState, currentState) {
  if ((previousState?.entryCount | 0) < 1) {
    return false;
  }

  return (
    !shouldUseSeparateGhOverlapWindows(previousState, currentState) ||
    (previousState?.hasRightFade | 0) === 0
  );
}

export function shouldApplyCurrentGhOverlapWindow(previousState, currentState) {
  if ((currentState?.entryCount | 0) < 1) {
    return false;
  }

  return (
    !shouldUseSeparateGhOverlapWindows(previousState, currentState) ||
    (currentState?.hasLeftFade | 0) === 0
  );
}
