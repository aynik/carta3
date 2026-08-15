import { describe, expect, it } from 'vitest'
import { LayeredTransformState, LayerState } from '../codec/state/layered.js'
import { analyzeLayeredGain } from '../codec/analysis/layered-gain.js'
import { prepareLayeredGain } from '../codec/transforms/gain-scale.js'
import { runLayeredMdct } from '../codec/transforms/mdct.js'

const floatBits = new DataView(new ArrayBuffer(4))

function f32Bits(value) {
  floatBits.setFloat32(0, value, true)
  return floatBits.getUint32(0, true)
}

function stateImageHash(words) {
  let hash = 1469598103934665603n
  for (const word of words) {
    hash ^= BigInt(word)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  return hash.toString(16).padStart(16, '0')
}

function createReferenceLayer() {
  const layer = new LayerState()
  layer.stereoFlag = 1133
  for (let index = 0; index < 1024; index++) {
    layer.spectrum[index] = Math.fround(
      (((index * 97 + 13) % 2001) + 1) * 16.25
    )
  }
  for (let index = 0; index < 512; index++) {
    layer.windowMatrix[index] = f32Bits(
      Math.fround((((index * 53 + 7) % 997) - 498) * 3.5)
    )
    layer.gainHistory[index] = f32Bits(
      Math.fround((((index * 29 + 3) % 701) - 350) * 2.25)
    )
    layer.transformHistory[index] = f32Bits(
      Math.fround((((index * 41 + 11) % 809) - 404) * 1.75)
    )
  }
  for (let unit = 0; unit < 4; unit++) {
    const block = layer.pairBlocks[unit]
    for (let index = 0; index < 32; index++) {
      block[0x10 + index] = f32Bits(
        Math.fround(1000 + (unit * 32 + index) * 17)
      )
    }
    block[0x30] = f32Bits(Math.fround(5000 + unit * 100))
    block[0x31] = f32Bits(Math.fround(4000 + unit * 100))
  }
  return layer
}

describe('ATRAC3 layered transform', () => {
  it('matches the persistent-state reference image', () => {
    const layer = createReferenceLayer()
    const transformState = new LayeredTransformState()
    analyzeLayeredGain(
      layer,
      new Int32Array([0, 1, 3, 2]),
      new Int32Array([0, -1, 3, 1]),
      transformState
    )
    expect(layer.spectrum[0]).toBe(Math.fround(14 * 16.25))
    expect(transformState.words.subarray(0x400, 0x600)).toEqual(
      layer.windowMatrix
    )
    prepareLayeredGain(transformState)
    runLayeredMdct(layer, transformState)

    expect(stateImageHash(layer.storeTo(transformState.words))).toBe(
      'fe97eb05724c408a'
    )
    expect(layer.pairBlocks.map((block) => block[0x32])).toEqual([0, 0, 0, 0])
  })

  it('round-trips the complete packed layer state', () => {
    const source = createReferenceLayer()
    source.previousPairToneEntryCount = 7
    source.scaleFactorBandLimit = 26
    source.bitBudget = -19
    const words = source.storeTo(new Uint32Array(0xb5a)).slice()
    const destination = new LayerState()

    destination.loadFrom(words)

    expect(destination.storeTo(new Uint32Array(0xb5a))).toEqual(words)
  })
})
