#!/usr/bin/env node

/**
 * Carta3 Audio Codec - Command Line Interface
 *
 * Usage:
 *   carta3 --encode input.wav output.at3.wav
 *   carta3 --decode input.at3.wav output.wav
 */

import { once } from 'node:events'
import fs from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { finished } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import cliProgress from 'cli-progress'
import { Command } from 'commander'
import {
  CHANNELS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
} from '../codec/core/constants.js'
import { resolveProfile } from '../codec/core/profiles.js'
import { createWaveStreamingDecoder } from '../codec/io/wave-decoder.js'
import { createWaveStreamingEncoder } from '../codec/io/wave-encoder.js'
import { createWaveHeader, parseWave } from '../codec/io/wave.js'
import {
  createPcmWaveHeader,
  interleavePcm16,
} from '../codec/io/serialization.js'

/**
 * Format a duration in seconds as MM:SS.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

/**
 * Display frame progress and real-time processing speed.
 */
class ProgressTracker {
  /**
   * Create a tracker for one encode or decode operation.
   *
   * @param {number} frameCount
   * @param {string} operation
   * @param {boolean} [quiet]
   */
  constructor(frameCount, operation, quiet = false) {
    this.totalFrames = frameCount
    this.quiet = quiet || frameCount === 0
    this.startTime = performance.now()
    this.frameCount = 0
    if (!this.quiet) {
      this.bar = new cliProgress.SingleBar(
        {
          autopadding: true,
          format: `${operation} |{bar}| {percentage}% | {value}/{total} frames | {elapsed}/{remaining} | RT: {speed}x`,
        },
        cliProgress.Presets.rect
      )
      this.bar.start(frameCount, 0, {
        elapsed: '00:00',
        remaining: '00:00',
        speed: '0.0',
      })
    }
  }

  /**
   * Set the number of source or container frames processed so far.
   *
   * @param {number} frameCount
   */
  update(frameCount) {
    this.frameCount = Math.min(frameCount, this.totalFrames)
    if (this.quiet) return
    const elapsed = (performance.now() - this.startTime) / 1000
    const audioProcessed = (this.frameCount * FRAME_SAMPLES) / SAMPLE_RATE
    const speed = elapsed > 0 ? audioProcessed / elapsed : 0
    const fraction = this.frameCount / this.totalFrames
    const totalTime = fraction > 0 ? elapsed / fraction : 0
    this.bar.update(this.frameCount, {
      elapsed: formatTime(elapsed),
      remaining: formatTime(Math.max(0, totalTime - elapsed)),
      speed: speed.toFixed(1),
    })
  }

  /**
   * Complete and stop the progress display.
   *
   * @param {boolean} [completed]
   */
  stop(completed = false) {
    if (this.quiet || !this.bar) return
    if (completed) this.update(this.totalFrames)
    this.bar.stop()
  }
}

/** Error caused by an invalid combination of command-line arguments. */
class CliUsageError extends Error {}

/**
 * Read exactly one fixed-size region from an open file.
 *
 * @param {object} handle
 * @param {number} length
 * @param {number} position
 * @returns {Promise<Uint8Array>}
 */
async function readExactly(handle, length, position) {
  const output = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(
      output,
      offset,
      length - offset,
      position + offset
    )
    if (bytesRead === 0) throw new RangeError('Truncated PCM WAVE file')
    offset += bytesRead
  }
  return output
}

