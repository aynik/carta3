import { CodecError } from "../common/errors.js";
import { AT3ENC_PROC_CURVE_TABLE } from "./encode-tables.js";

const AT3ENC_QMF_STATE_FLOATS = 0x8a;
const AT3ENC_QMF_SAMPLES = 0x400;
const AT3ENC_QMF_WINDOW_TAIL_FLOATS = AT3ENC_QMF_STATE_FLOATS + AT3ENC_QMF_SAMPLES;
const AT3ENC_QMF_FRAME_STRIDE = 4;
const AT3ENC_QMF_HISTORY_OFFSET = AT3ENC_QMF_STATE_FLOATS;
const AT3ENC_QMF_ACCUM_OFFSET = 0x5c;
const AT3ENC_QMF_REVERSE_ACCUM_OFFSET = 0x58;
const AT3ENC_QMF_CURVE_TAPS = 23;
const AT3ENC_QMF_FEEDBACK_SCALE = 6.296897888183594;
const gQmfScratchByHistory = new WeakMap();

function getQmfScratchForHistory(hist) {
  let scratch = gQmfScratchByHistory.get(hist);
  if (!(scratch instanceof Float32Array) || scratch.length < AT3ENC_QMF_WINDOW_TAIL_FLOATS) {
    scratch = new Float32Array(AT3ENC_QMF_WINDOW_TAIL_FLOATS);
    gQmfScratchByHistory.set(hist, scratch);
  }
  return scratch;
}

/** Creates the fixed 23-tap QMF analysis curve used by the ATRAC3 encoder. */
export function createAt3encQmfCurveTable() {
  return new Float32Array(AT3ENC_PROC_CURVE_TABLE);
}

/**
 * Runs the ATRAC3 QMF analysis filterbank over one 1024-sample layer and
 * preserves the trailing history needed by the next frame.
 */
