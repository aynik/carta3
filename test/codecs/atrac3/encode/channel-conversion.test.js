import assert from "node:assert/strict";
import test from "node:test";

import {
  AT3_CHCONV_INITIAL_OPEN_MIX_CODE,
  AT3_CHCONV_MODE_BALANCED,
  AT3_CHCONV_MODE_LEGACY_OPEN_PASSTHROUGH,
  AT3_CHCONV_MODE_PRIMARY_DOMINANT,
  AT3_CHCONV_MODE_SECONDARY_DOMINANT,
  createChannelConversionState,
  selectChannelConversion,
  slotUsesTransitionWindow,
} from "../../../../src/atrac3/channel-conversion-analysis.js";
import { at3encApplyChannelConversion } from "../../../../src/atrac3/channel-conversion-apply.js";

function createSlotBands(levels) {
  const bands = new Float32Array(1024);
  for (let slot = 0; slot < 4; slot += 1) {
    for (let idx = slot; idx < 1024; idx += 4) {
      bands[idx] = levels[slot];
    }
  }
  return bands;
}

function assertFloatArrayClose(actual, expected, epsilon = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= epsilon,
      `index ${i}: expected ${expected[i]}, got ${actual[i]}`
    );
  }
}

function summarizeSlotModes(state) {
  return state.slots.map((slot) => slot.mode);
}

function summarizeSlotHints(state) {
  return state.slots.map((slot) => slot.modeHint);
}

function summarizeMixLevels(state) {
  return state.slots.map((slot) => slot.mixLevel);
}

function summarizeTransitionWindows(state) {
  return state.slots.map((slot) => slotUsesTransitionWindow(slot));
}

function createConversionState({
  slotLimit = 2,
  modeBySlot = [
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_PRIMARY_DOMINANT,
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
  ],
  modeHints = [
    AT3_CHCONV_MODE_PRIMARY_DOMINANT,
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
    AT3_CHCONV_MODE_BALANCED,
  ],
  prevOutput = 5,
  output = 11,
  mixLevels = [1, 1, 1, 1],
  magnitudes = [
    { primary: 10, secondary: 20 },
    { primary: 0, secondary: 0 },
    { primary: 0, secondary: 0 },
    { primary: 0, secondary: 0 },
  ],
  left = [1, 2, 3, 4],
  right = [5, 6, 7, 8],
} = {}) {
  const channelConversion = createChannelConversionState(slotLimit, { enabled: true });
  for (const [slot, mode] of modeBySlot.entries()) {
    channelConversion.slots[slot].mode = mode;
  }
  for (const [slot, modeHint] of modeHints.entries()) {
    channelConversion.slots[slot].modeHint = modeHint;
  }
  channelConversion.mixCode.previous = prevOutput;
  channelConversion.mixCode.current = output;
  for (const [slot, mixLevel] of mixLevels.entries()) {
    channelConversion.slots[slot].mixLevel = mixLevel;
  }
  for (const [slot, magnitudeState] of magnitudes.entries()) {
    Object.assign(channelConversion.slots[slot].magnitudeSums, magnitudeState);
  }

  const primaryLayer = { spectrum: createSlotBands(left) };
  const secondaryLayer = { spectrum: createSlotBands(right) };

  return {
    channelConversion,
    primaryLayer,
    secondaryLayer,
    layers: [primaryLayer, secondaryLayer],
  };
}

test("createChannelConversionState preserves the current scratch layout", () => {
  const state = createChannelConversionState(2);

  assert.equal(state.slotLimit, 2);
  assert.equal(state.slots.length, 4);
  assert.deepEqual(summarizeSlotHints(state), [0, 0, 0, 0]);
  assert.deepEqual(summarizeSlotModes(state), [0, 0, 0, 0]);
  assert.deepEqual(summarizeTransitionWindows(state), [false, false, false, false]);
  assert.deepEqual(state.slots[0].magnitudeSums, { primary: 0, secondary: 0 });
  assertFloatArrayClose(summarizeMixLevels(state), [0, 0, 0, 0]);
});