/**
 * Parse the PCM format and data geometry needed for streaming input.
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function readPcmWaveMetadata(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const header = await readExactly(handle, 12, 0)
    if (
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new RangeError('Invalid PCM RIFF/WAVE signature')
    }

    let format = null
    let dataOffset = -1
    let dataBytes = -1
    for (let offset = 12; offset + 8 <= size;) {
      const chunkHeader = await readExactly(handle, 8, offset)
      const id = chunkHeader.toString('ascii', 0, 4)
      const declaredBytes = chunkHeader.readUInt32LE(4)
      const payload = offset + 8
      const chunkBytes =
        id === 'data' && declaredBytes === 0 ? size - payload : declaredBytes
      if (payload + chunkBytes > size) {
        throw new RangeError(`Truncated PCM WAVE ${id} chunk`)
      }

      if (id === 'fmt ') {
        if (chunkBytes < 16) {
          throw new RangeError('Invalid PCM WAVE format chunk')
        }
        const bytes = await readExactly(
          handle,
          Math.min(chunkBytes, 40),
          payload
        )
        const audioFormat = bytes.readUInt16LE(0)
        const extensiblePcm =
          audioFormat === 0xfffe &&
          chunkBytes >= 40 &&
          bytes.readUInt32LE(24) === 1
        if (audioFormat !== 1 && !extensiblePcm) {
          throw new RangeError('Input must use signed integer PCM')
        }
        format = {
          channels: bytes.readUInt16LE(2),
          sampleRate: bytes.readUInt32LE(4),
          blockAlign: bytes.readUInt16LE(12),
          bitDepth: bytes.readUInt16LE(14),
        }
      } else if (id === 'data') {
        dataOffset = payload
        dataBytes = chunkBytes
      }

      if (format && dataOffset !== -1) break
      offset = payload + chunkBytes + (chunkBytes & 1)
    }

    if (!format || dataOffset === -1) {
      throw new RangeError('Incomplete PCM WAVE file')
    }
    if (
      format.sampleRate !== SAMPLE_RATE ||
      format.bitDepth !== 16 ||
      (format.channels !== 1 && format.channels !== CHANNELS) ||
      format.blockAlign !== format.channels * 2 ||
      dataBytes % format.blockAlign !== 0
    ) {
      throw new RangeError(
        'Input must be 44.1 kHz, signed 16-bit PCM, mono or stereo WAVE'
      )
    }
    const sampleCount = dataBytes / format.blockAlign
    return {
      dataBytes,
      dataOffset,
      duration: sampleCount / SAMPLE_RATE,
      format,
      sampleCount,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Yield the PCM data portion of a WAVE file without its container chunks.
 *
 * @param {string} filePath
 * @param {object} metadata
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* readPcmChunks(filePath, metadata) {
  if (metadata.dataBytes === 0) return
  const stream = fs.createReadStream(filePath, {
    start: metadata.dataOffset,
    end: metadata.dataOffset + metadata.dataBytes - 1,
  })
  for await (const chunk of stream) yield chunk
}

/**
 * Convert interleaved signed PCM chunks to encoder-domain planar stereo.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {number} channelCount
 * @returns {AsyncGenerator<Float32Array[]>}
 */
async function* readPlanarPcm(chunks, channelCount) {
  let carry = Buffer.alloc(0)
  const blockBytes = channelCount * 2
  for await (const source of chunks) {
    const chunk = carry.length === 0 ? source : Buffer.concat([carry, source])
    const completeBytes = chunk.length - (chunk.length % blockBytes)
    carry = chunk.subarray(completeBytes)
    const sampleCount = completeBytes / blockBytes
    const channels = [
      new Float32Array(sampleCount),
      new Float32Array(sampleCount),
    ]
    for (let sample = 0; sample < sampleCount; sample++) {
      const left = chunk.readInt16LE(sample * blockBytes)
      channels[0][sample] = left
      channels[1][sample] =
        channelCount === 1 ? left : chunk.readInt16LE(sample * blockBytes + 2)
    }
    if (sampleCount !== 0) yield channels
  }
  if (carry.length !== 0) throw new RangeError('Truncated PCM sample')
}

/**
 * Write bytes while respecting stream backpressure.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {Uint8Array} bytes
 */
async function writeBytes(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain')
}

/**
 * Encode signed 16-bit PCM WAVE to WAVE_FORMAT_ATRAC3.
 *
 * @param {string} inputFile
 * @param {string} outputFile
 * @param {object} options
 */
async function encodeFile(inputFile, outputFile, options) {
  const bitrateKbps = Number(options.bitrate)
  const profile = resolveProfile({ bitrateKbps })
  if (!profile) throw new RangeError('Bitrate must be 66, 105, or 132 kbps')
  const metadata = await readPcmWaveMetadata(inputFile)
  const totalFrames = Math.ceil(metadata.sampleCount / FRAME_SAMPLES)

  if (!options.quiet) {
    console.log(
      `${inputFile} (WAV ${metadata.format.sampleRate}Hz ${metadata.format.channels}ch ${formatTime(metadata.duration)}) → ` +
        `${outputFile} (ATRAC3 ${bitrateKbps}kbps ${CHANNELS}ch)`
    )
  }

  const progress = new ProgressTracker(totalFrames, 'Encoding', options.quiet)
  let completed = false
  try {
    const encoder = createWaveStreamingEncoder({ bitrateKbps })
    const output = fs.createWriteStream(outputFile)
    await writeBytes(output, createWaveHeader(profile, 0, FRAME_SAMPLES, 0))
    let frameCount = 0
    let processedSamples = 0
    const chunks = readPcmChunks(inputFile, metadata)
    for await (const channels of readPlanarPcm(
      chunks,
      metadata.format.channels
    )) {
      for (const frame of encoder.write(channels)) {
        await writeBytes(output, frame)
        frameCount++
      }
      processedSamples += channels[0].length
      progress.update(Math.ceil(processedSamples / FRAME_SAMPLES))
    }
    for (const frame of encoder.finish()) {
      await writeBytes(output, frame)
      frameCount++
    }
    output.end()
    await finished(output)

    const waveHeader = createWaveHeader(
      profile,
      frameCount * profile.bytesPerFrame,
      FRAME_SAMPLES,
      encoder.sampleCount
    )
    const handle = await open(outputFile, 'r+')
    try {
      await handle.write(waveHeader, 0, waveHeader.length, 0)
    } finally {
      await handle.close()
    }
    completed = true
  } finally {
    progress.stop(completed)
  }
}

