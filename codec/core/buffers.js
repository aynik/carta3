/** Carta3 Audio Codec - Reusable typed-array ownership. */

import {
  EncoderFrameState,
  EncoderState,
  GainAnalysisScratch,
  GainScaleScratch,
  IndependentQmfScratch,
  MdctScratch,
  SoundUnitAllocationScratch,
} from '../state/encoder.js'
import { DecoderFrameState } from '../state/decoder.js'
import { LayeredAllocationScratch } from '../state/layered.js'
import {
  BITSTREAM_PADDING_BYTES,
  FRAME_SAMPLES,
  LAYERED_QMF_HISTORY_FLOATS,
  MAX_CHANNELS,
  MAX_CODED_FRAME_BYTES,
} from './constants.js'

/**
 * Own reusable codec storage according to the lifetime of its contents.
 *
 * - `state` is committed history with meaning across successful frames;
 * - `frame` is the detached transaction and named data passed between stages;
 * - `scratch` is private to one algorithm call and carries no stage meaning.
 *
 * Complex storage is represented by classes in `codec/state`. Raw buffers that
 * need no invariants or behavior are allocated here at their ownership site.
 */
export class BufferPool {
  /** Allocate profile-neutral encoder storage and reusable decoder buffers. */
  constructor() {
    this.encoder = {
      state: new EncoderState(),
      frame: new EncoderFrameState(),
      scratch: {
        layeredQmf: new Float32Array(
          FRAME_SAMPLES + LAYERED_QMF_HISTORY_FLOATS
        ),
        qmf: new IndependentQmfScratch(),
        mdct: Array.from({ length: MAX_CHANNELS }, () => new MdctScratch()),
        gainScale: new GainScaleScratch(),
        gainAnalysis: new GainAnalysisScratch(),
        allocation: new SoundUnitAllocationScratch(),
        layeredAllocation: new LayeredAllocationScratch(),
      },
    }

    this.decoder = {
      state: null,
      frame: new DecoderFrameState(),
      scratch: {
        paddedFrame: new Uint8Array(
          MAX_CODED_FRAME_BYTES + BITSTREAM_PADDING_BYTES
        ),
      },
    }
  }
}
