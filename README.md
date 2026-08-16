# Carta3

Carta3 is a streaming ATRAC3 encoder and decoder in JavaScript. It provides
complete WAVE conversion, stateful frame and chunk APIs, a command-line tool,
and browser Web Worker bundles.

Frame coding is composed from explicit stages. Persistent state lives in
reusable buffer pools, and stereo frames are committed transactionally so a
failed channel cannot partially advance the stream.

## Supported profiles

Carta3 maintains stereo, 44.1 kHz ATRAC3 profiles at:

|  Bitrate | Frame layout         | Bytes per frame |
| -------: | -------------------- | --------------: |
|  66 kbps | Joint stereo         |             192 |
| 105 kbps | Independent channels |             304 |
| 132 kbps | Independent channels |             384 |

Each frame represents 1024 PCM samples per channel. Encoded files use
`WAVE_FORMAT_ATRAC3` (`0x0270`) with the canonical alignment and `fact`
timeline.

## Installation

Carta3 is an ES module and requires Node.js 20.16 or newer.

```bash
npm install carta3
```

To work from a repository checkout instead:

```bash
npm install
npm run check
```

## PCM convention

JavaScript encoder APIs accept planar stereo PCM as two equally sized
`Float32Array` instances. Samples use the normalized Web Audio convention from
`-1` through `1`. `AudioBuffer` channels can be passed directly:

```js
const left = audioBuffer.getChannelData(0)
const right = audioBuffer.getChannelData(1)
```

Decoded JavaScript PCM uses the same normalized convention.

## JavaScript API

### Complete WAVE files

Use `encodeWavePcm()` and `decodeWavePcm()` when the complete input fits in
memory:

```js
import { decodeWavePcm, encodeWavePcm } from 'carta3'

const wave = encodeWavePcm([left, right], {
  bitrateKbps: 105,
})

const [decodedLeft, decodedRight] = decodeWavePcm(wave)
```

`encodeWavePcm()` returns a `Uint8Array` containing a complete ATRAC3 WAVE
file. `decodeWavePcm()` accepts that byte image and returns two equally sized
`Float32Array` channels.

### Stateful frames

`encode()` and `decode()` create persistent closures for chronological,
complete frames. Reuse each closure for one stream; codec history advances only
after a frame succeeds.

```js
import { BufferPool, decode, encode } from 'carta3'

const encoderPool = new BufferPool()
const decoderPool = new BufferPool()
const encodeFrame = encode({ bitrateKbps: 132 }, encoderPool)
const decodeFrame = decode({ bitrateKbps: 132 }, decoderPool)

const encoded = encodeFrame([new Float32Array(1024), new Float32Array(1024)])
const [decodedLeft, decodedRight] = decodeFrame(encoded)
```

Encoded frame sizes are fixed by the selected profile. A caller normally does
not need to provide a `BufferPool`; the optional argument exists when ownership
and reuse need to be explicit.

### Arbitrary PCM chunks

`WaveStreamingEncoder` accepts arbitrary, equally sized planar PCM chunks and
lazily emits every complete encoded frame available from each chunk:

```js
import { WaveStreamingEncoder, createWave } from 'carta3'

const encoder = new WaveStreamingEncoder({ bitrateKbps: 105 })
const frames = []

for (const chunk of pcmChunks) frames.push(...encoder.frames(chunk))
frames.push(...encoder.finish())

const wave = createWave(frames, {
  bitrateKbps: 105,
  sampleCount: encoder.sampleCount,
})
```

Use `frames()` for bounded streaming. `write()` remains a convenience that
collects one chunk's output into an array. Call `finish()` once to flush the
partial frame and codec-delay drain frames.
`WaveStreamingDecoder` performs the inverse operation when given the profile,
visible sample count, and alignment sample count from the WAVE container.
`createWaveStreamingEncoder()` and `createWaveStreamingDecoder()` are factory
forms of the two constructors.

### Profiles and containers

`resolveProfile({ bitrateKbps, channels, sampleRate })` returns an immutable
descriptor for a maintained profile, or `null` for unsupported geometry.
`resolveWaveProfile(format)` performs the same lookup from parsed WAVE fields.

`createWave(frames, options)` combines complete profile-sized frames into a
WAVE byte image. `parseWave(bytes)` validates an ATRAC3 WAVE image and returns
its profile, optional `fact` metadata, data geometry, frame count, and a
lazy `frames()` generator of zero-copy frame views.

### Audio processor facade

`AudioProcessor` also provides async iterable adapters:

- `encodeStream(pcmChunks, options)` yields encoded frames with WAVE timeline
  alignment.
- `decodeStream(encodedFrames, options)` yields complete untrimmed decoded
  frames.
- `decodeWaveStream(encodedFrames, options)` yields timeline-trimmed chunks.
- `collectFrames(frameStream)` explicitly materializes a synchronous or
  asynchronous frame stream when an array is required.