test("selectChannelConversion preserves current slot modes, magnitude sums, and output coding", () => {
  const state = createChannelConversionState(2);
  state.mixCode.current = 5;
  for (const [slot, mode] of [
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
    AT3_CHCONV_MODE_PRIMARY_DOMINANT,
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_BALANCED,
  ].entries()) {
    state.slots[slot].mode = mode;
  }

  selectChannelConversion(
    state,
    createSlotBands([100, 1, 1, 1e11]),
    createSlotBands([0.01, 3000, 1, 1e11])
  );

  assert.deepEqual(summarizeSlotModes(state), [
    AT3_CHCONV_MODE_PRIMARY_DOMINANT,
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_BALANCED,
  ]);
  assert.deepEqual(summarizeTransitionWindows(state), [false, false, true, false]);
  assert.deepEqual(summarizeSlotHints(state), [
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
    AT3_CHCONV_MODE_PRIMARY_DOMINANT,
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_BALANCED,
  ]);
  assert.equal(state.mixCode.previous, 5);
  assert.equal(state.mixCode.current, 7);
  assertFloatArrayClose(
    [
      state.slots[0].magnitudeSums.primary,
      state.slots[0].magnitudeSums.secondary,
      state.slots[1].magnitudeSums.primary,
      state.slots[1].magnitudeSums.secondary,
    ],
    [25600, 2.559999942779541, 256, 768000]
  );
});

test("selectChannelConversion preserves the all-limited-slot mix-code fallback", () => {
  const state = createChannelConversionState(4);
  state.mixCode.current = 9;

  selectChannelConversion(
    state,
    createSlotBands([100, 10, 1, 0.1]),
    createSlotBands([1, 20, 30, 40])
  );

  assert.equal(state.mixCode.previous, 9);
  assert.equal(state.mixCode.current, 7);
  assert.deepEqual(summarizeSlotModes(state), [
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_BALANCED,
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
  ]);
  assert.deepEqual(summarizeTransitionWindows(state), [true, true, true, false]);
  assert.deepEqual(summarizeSlotHints(state), [
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
    AT3_CHCONV_MODE_SECONDARY_DOMINANT,
  ]);
});

test("selectChannelConversion keeps limited slots out of the open-mix accumulator", () => {
  const skewedLimited = createChannelConversionState(1);
  skewedLimited.mixCode.current = 9;
  const neutralLimited = createChannelConversionState(1);
  neutralLimited.mixCode.current = 9;

  selectChannelConversion(
    skewedLimited,
    createSlotBands([100, 1, 1, 1]),
    createSlotBands([1, 2, 2, 2])
  );
  selectChannelConversion(
    neutralLimited,
    createSlotBands([1, 1, 1, 1]),
    createSlotBands([1, 2, 2, 2])
  );

  assert.equal(skewedLimited.mixCode.previous, 9);
  assert.equal(neutralLimited.mixCode.previous, 9);
  assert.equal(skewedLimited.mixCode.current, 5);
  assert.equal(neutralLimited.mixCode.current, 5);
  assert.deepEqual(summarizeSlotModes(skewedLimited), summarizeSlotModes(neutralLimited));
  assert.deepEqual(
    summarizeTransitionWindows(skewedLimited),
    summarizeTransitionWindows(neutralLimited)
  );
});

