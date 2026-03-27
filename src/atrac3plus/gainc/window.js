import { AT5_LNGAIN, AT5_GAINC_WINDOW } from "../tables/decode.js";

const GAIN_PARAM_WORDS = 16;
const GAINC_STEPS = 64;
const GAINC_WINDOW_SAMPLES = 256;
const GAINC_SAMPLES_PER_STEP = GAINC_WINDOW_SAMPLES / GAINC_STEPS;
const GAINC_RELEASE_STEP_OFFSET = 32;
const GAINC_FLAT_WINDOW_END = 0xff;
const ZERO_GAIN_PARAMS = new Uint32Array(GAIN_PARAM_WORDS);

function normalizeGainParams(param) {
  if (!param) return ZERO_GAIN_PARAMS;
  if (param instanceof Uint32Array) return param;

  const view = param.v;
  if (view instanceof Uint32Array) return view;
  if (Array.isArray(view)) return Uint32Array.from(view);
  if (Array.isArray(param)) return Uint32Array.from(param);

  return ZERO_GAIN_PARAMS;
}

function applyReleaseSegments(stepGains, releaseParams) {
  let writeStep = 0;
  const segmentCount = releaseParams[0] | 0;

  for (let segment = 0; segment < segmentCount; segment += 1) {
    const gain = AT5_LNGAIN[releaseParams[8 + segment] | 0] | 0;
    const releaseStep = (releaseParams[1 + segment] | 0) + GAINC_RELEASE_STEP_OFFSET;
    while (writeStep <= releaseStep) stepGains[writeStep++] = gain;
  }
}

function applyAttackSegments(stepGains, attackParams) {
  let writeStep = 0;
  const segmentCount = attackParams[0] | 0;

  for (let segment = 0; segment < segmentCount; segment += 1) {
    const gain = AT5_LNGAIN[attackParams[8 + segment] | 0] | 0;
    const attackStep = attackParams[1 + segment] | 0;
    while (writeStep <= attackStep) stepGains[writeStep++] += gain;
  }
}

export function gaincWindowEncAt5(attackParam, releaseParam, out) {
  const stepGains = new Int32Array(GAINC_STEPS);
  applyReleaseSegments(stepGains, normalizeGainParams(releaseParam));
  applyAttackSegments(stepGains, normalizeGainParams(attackParam));

  let previousGain = 0;
  let previousScale = 1;
  let writeIndex = GAINC_WINDOW_SAMPLES - 1;
  let lastScaledSample = GAINC_WINDOW_SAMPLES;

  for (let step = GAINC_STEPS - 1; step >= 0; step -= 1) {
    const gain = stepGains[step];
    if (gain === previousGain) {
      out.fill(previousScale, writeIndex - (GAINC_SAMPLES_PER_STEP - 1), writeIndex + 1);
    } else {
      if (lastScaledSample === GAINC_WINDOW_SAMPLES) {
        lastScaledSample = writeIndex;
      }

      const gainDelta = gain - previousGain;
      if (gainDelta > 0) {
        const nextScale = 2 ** gain;
        const windowIndex = (gainDelta - 1) * 3;
        out[writeIndex] = nextScale * AT5_GAINC_WINDOW[windowIndex];
        out[writeIndex - 1] = nextScale * AT5_GAINC_WINDOW[windowIndex + 1];
        out[writeIndex - 2] = nextScale * AT5_GAINC_WINDOW[windowIndex + 2];
        out[writeIndex - 3] = nextScale;
        previousScale = nextScale;
      } else {
        const drop = -gainDelta;
        const windowIndex = (drop - 1) * 3;
        out[writeIndex] = previousScale * AT5_GAINC_WINDOW[windowIndex + 2];
        out[writeIndex - 1] = previousScale * AT5_GAINC_WINDOW[windowIndex + 1];
        out[writeIndex - 2] = previousScale * AT5_GAINC_WINDOW[windowIndex];
        previousScale = 2 ** gain;
        out[writeIndex - 3] = previousScale;
      }
    }

    writeIndex -= GAINC_SAMPLES_PER_STEP;
    previousGain = gain;
  }

  return lastScaledSample === GAINC_WINDOW_SAMPLES ? GAINC_FLAT_WINDOW_END : lastScaledSample;
}