- `frameBufferToFrames(buffers, frameSize)` divides complete planar buffers
  into zero-padded frames.
- `encodeWavePcm(channels, options)` and `decodeWavePcm(bytes)` expose the
  complete-file helpers through the facade.
- `createWaveBlob()`, `parseWaveBlob()`, and `createPcmWaveBlob()` provide
  browser-oriented container helpers.

The supported package surface is exported from `codec/index.js`. Concrete
codec modules remain importable for tests and development, but are not part of
the package compatibility contract.

## Browser worker

The production build writes a worker and an ES module client to `dist/`. Serve
both files from the same origin as the application, for example by copying them
from `node_modules/carta3/dist/` into the application's public assets:

```js
import { Carta3Worker } from '/vendor/carta3-worker-interface.min.js'

const codec = new Carta3Worker('/vendor/carta3-worker.min.js')

const { waveBlob, info } = await codec.encode([left, right], {
  bitrateKbps: 105,
})
const inspected = await codec.inspect(waveBlob)
const { wavBlob } = await codec.decode(waveBlob)
const profiles = await codec.getProfiles()

codec.terminate()
```

`encode()` accepts normalized planar PCM and returns an ATRAC3 WAVE `Blob`.
`decode()` accepts a `Blob`, `ArrayBuffer`, or `Uint8Array` and returns a signed
16-bit PCM WAVE `Blob`. `inspect()` reads container metadata without decoding.
Always call `terminate()` when the worker is no longer needed.

The build also produces `dist/carta3.min.js`, a UMD bundle exposing the main
JavaScript API as the global `Carta3` object.

## CLI

Run the installed executable directly or use `npx carta3` from a project that
depends on Carta3:

```bash
carta3 --encode input.wav output.at3.wav
carta3 --encode --bitrate 105 input.wav output.at3.wav
carta3 --decode input.at3.wav output.wav

npx carta3 --encode input.wav output.at3.wav
```

The encoder accepts 44.1 kHz signed 16-bit PCM WAVE input. Mono input is folded
to dual mono; ATRAC3 output is always stereo. Decoding produces a stereo signed
16-bit PCM WAVE file.

| Option                 | Meaning                                          |
| ---------------------- | ------------------------------------------------ |
| `-e, --encode`         | Encode PCM WAVE to ATRAC3 WAVE.                  |
| `-d, --decode`         | Decode ATRAC3 WAVE to PCM WAVE.                  |
| `-b, --bitrate <kbps>` | Encode at 66, 105, or 132 kbps; defaults to 132. |
| `-q, --quiet`          | Suppress normal output and progress.             |
| `-f, --force`          | Overwrite an existing output file.               |
| `-V, --version`        | Print the Carta3 version.                        |
| `-h, --help`           | Print command help.                              |

Exactly one of `--encode` and `--decode` is required. `--bitrate` only applies
when encoding, and input and output paths must be different.

## Compatibility and limitations

- Encoding and decoding are limited to the three stereo, 44.1 kHz profiles
  listed above.
- The CLI accepts mono or stereo signed 16-bit PCM WAVE for encoding; the
  JavaScript encoder APIs require planar stereo `Float32Array` input.
- The maintained container contract is RIFF/WAVE with the ATRAC3 format tag,
  canonical extension fields, frame alignment, and timeline metadata.
- Stateful frame APIs must receive frames in order and must not be shared
  between independent streams.
- Browser workers must be served from a location allowed by the application's
  worker and Content Security Policy settings.

## Development

The codec keeps its top-level encode and decode pipelines explicit. Existing
directories divide implementation concerns without changing those pipelines:

| Path                | Responsibility                                                  |
| ------------------- | --------------------------------------------------------------- |
| `codec/pipeline/`   | Ordered encoder and decoder stage composition.                  |
| `codec/analysis/`   | Signal measurements and encoder decisions.                      |
| `codec/coding/`     | Allocation, quantization, and coding policy.                    |
| `codec/transforms/` | QMF, MDCT, gain, and stereo transforms.                         |
| `codec/io/`         | Bitstream syntax, WAVE framing, and streaming adapters.         |
| `codec/state/`      | Structured persistent state and non-trivial scratch classes.    |
| `codec/core/`       | Profiles, constants, tables, and raw buffer ownership.          |
| `codec/browser/`    | Web Worker implementation and client.                           |
| `bin/`              | Command-line boundary.                                          |
| `tests/`            | Unit, transaction, byte-vector, streaming, WAVE, and CLI tests. |

Common commands are:

```bash
npm test            # Run the test suite once
npm run test:watch  # Re-run affected tests while editing
npm run lint        # Check JavaScript and formatting
npm run format      # Apply repository formatting
npm run build       # Build the three browser bundles
npm run check       # Run lint, tests, and the production build
```

Run `npm run check` before submitting a change. Pull requests and pushes run
the same gate in CI. Algorithm changes should preserve or deliberately update
the exact reference vectors and transactional failure expectations covered by
the tests.

## License

ISC
