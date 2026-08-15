import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_WORK_FLOATS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
} from '../codec/core/constants.js'
import { QUANTIZATION_UNIT_OFFSETS } from '../codec/core/tables.js'
import { BufferPool } from '../codec/core/buffers.js'
import {
  EncoderFrameState,
  EncoderState,
  GainAnalysisScratch,
  GainScaleScratch,
  IndependentQmfScratch,
  MdctScratch,
  SoundUnitAllocationScratch,
} from '../codec/state/encoder.js'
import { DecoderFrameState } from '../codec/state/decoder.js'
import { resolveProfile, resolveWaveProfile } from '../codec/core/profiles.js'
import { BitCounter, BitReader, BitWriter } from '../codec/io/bitstream.js'
import {
  IndependentChannelHeader,
  JointStereoHeader,
  SpectrumAllocation,
  ToneItemHeader,
  ToneListCount,
  ToneRegionHeader,
  ToneSectionHeader,
} from '../codec/io/syntax.js'

describe('ATRAC3 profiles and state geometry', () => {
  it.each([
    [66, 192, 2, 1],
    [105, 304, 1, 0],
    [132, 384, 1, 0],
  ])('resolves %i kbps', (bitrateKbps, bytesPerFrame, syntaxMode, modeFlag) => {
    expect(resolveProfile({ bitrateKbps })).toMatchObject({
      bitrateKbps,
      bytesPerFrame,
      syntaxMode,
      modeFlag,
      channels: 2,
      frameSamples: FRAME_SAMPLES,
      sampleRate: SAMPLE_RATE,
    })
  })

  it('rejects non-ATRAC3 topology and mismatched WAVE mode', () => {
    expect(resolveProfile({ channels: 1 })).toBeNull()
    expect(resolveProfile({ sampleRate: 48000 })).toBeNull()
    expect(
      resolveWaveProfile({
        channels: 2,
        sampleRate: 44100,
        blockAlign: 192,
        modeFlag: 0,
      })
    ).toBeNull()
  })

  it('separates committed state, frame transactions, and stage scratch', () => {
    const pool = new BufferPool()
    expect(pool.encoder.state).toBeInstanceOf(EncoderState)
    expect(pool.encoder.frame).toBeInstanceOf(EncoderFrameState)
    expect(pool.encoder).not.toHaveProperty('workspace')
    expect(pool.encoder).not.toHaveProperty('staged')
    expect(pool.encoder.state.independentChannels).toHaveLength(2)
    expect(pool.encoder.state.independentChannels[0]).toHaveLength(
      ANALYSIS_WORK_FLOATS
    )
    expect(pool.encoder.scratch.mdct[0].preWindowed).toHaveLength(256)
    expect(pool.encoder.scratch.mdct[0]).toBeInstanceOf(MdctScratch)
    expect(pool.encoder.scratch.mdct[0].real).toHaveLength(128)
    expect(pool.encoder.scratch.qmf).toBeInstanceOf(IndependentQmfScratch)
    expect(pool.encoder.scratch.qmf.firstLow).toHaveLength(512)
    expect(pool.encoder.scratch.qmf.convolutionWork).toHaveLength(1070)
    expect(pool.encoder.scratch.allocation.normalizedSpectrum).toHaveLength(
      FRAME_SAMPLES
    )
    expect(pool.encoder.scratch.allocation).toBeInstanceOf(
      SoundUnitAllocationScratch
    )
    expect(pool.encoder.scratch.gainAnalysis).toBeInstanceOf(
      GainAnalysisScratch
    )
    expect(pool.encoder.scratch.gainScale).toBeInstanceOf(GainScaleScratch)
    expect(pool.encoder.scratch.allocation.candidateSymbols).toHaveLength(128)
    expect(pool.encoder.scratch.allocation.fillCandidates.valid).toHaveLength(
      64
    )
    expect(pool.decoder.state).toBeNull()
    expect(pool.decoder.frame).toBeInstanceOf(DecoderFrameState)
    expect(pool.decoder.frame.decodedChannels).toHaveLength(2)
    expect(pool.decoder.frame.decodedChannels[0].samples).toHaveLength(
      FRAME_SAMPLES
    )
  })

  it('uses the canonical 32-band, 1024-line quantization layout', () => {
    expect(QUANTIZATION_UNIT_OFFSETS).toHaveLength(33)
    expect(QUANTIZATION_UNIT_OFFSETS[0]).toBe(0)
    expect(QUANTIZATION_UNIT_OFFSETS.at(-1)).toBe(1024)
  })
})

describe('ATRAC3 bitstream and immutable syntax', () => {
  it('round-trips independent and joint channel headers', () => {
    for (let unitMode = 0; unitMode <= 3; unitMode++) {
      const header = new IndependentChannelHeader(unitMode)
      const output = new Uint8Array(1)
      const writer = new BitWriter(output)
      header.pack(writer)
      expect(output[0]).toBe(0xa0 | unitMode)
      expect(IndependentChannelHeader.isValid(output[0])).toBe(true)
      expect(IndependentChannelHeader.unpack(output[0]).unitMode).toBe(unitMode)
    }

    const joint = JointStereoHeader.create(2, [1, 3, 0, 1], 2)
    expect([...joint.bytes]).toEqual([0x27, 0x1e])
    expect(joint.isValid).toBe(true)
    expect([...joint.gainSelectors]).toEqual([1, 3, 0, 1])
    expect(joint.unitMode).toBe(2)
  })

  it('counts and round-trips spectrum allocation syntax', () => {
    const allocation = new SpectrumAllocation(4, 1, [0, 1, 7, 0], [0, 9, 63, 0])
    const counter = new BitCounter()
    allocation.pack(counter)
    expect(counter.bitPosition).toBe(allocation.packedBits)

    const output = new Uint8Array(8)
    const writer = new BitWriter(output)
    allocation.pack(writer)
    const decoded = SpectrumAllocation.read(new BitReader(output))
    expect(decoded.groupCount).toBe(4)
    expect(decoded.tableSelector).toBe(1)
    expect([...decoded.wordLengths.slice(0, 4)]).toEqual([0, 1, 7, 0])
    expect([...decoded.scaleFactors.slice(0, 4)]).toEqual([0, 9, 63, 0])
  })

  it('round-trips tone headers with identical counted and emitted cost', () => {
    const records = [
      new ToneSectionHeader(3, 1),
      new ToneRegionHeader(0b10, 5, 3, 2),
      new ToneListCount(6),
      new ToneItemHeader(57, 41),
    ]
    const counter = new BitCounter()
    const output = new Uint8Array(4)
    const writer = new BitWriter(output)
    for (const record of records) {
      record.pack(counter)
      record.pack(writer)
    }
    expect(counter.bitPosition).toBe(writer.bitPosition)

    const reader = new BitReader(output)
    expect(ToneSectionHeader.read(reader)).toMatchObject({
      regionCount: 3,
      mode: 1,
    })
    const region = ToneRegionHeader.read(2, reader)
    expect(region).toMatchObject({
      channelMask: 2,
      descriptor: 5,
      codeIndex: 3,
    })
    expect(region.decoderBaseLength).toBe(21)
    expect(region.decoderShiftRegister).toBe(0x40)
    expect(ToneListCount.read(reader).count).toBe(6)
    expect(ToneItemHeader.read(reader)).toMatchObject({
      scaleFactor: 57,
      start: 41,
    })
  })
})
