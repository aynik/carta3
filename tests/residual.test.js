import { describe, expect, it } from 'vitest'
import {
  initialResidualBandLimit,
  measureResidualSource,
} from '../codec/analysis/residual.js'
import { allocateLayeredResidual } from '../codec/coding/layered.js'
import {
  AllocationWorkMut,
  AllocationWorkView,
  createAllocationWork,
} from '../codec/coding/work.js'
import { ALLOCATION_RESIDUAL_SPECTRUM_OFFSET } from '../codec/core/constants.js'
import {
  residualCodebook,
  residualQuantGroupScale,
  measureResidualBand,
  measureResidualModeNeighbors,
  measureResidualScaleNeighbors,
  quantizeResidualCoefficient,
  writeResidualBand,
} from '../codec/coding/residual.js'
import { BitCounter } from '../codec/io/bitstream.js'
import { packLayeredChannel } from '../codec/io/layered-channel.js'
import { LayerState } from '../codec/state/layered.js'

const numberBits = new DataView(new ArrayBuffer(8))
const floatBits = new DataView(new ArrayBuffer(4))

function f64Bits(value) {
  numberBits.setFloat64(0, value, true)
  return numberBits.getBigUint64(0, true)
}

function f32Bits(value) {
  floatBits.setFloat32(0, value, true)
  return floatBits.getUint32(0, true)
}

const REFERENCE_COSTS = new Map([
  [
    0,
    [
      [0, 4693931671639031808n],
      [14, 4693933970290961508n],
      [24, 4693932114934331126n],
      [28, 4693910462055316133n],
      [28, 4693899908231903824n],
      [49, 4694073704291547510n],
      [49, 4693938663204790821n],
      [59, 4693934031933114357n],
    ],
  ],
  [
    10,
    [
      [0, 4693692722744131584n],
      [29, 4693675637484158814n],
      [36, 4693657185730248172n],
      [54, 4693687702382576915n],
      [50, 4693670621714121326n],
      [79, 4693557936059971576n],
      [95, 4693649410159699331n],
      [105, 4693703244997767758n],
    ],
  ],
  [
    23,
    [
      [0, 4700259122887524352n],
      [47, 4700258055611426092n],
      [66, 4700244965182539834n],
      [101, 4700252148071287547n],
      [93, 4700263455799984362n],
      [138, 4700293185653928207n],
      [183, 4700224315057363100n],
      [214, 4700299522246298934n],
    ],
  ],
  [
    31,
    [
      [0, 4708637160637464576n],
      [169, 4708635650432917329n],
      [258, 4708642693433658288n],
      [390, 4708619882779606932n],
      [342, 4708665946737616376n],
      [551, 4708657971707888354n],
      [691, 4708624672862568697n],
      [849, 4708638765556528679n],
    ],
  ],
])

function referenceSpectrum() {
  return Float32Array.from(
    { length: 1024 },
    (_, index) => (((index * 73 + 19) % 2047) - 1023) * 0.375
  )
}