test("selectChannelConversion keeps dominant open slots out of the open-mix accumulator", () => {
  const strongDominantOpen = createChannelConversionState(0);
  strongDominantOpen.mixCode.current = 9;
  const mildDominantOpen = createChannelConversionState(0);
  mildDominantOpen.mixCode.current = 9;

  selectChannelConversion(
    strongDominantOpen,
    createSlotBands([1e11, 1, 1, 1]),
    createSlotBands([1, 2, 2, 2])
  );
  selectChannelConversion(
    mildDominantOpen,
    createSlotBands([1e8, 1, 1, 1]),
    createSlotBands([1, 2, 2, 2])
  );

  assert.equal(strongDominantOpen.mixCode.previous, 9);
  assert.equal(mildDominantOpen.mixCode.previous, 9);
  assert.equal(strongDominantOpen.mixCode.current, 5);
  assert.equal(mildDominantOpen.mixCode.current, 5);
  assert.equal(strongDominantOpen.slots[0].mode, AT3_CHCONV_MODE_PRIMARY_DOMINANT);
  assert.equal(mildDominantOpen.slots[0].mode, AT3_CHCONV_MODE_PRIMARY_DOMINANT);
  assert.deepEqual(summarizeSlotModes(strongDominantOpen), summarizeSlotModes(mildDominantOpen));
});

test("at3encApplyChannelConversion preserves the current mixed limited and open stream paths", () => {
  const state = createConversionState();

  at3encApplyChannelConversion(state);

  assertFloatArrayClose(summarizeMixLevels(state.channelConversion), [1, 1, 1, 1]);
  assertFloatArrayClose(
    Array.from(state.primaryLayer.spectrum.slice(0, 16)),
    [
      3, 4, 7, 4.9157280921936035, 3, 4, 6.301483631134033, 5.349634647369385, 3, 4,
      5.729725360870361, 5.867558479309082, 3, 4, 5.253091812133789, 6.496517181396484,
    ]
  );
  assertFloatArrayClose(
    Array.from(state.secondaryLayer.spectrum.slice(0, 16)),
    [
      -2.5, -2, 7, 8, -2.4666666984558105, -2, 7, 8, -2.4285714626312256, -2, 7, 8,
      -2.384615421295166, -2, 7, 8,
    ]
  );
});

test("at3encApplyChannelConversion preserves dominant limited-slot matrix families", () => {
  for (const [mode, expectedSide] of [
    [AT3_CHCONV_MODE_SECONDARY_DOMINANT, 0.5],
    [AT3_CHCONV_MODE_PRIMARY_DOMINANT, -2.5],
    [2, -1],
  ]) {
    const state = createConversionState({
      slotLimit: 1,
      modeBySlot: [
        mode,
        AT3_CHCONV_MODE_BALANCED,
        AT3_CHCONV_MODE_BALANCED,
        AT3_CHCONV_MODE_BALANCED,
      ],
      modeHints: [
        mode,
        AT3_CHCONV_MODE_BALANCED,
        AT3_CHCONV_MODE_BALANCED,
        AT3_CHCONV_MODE_BALANCED,
      ],
      left: [1, 0, 0, 0],
      right: [5, 0, 0, 0],
    });
    at3encApplyChannelConversion(state);

    assertFloatArrayClose(
      Array.from(state.primaryLayer.spectrum.slice(0, 8)),
      [3, 0, 0, 0, 3, 0, 0, 0]
    );
    assertFloatArrayClose(Array.from(state.secondaryLayer.spectrum.slice(0, 8)), [
      expectedSide,
      0,
      0,
      0,
      expectedSide,
      0,
      0,
      0,
    ]);
  }
});

test("at3encApplyChannelConversion preserves the legacy open-slot passthrough mode", () => {
  const state = createConversionState({
    slotLimit: 0,
    modeBySlot: [
      AT3_CHCONV_MODE_LEGACY_OPEN_PASSTHROUGH,
      AT3_CHCONV_MODE_BALANCED,
      AT3_CHCONV_MODE_BALANCED,
      AT3_CHCONV_MODE_BALANCED,
    ],
    prevOutput: 5,
    output: 11,
    left: [1, 0, 0, 0],
    right: [5, 0, 0, 0],
  });

  at3encApplyChannelConversion(state);

  assertFloatArrayClose(
    Array.from(state.primaryLayer.spectrum.slice(0, 16)),
    [
      3.1010031700134277, 0, 0, 0, 3.3330678939819336, 0, 0, 0, 3.602675437927246, 0, 0, 0,
      3.9197378158569336, 0, 0, 0,
    ]
  );
  assertFloatArrayClose(
    Array.from(state.secondaryLayer.spectrum.slice(0, 16)),
    [5, 0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0]
  );
});