export function at3encQmfAnalyze(curve, pcm, dst, hist, windowAndTail) {
  if (!(curve instanceof Float32Array) || curve.length < 23) {
    throw new CodecError("curve must be a Float32Array with at least 23 values");
  }
  if (!(pcm instanceof Float32Array) || pcm.length < AT3ENC_QMF_SAMPLES) {
    throw new CodecError(`pcm must be a Float32Array with at least ${AT3ENC_QMF_SAMPLES} samples`);
  }
  if (!(dst instanceof Float32Array) || dst.length < AT3ENC_QMF_SAMPLES) {
    throw new CodecError(`dst must be a Float32Array with at least ${AT3ENC_QMF_SAMPLES} samples`);
  }
  if (!(hist instanceof Float32Array) || hist.length < AT3ENC_QMF_STATE_FLOATS) {
    throw new CodecError(
      `hist must be a Float32Array with at least ${AT3ENC_QMF_STATE_FLOATS} samples`
    );
  }

  const qmfScratch = windowAndTail === undefined ? getQmfScratchForHistory(hist) : windowAndTail;
  if (!(qmfScratch instanceof Float32Array) || qmfScratch.length < AT3ENC_QMF_WINDOW_TAIL_FLOATS) {
    throw new CodecError(
      `windowAndTail must be a Float32Array with at least ${AT3ENC_QMF_WINDOW_TAIL_FLOATS} samples`
    );
  }
  qmfScratch.set(hist.subarray(0, AT3ENC_QMF_STATE_FLOATS), 0);

  // Each pass pulls in 4 fresh PCM samples, updates the forward-running QMF
  // state, then walks the mirrored history needed to emit 4 transformed
  // spectrum values.
  for (let frameBase = 0; frameBase < AT3ENC_QMF_SAMPLES; frameBase += AT3ENC_QMF_FRAME_STRIDE) {
    const evenLowSample = pcm[frameBase];
    const oddLowSample = pcm[frameBase + 1];
    const evenHighSample = pcm[frameBase + 2];
    const oddHighSample = pcm[frameBase + 3];

    const inputBase = frameBase + AT3ENC_QMF_HISTORY_OFFSET;
    qmfScratch[inputBase] = evenLowSample;
    qmfScratch[inputBase + 1] = oddLowSample;
    qmfScratch[inputBase + 2] = evenHighSample;
    qmfScratch[inputBase + 3] = oddHighSample;

    const accumBase = frameBase + AT3ENC_QMF_ACCUM_OFFSET;
    let lowOddAcc = oddLowSample + qmfScratch[accumBase + 1] * AT3ENC_QMF_FEEDBACK_SCALE;
    let highOddAcc = oddHighSample + qmfScratch[accumBase + 3] * AT3ENC_QMF_FEEDBACK_SCALE;
    let lowEvenAcc = evenLowSample * AT3ENC_QMF_FEEDBACK_SCALE + qmfScratch[accumBase];
    let highEvenAcc = evenHighSample * AT3ENC_QMF_FEEDBACK_SCALE + qmfScratch[accumBase + 2];

    for (let tap = AT3ENC_QMF_CURVE_TAPS - 1; tap >= 1; tap -= 1) {
      const mirroredTap = AT3ENC_QMF_CURVE_TAPS - tap;
      const tapBase = frameBase + tap * 2;
      lowOddAcc = Math.fround(
        lowOddAcc + curve[tap] * qmfScratch[tapBase + AT3ENC_QMF_ACCUM_OFFSET + 1]
      ); // Required rounding
      highOddAcc = Math.fround(
        highOddAcc + curve[tap] * qmfScratch[tapBase + AT3ENC_QMF_ACCUM_OFFSET + 3]
      ); // Required rounding
      lowEvenAcc = Math.fround(
        lowEvenAcc + curve[mirroredTap] * qmfScratch[tapBase + AT3ENC_QMF_ACCUM_OFFSET]
      ); // Required rounding
      highEvenAcc = Math.fround(
        highEvenAcc + curve[mirroredTap] * qmfScratch[tapBase + AT3ENC_QMF_ACCUM_OFFSET + 2]
      ); // Required rounding
    }

    qmfScratch[accumBase] = lowOddAcc + lowEvenAcc;
    qmfScratch[accumBase + 1] = lowOddAcc - lowEvenAcc;
    qmfScratch[accumBase + 2] = highOddAcc + highEvenAcc;
    qmfScratch[accumBase + 3] = highOddAcc - highEvenAcc;

    let output0 = qmfScratch[frameBase + 2] * AT3ENC_QMF_FEEDBACK_SCALE + highOddAcc + highEvenAcc;
    let output1 =
      qmfScratch[frameBase + 3] * AT3ENC_QMF_FEEDBACK_SCALE + (highOddAcc - highEvenAcc);
    let output2 = (lowOddAcc - lowEvenAcc) * AT3ENC_QMF_FEEDBACK_SCALE + qmfScratch[frameBase + 1];
    let output3 = (lowOddAcc + lowEvenAcc) * AT3ENC_QMF_FEEDBACK_SCALE + qmfScratch[frameBase];

    for (
      let tap = AT3ENC_QMF_CURVE_TAPS - 1,
        reverseTapBase = frameBase + AT3ENC_QMF_REVERSE_ACCUM_OFFSET;
      tap >= 1;
      tap -= 1, reverseTapBase -= AT3ENC_QMF_FRAME_STRIDE
    ) {
      const mirroredTap = AT3ENC_QMF_CURVE_TAPS - tap;
      output1 = Math.fround(output1 + curve[tap] * qmfScratch[reverseTapBase + 3]); // Required rounding
      output0 = Math.fround(output0 + curve[tap] * qmfScratch[reverseTapBase + 2]); // Required rounding

      const reverseLowEven = qmfScratch[reverseTapBase];
      const reverseLowOdd = qmfScratch[reverseTapBase + 1];
      output3 = Math.fround(output3 + curve[mirroredTap] * reverseLowEven); // Required rounding
      output2 = Math.fround(output2 + curve[mirroredTap] * reverseLowOdd); // Required rounding
    }

    dst[frameBase] = output0 + output3;
    dst[frameBase + 1] = output0 - output3;
    dst[frameBase + 2] = output1 - output2;
    dst[frameBase + 3] = output1 + output2;
  }

  hist.set(qmfScratch.subarray(AT3ENC_QMF_SAMPLES, AT3ENC_QMF_SAMPLES + AT3ENC_QMF_STATE_FLOATS));
}