/**
 * Decode WAVE_FORMAT_ATRAC3 to signed 16-bit stereo PCM WAVE.
 *
 * @param {string} inputFile
 * @param {string} outputFile
 * @param {object} options
 */
async function decodeFile(inputFile, outputFile, options) {
  const input = new Uint8Array(await fs.promises.readFile(inputFile))
  const parsed = parseWave(input)
  const sampleCount = parsed.fact?.sampleCount
  if (sampleCount == null) {
    throw new RangeError('ATRAC3 WAVE fact sample count is required')
  }
  const duration = sampleCount / SAMPLE_RATE
  if (!options.quiet) {
    console.log(
      `${inputFile} (ATRAC3 ${parsed.profile.bitrateKbps}kbps ${CHANNELS}ch ${formatTime(duration)}) → ` +
        `${outputFile} (WAV ${SAMPLE_RATE}Hz ${CHANNELS}ch)`
    )
  }

  const progress = new ProgressTracker(
    parsed.frameCount,
    'Decoding',
    options.quiet
  )
  let completed = false
  try {
    const decoder = createWaveStreamingDecoder({
      bitrateKbps: parsed.profile.bitrateKbps,
      alignmentSampleCount: parsed.fact.alignmentSampleCount,
      sampleCount,
    })
    const output = fs.createWriteStream(outputFile)
    await writeBytes(output, createPcmWaveHeader({ sampleCount }))
    let frameCount = 0
    for (const frame of parsed.frames()) {
      const pcm = decoder.write(frame)
      if (pcm[0].length !== 0) {
        await writeBytes(output, interleavePcm16(pcm))
      }
      frameCount++
      progress.update(frameCount)
    }
    decoder.finish()
    output.end()
    await finished(output)
    completed = true
  } finally {
    progress.stop(completed)
  }
}

/**
 * Build the root-flag CLI shared by direct execution and CLI tests.
 *
 * @returns {Command}
 */
function createProgram() {
  const { version } = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  )
  return new Command()
    .name('carta3')
    .description('ATRAC3 Audio Codec')
    .version(version)
    .option('-e, --encode', 'Encode PCM WAVE to ATRAC3 WAVE')
    .option('-d, --decode', 'Decode ATRAC3 WAVE to PCM WAVE')
    .option('-q, --quiet', 'Suppress all output except errors')
    .option('-f, --force', 'Overwrite the output file if it exists')
    .option(
      '-b, --bitrate <kbps>',
      'ATRAC3 encoding bitrate: 66, 105, or 132 kbps',
      '132'
    )
    .argument('<input>', 'Input file path')
    .argument('<output>', 'Output file path')
}

/**
 * Parse arguments, validate shared CLI policy, and run one operation.
 *
 * @param {string[]} [argv]
 */
async function main(argv = process.argv) {
  const cli = createProgram()
  cli.parse(argv)
  const options = cli.opts()
  const [inputFile, outputFile] = cli.args
  const operationCount = [options.encode, options.decode].filter(Boolean).length
  if (operationCount === 0) {
    throw new CliUsageError('Must specify one of --encode or --decode')
  }
  if (operationCount > 1) {
    throw new CliUsageError('Cannot specify multiple operation modes')
  }
  if (options.decode && cli.getOptionValueSource('bitrate') === 'cli') {
    throw new CliUsageError('--bitrate only applies when encoding')
  }
  if (path.resolve(inputFile) === path.resolve(outputFile)) {
    throw new CliUsageError('Input and output paths must be different')
  }
  if (fs.existsSync(outputFile) && !options.force) {
    throw new CliUsageError(
      `Output file '${outputFile}' already exists. Use --force to overwrite.`
    )
  }

  if (options.encode) await encodeFile(inputFile, outputFile, options)
  else await decodeFile(inputFile, outputFile, options)
}

/** Execute the CLI and translate failures to a conventional exit status. */
async function run() {
  try {
    await main()
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`Error: File not found - ${error.path}`)
    } else {
      console.error(`Error: ${error.message}`)
      if (
        !(error instanceof CliUsageError) &&
        !process.argv.includes('--quiet') &&
        !process.argv.includes('-q')
      ) {
        console.error(error.stack)
      }
    }
    process.exitCode = 1
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(process.argv[1]))
  : null
if (entryPath?.href === import.meta.url) await run()

export {
  CliUsageError,
  ProgressTracker,
  createProgram,
  formatTime,
  main,
  readPcmWaveMetadata,
  run,
}