function sourceProfileHash(profile) {
  let hash = 1469598103934665603n
  const add = (word) => {
    hash ^= BigInt(word >>> 0)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  for (const values of [
    profile.groupScaleFactors,
    profile.bandMetrics,
    profile.scaleFactors,
  ]) {
    for (const value of values) add(value)
  }
  add(profile.sumRunning)
  for (const value of profile.monoExpansionBudgetThresholds) add(value)
  return hash.toString(16).padStart(16, '0')
}

function wordImageHash(words) {
  let hash = 1469598103934665603n
  for (const word of words) {
    hash ^= BigInt(word >>> 0)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  return hash.toString(16).padStart(16, '0')
}

describe('ATRAC3 layered residual coding', () => {
  it('matches the residual source-analysis reference image', () => {
    const layer = new LayerState()
    layer.spectrum.set(referenceSpectrum())
    const profile = measureResidualSource(layer)
    expect(sourceProfileHash(profile)).toBe('b720b245f658a5fe')
    expect(initialResidualBandLimit(profile, 12, 357, true)).toBe(28)
    expect(initialResidualBandLimit(profile, 12, 357, false)).toBe(12)
  })

  it('matches complete mono and secondary allocation reference images', () => {
    const cases = [
      {
        stereoFlag: 0,
        limit: 25,
        budget: 1133,
        stereoMode: 0,
        codedBits: 1131,
        hash: '4da92bd46b3d77d8',
      },
      {
        stereoFlag: 1133,
        limit: 12,
        budget: 357,
        stereoMode: 7,
        codedBits: 356,
        hash: '678f9ba8684c17be',
      },
    ]
    for (const expected of cases) {
      const layer = new LayerState()
      layer.stereoFlag = expected.stereoFlag
      layer.spectrum.set(referenceSpectrum())
      layer.pairBlocks[0][0x32] = 1
      const profile = measureResidualSource(layer)
      const work = createAllocationWork()
      expect(
        allocateLayeredResidual(
          layer,
          profile,
          expected.limit,
          expected.budget,
          expected.stereoMode,
          work
        )
      ).toBe(expected.codedBits)
      expect(wordImageHash(work)).toBe(expected.hash)
    }
  })

  it('matches complete layered channel emission reference vectors', () => {
    const cases = [
      [0, 25, 1133, 0, 384, 1150, '30556e26e9fda7f5'],
      [1133, 12, 357, 7, 192, 383, '84d6276eda6ae26e'],
    ]
    for (const [flag, limit, budget, mode, bytes, end, hash] of cases) {
      const layer = new LayerState()
      layer.stereoFlag = flag
      layer.spectrum.set(referenceSpectrum())
      layer.pairBlocks[0][0x32] = 1
      const work = createAllocationWork()
      allocateLayeredResidual(
        layer,
        measureResidualSource(layer),
        limit,
        budget,
        mode,
        work
      )
      const output = new Uint8Array(bytes)
      expect(
        packLayeredChannel(layer, work, 0, output, {
          previousOutput: 3,
          gainSelectors: new Int32Array([0, 1, 2, 3]),
        })
      ).toBe(end)
      expect(wordImageHash(output)).toBe(hash)
    }
  })

  it('matches quantizer primitive reference vectors', () => {
    const expectedScaleBits = [
      1047652260, 1053398622, 1057823861, 1060466107, 1066873030, 1075591919,
      1084145667,
    ]
    const expectedSymbols = [31, 10, 52, 30, 29, 48, 21]
    for (let mode = 1; mode <= 7; mode++) {
      const scale = residualQuantGroupScale(mode, 23)
      expect(f32Bits(scale)).toBe(expectedScaleBits[mode - 1])
      expect(quantizeResidualCoefficient(-137.625, scale, 0x3f)).toBe(
        expectedSymbols[mode - 1]
      )
    }
  })

  it('materializes the exact residual codebook geometry once', () => {
    expect(
      Array.from(
        { length: 7 },
        (_, index) => residualCodebook(index + 1).codes.length
      )
    ).toEqual([16, 8, 8, 16, 16, 32, 64])
    expect(residualCodebook(1).paired).toBe(true)
    expect(residualCodebook(2).paired).toBe(false)
    expect(residualCodebook(0)).toBeNull()
  })

  it('matches exact bit and f64 reconstruction-cost reference vectors', () => {
    const source = referenceSpectrum()
    for (const [band, costs] of REFERENCE_COSTS) {
      for (let mode = 0; mode <= 7; mode++) {
        const option = measureResidualBand(source, band, mode, 23)
        expect([option.bits, f64Bits(option.error)]).toEqual(costs[mode])
        if (mode !== 0) {
          const counter = new BitCounter()
          expect(writeResidualBand(source, band, mode, 23, counter)).toBe(
            option.bits
          )
        }
      }
    }
  })

  it('prices legal mode and scale neighbors through the same exact scorer', () => {
    const source = referenceSpectrum()
    const modeNeighbors = measureResidualModeNeighbors(source, 10, 4, 23)
    expect(modeNeighbors).toEqual(
      [3, 5].map((mode) => {
        const { bits, error } = measureResidualBand(source, 10, mode, 23)
        return { bits, error }
      })
    )
    const scaleNeighbors = measureResidualScaleNeighbors(source, 10, 4, 23)
    expect(scaleNeighbors.map((candidate) => candidate.scaleFactor)).toEqual([
      22, 24,
    ])
  })
})

describe('ATRAC3 layered allocation work image', () => {
  it('shares typed syntax and residual-spectrum views over one buffer', () => {
    const words = createAllocationWork()
    const mutable = new AllocationWorkMut(words)
    mutable.setActiveBandCount(26)
    mutable.setBlockCount(4)
    mutable.setToneMode(3)
    mutable.setToneRegionCount(2)
    mutable.setMode(3, 6)
    mutable.setScaleFactor(3, 41)
    const spectrum = Float32Array.from(
      { length: 1024 },
      (_, index) => index * 0.125 - 31
    )
    mutable.copyResidualSpectrumBits(spectrum)

    const view = new AllocationWorkView(words)
    expect(view.activeBandCount).toBe(26)
    expect(view.blockCount).toBe(4)
    expect(view.toneMode).toBe(3)
    expect(view.toneRegionCount).toBe(2)
    expect(view.mode(3)).toBe(6)
    expect(view.scaleFactor(3)).toBe(41)
    expect(view.residualSpectrum()).toHaveLength(1024)
    expect(view.residualSpectrum()[0] >>> 0).toBe(f32Bits(spectrum[0]))
    expect(words[ALLOCATION_RESIDUAL_SPECTRUM_OFFSET + 1023] >>> 0).toBe(
      f32Bits(spectrum[1023])
    )
  })
})