test("at3encApplyChannelConversion preserves the current mode-3 mix-level step-up and step-down limits", () => {
  const rampUp = createConversionState({
    slotLimit: 1,
    modeBySlot: Array(4).fill(AT3_CHCONV_MODE_BALANCED),
    modeHints: Array(4).fill(AT3_CHCONV_MODE_BALANCED),
    mixLevels: [1.5, 1, 1, 1],
    magnitudes: [
      { primary: 1, secondary: 512 },
      { primary: 0, secondary: 0 },
      { primary: 0, secondary: 0 },
      { primary: 0, secondary: 0 },
    ],
  });
  at3encApplyChannelConversion(rampUp);

  assertFloatArrayClose(
    summarizeMixLevels(rampUp.channelConversion),
    [1.5499999523162842, 1, 1, 1]
  );
  assertFloatArrayClose(
    Array.from(rampUp.layers[0].spectrum.slice(0, 8)),
    [
      3, 4.134670734405518, 5.168338775634766, 6.2020063400268555, 3, 4.177467346191406,
      5.221834182739258, 6.266201019287109,
    ]
  );
  assertFloatArrayClose(
    Array.from(rampUp.layers[1].spectrum.slice(0, 8)),
    [-1.3333333730697632, 6, 7, 8, -1.3278008699417114, 6, 7, 8]
  );

  const rampDown = createConversionState({
    slotLimit: 1,
    modeBySlot: Array(4).fill(AT3_CHCONV_MODE_BALANCED),
    modeHints: Array(4).fill(AT3_CHCONV_MODE_BALANCED),
    mixLevels: [1.5, 1, 1, 1],
    magnitudes: [
      { primary: 1, secondary: 1 },
      { primary: 0, secondary: 0 },
      { primary: 0, secondary: 0 },
      { primary: 0, secondary: 0 },
    ],
  });
  at3encApplyChannelConversion(rampDown);

  assertFloatArrayClose(
    summarizeMixLevels(rampDown.channelConversion),
    [1.4500000476837158, 1, 1, 1]
  );
  assertFloatArrayClose(
    Array.from(rampDown.layers[1].spectrum.slice(0, 8)),
    [-1.3333333730697632, 6, 7, 8, -1.3389121294021606, 6, 7, 8]
  );
});

test("at3encApplyChannelConversion preserves in-window limited-stream steering", () => {
  const state = createConversionState({
    slotLimit: 1,
    modeBySlot: Array(4).fill(AT3_CHCONV_MODE_BALANCED),
    modeHints: Array(4).fill(AT3_CHCONV_MODE_BALANCED),
    prevOutput: 0,
    output: AT3_CHCONV_INITIAL_OPEN_MIX_CODE,
    magnitudes: [
      { primary: 10, secondary: 50 },
      { primary: 0, secondary: 0 },
      { primary: 0, secondary: 0 },
      { primary: 0, secondary: 0 },
    ],
  });

  at3encApplyChannelConversion(state);

  assertFloatArrayClose(summarizeMixLevels(state.channelConversion), [1.05, 1, 1, 1]);
  assertFloatArrayClose(
    Array.from(state.primaryLayer.spectrum.slice(0, 8)),
    [
      3, 5.656854152679443, 7.071067810058594, 8.485281944274902, 3, 5.378379821777344,
      6.7229743003845215, 8.067569732666016,
    ]
  );
  assertFloatArrayClose(
    Array.from(state.secondaryLayer.spectrum.slice(0, 8)),
    [-2, 6, 7, 8, -1.9875776767730713, 6, 7, 8]
  );
});
