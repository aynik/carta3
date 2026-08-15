import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProgram, main } from '../bin/cli.js'
import { createPcmWave } from '../codec/io/serialization.js'
import { parseWave } from '../codec/io/wave.js'

/**
 * Build a short stereo PCM fixture in the encoder's signed-sample domain.
 *
 * @param {number} [sampleCount]
 * @returns {Uint8Array}
 */
function createInputWave(sampleCount = 2048) {
  const channels = [
    new Float32Array(sampleCount),
    new Float32Array(sampleCount),
  ]
  for (let sample = 0; sample < sampleCount; sample++) {
    channels[0][sample] = Math.sin((2 * Math.PI * 440 * sample) / 44100) * 8000
    channels[1][sample] = Math.sin((2 * Math.PI * 660 * sample) / 44100) * 8000
  }
  return createPcmWave(channels)
}

describe('carta3 CLI', () => {
  let directory
  let inputFile
  let encodedFile
  let decodedFile

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carta3-cli-'))
    inputFile = path.join(directory, 'input.wav')
    encodedFile = path.join(directory, 'encoded.wav')
    decodedFile = path.join(directory, 'decoded.wav')
    fs.writeFileSync(inputFile, createInputWave())
  })

  afterEach(() => {
    fs.rmSync(directory, { force: true, recursive: true })
  })

  it('uses mutually exclusive root encode and decode flags', () => {
    const encode = createProgram().parse([
      'node',
      'carta3',
      '-e',
      '-q',
      '-b',
      '105',
      inputFile,
      encodedFile,
    ])
    expect(encode.commands).toHaveLength(0)
    expect(encode.opts()).toMatchObject({
      bitrate: '105',
      encode: true,
      quiet: true,
    })
    expect(encode.args).toEqual([inputFile, encodedFile])

    const decode = createProgram().parse([
      'node',
      'carta3',
      '-d',
      encodedFile,
      decodedFile,
    ])
    expect(decode.opts()).toMatchObject({ decode: true })
  })

  it('rejects missing, conflicting, and decode-only-inapplicable options', async () => {
    await expect(
      main(['node', 'carta3', inputFile, encodedFile])
    ).rejects.toThrow('Must specify one of --encode or --decode')
    await expect(
      main(['node', 'carta3', '-e', '-d', inputFile, encodedFile])
    ).rejects.toThrow('Cannot specify multiple operation modes')
    await expect(
      main(['node', 'carta3', '-d', '-b', '105', inputFile, decodedFile])
    ).rejects.toThrow('--bitrate only applies when encoding')
  })

  it('encodes and decodes through the flag interface', async () => {
    await main([
      'node',
      'carta3',
      '-e',
      '-q',
      '-b',
      '105',
      inputFile,
      encodedFile,
    ])
    const encoded = parseWave(new Uint8Array(fs.readFileSync(encodedFile)))
    expect(encoded.profile.bitrateKbps).toBe(105)
    expect(encoded.fact.sampleCount).toBe(2048)

    await main(['node', 'carta3', '-d', '-q', encodedFile, decodedFile])
    const decoded = fs.readFileSync(decodedFile)
    expect(decoded.toString('ascii', 0, 4)).toBe('RIFF')
    expect(decoded.readUInt32LE(40)).toBe(2048 * 2 * 2)
  })

  it('requires force before overwriting output', async () => {
    fs.writeFileSync(encodedFile, 'keep')
    await expect(
      main(['node', 'carta3', '-e', '-q', inputFile, encodedFile])
    ).rejects.toThrow('Use --force to overwrite')
    expect(fs.readFileSync(encodedFile, 'utf8')).toBe('keep')

    await main([
      'node',
      'carta3',
      '-e',
      '-q',
      '--force',
      inputFile,
      encodedFile,
    ])
    expect(
      parseWave(new Uint8Array(fs.readFileSync(encodedFile))).frameCount
    ).toBe(5)
  })
})
