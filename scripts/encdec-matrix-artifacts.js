#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import {
  decodeAt3WavBuffer,
  encodeAtracWavBufferFromInterleavedPcm,
  listAtracEncodeProfiles,
  parsePcm16WavBuffer,
} from "../src/index.js";

const ROOT = process.cwd();
const DEFAULT_INPUT_WAV_PATH = path.join(ROOT, "test", "fixtures", "anytime_t30.wav");
const DEFAULT_OUT_DIR = path.join(ROOT, "test", "fixtures", "current");
const DEFAULT_EXPECTED_DIR = path.join(ROOT, "test", "fixtures", "expected");

const INPUT_WAV_ENV_PRIMARY = "CARTA_ENCDEC_WAV";
const INPUT_WAV_ENV_FALLBACK = "CARTA_SNR_WAV";
const OUTPUT_DIR_ENV = "CARTA_ENCDEC_OUT_DIR";
const EXPECTED_DIR_ENV = "CARTA_ENCDEC_EXPECTED_DIR";
const JOBS_ENV = "CARTA_ENCDEC_JOBS";

function defaultJobs() {
  if (typeof os.availableParallelism === "function") {
    const parallelism = os.availableParallelism();
    if (Number.isInteger(parallelism) && parallelism > 0) {
      return parallelism | 0;
    }
  }

  const cpuCount = os.cpus().length | 0;
  return cpuCount > 0 ? cpuCount : 1;
}

function parsePositiveInt(value, label) {
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`invalid ${label} value: ${value}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${label} value: ${value}`);
  }
  return parsed | 0;
}

function parseArgs(argv) {
  const jobsRaw = process.env[JOBS_ENV];
  const jobs =
    jobsRaw == null || jobsRaw === "" ? defaultJobs() : parsePositiveInt(jobsRaw, `$${JOBS_ENV}`);

  const out = {
    inputWavPath: path.resolve(
      process.env[INPUT_WAV_ENV_PRIMARY] ??
        process.env[INPUT_WAV_ENV_FALLBACK] ??
        DEFAULT_INPUT_WAV_PATH
    ),
    outDir: path.resolve(process.env[OUTPUT_DIR_ENV] ?? DEFAULT_OUT_DIR),
    expectedDir: path.resolve(process.env[EXPECTED_DIR_ENV] ?? DEFAULT_EXPECTED_DIR),
    jobs,
    clean: true,
    writeEncoded: false,
    limit: null,
    quiet: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--wav") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("missing value for --wav");
      }
      out.inputWavPath = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--out") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("missing value for --out");
      }
      out.outDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--jobs") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("missing value for --jobs");
      }
      out.jobs = parsePositiveInt(next, "--jobs");
      i += 1;
      continue;
    }
    if (arg === "--clean") {
      out.clean = true;
      continue;
    }
    if (arg === "--no-clean") {
      out.clean = false;
      continue;
    }
    if (arg === "--write-encoded") {
      out.writeEncoded = true;
      continue;
    }
    if (arg === "--quiet") {
      out.quiet = true;
      continue;
    }
    if (arg === "--limit") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("missing value for --limit");
      }
      out.limit = parsePositiveInt(next, "--limit");
      i += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return out;
}

function clampI16(v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v | 0;
}

function sha256Hex(bufferLike) {
  return createHash("sha256").update(bufferLike).digest("hex");
}

function resampleLinearInterleavedI16(samples, channels, inSampleRate, outSampleRate) {
  const chCount = channels | 0;
  if (chCount <= 0) {
    throw new Error(`invalid channel count: ${channels}`);
  }
  if (samples.length % chCount !== 0) {
    throw new Error(
      `input samples not aligned to channels: len=${samples.length} channels=${chCount}`
    );
  }

  const inFrames = (samples.length / chCount) | 0;
  if (inFrames <= 1) {
    throw new Error("input contains too few samples to resample");
  }
  const inRate = inSampleRate | 0;
  const outRate = outSampleRate | 0;
  if (inRate <= 0 || outRate <= 0) {
    throw new Error(`invalid sample rates: in=${inSampleRate} out=${outSampleRate}`);
  }

  const outFrames = Math.max(1, Math.round((inFrames * outRate) / inRate)) | 0;
  const ratio = inRate / outRate;
  const out = new Int16Array(outFrames * chCount);

  for (let i = 0; i < outFrames; i += 1) {
    const pos = i * ratio;
    let idx0 = Math.floor(pos);
    if (idx0 < 0) idx0 = 0;
    if (idx0 >= inFrames - 1) idx0 = inFrames - 1;
    const idx1 = idx0 >= inFrames - 1 ? idx0 : idx0 + 1;
    const frac = idx1 === idx0 ? 0 : pos - idx0;

    const base0 = idx0 * chCount;
    const base1 = idx1 * chCount;
    const outBase = i * chCount;
    for (let ch = 0; ch < chCount; ch += 1) {
      const s0 = samples[base0 + ch] | 0;
      const s1 = samples[base1 + ch] | 0;
      const v = s0 + (s1 - s0) * frac;
      out[outBase + ch] = clampI16(Math.round(v));
    }
  }

  return out;
}

function remapChannelsInterleavedI16(samples, inChannels, outChannels) {
  const inCh = inChannels | 0;
  const outCh = outChannels | 0;
  if (inCh <= 0 || outCh <= 0) {
    throw new Error(`invalid channel remap: in=${inChannels} out=${outChannels}`);
  }
  if (samples.length % inCh !== 0) {
    throw new Error(
      `input samples not aligned to channels: len=${samples.length} channels=${inCh}`
    );
  }

  if (inCh === outCh) {
    return samples;
  }

  const frames = (samples.length / inCh) | 0;
  const out = new Int16Array(frames * outCh);

  if (outCh === 1) {
    for (let i = 0; i < frames; i += 1) {
      const base = i * inCh;
      let acc = 0;
      for (let ch = 0; ch < inCh; ch += 1) {
        acc += samples[base + ch] | 0;
      }
      out[i] = clampI16(Math.round(acc / inCh));
    }
    return out;
  }

  for (let i = 0; i < frames; i += 1) {
    const inBase = i * inCh;
    const outBase = i * outCh;
    for (let ch = 0; ch < outCh; ch += 1) {
      out[outBase + ch] = samples[inBase + (ch % inCh)];
    }
  }

  return out;
}

function createAnytimeInputPcm(profile, source) {
  let pcm = source.samples;
  let channels = source.channels | 0;
  let sampleRate = source.sampleRate | 0;

  if ((sampleRate | 0) !== (profile.sampleRate | 0)) {
    pcm = resampleLinearInterleavedI16(pcm, channels, sampleRate, profile.sampleRate);
    sampleRate = profile.sampleRate | 0;
  }

  if ((channels | 0) !== (profile.channels | 0)) {
    pcm = remapChannelsInterleavedI16(pcm, channels, profile.channels);
    channels = profile.channels | 0;
  }

  if ((sampleRate | 0) !== (profile.sampleRate | 0) || (channels | 0) !== (profile.channels | 0)) {
    throw new Error(
      `internal error: createAnytimeInputPcm produced ${sampleRate}hz/${channels}ch, expected ${profile.sampleRate}hz/${profile.channels}ch`
    );
  }

  return pcm;
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function artifactBaseName(index, profile) {
  return `${pad3(index)}_${profile.codec}_sr${profile.sampleRate}_ch${profile.channels}_br${profile.bitrateKbps}`;
}

function buildExpectedDecodedIndex(dir) {
  const decodedBySuffix = new Map();
  const decodedByBasename = new Map();

  if (!existsSync(dir)) {
    return { decodedBySuffix, decodedByBasename };
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(".decoded.wav")) continue;
    const full = path.join(dir, name);
    decodedByBasename.set(name, full);

    const suffix = name.replace(/^[0-9]+_/, "");
    if (!decodedBySuffix.has(suffix)) {
      decodedBySuffix.set(suffix, full);
    }
  }

  return { decodedBySuffix, decodedByBasename };
}

function expectedDecodedPathForArtifact(decodedWavPath, profile, expectedIndex) {
  const directBasename = path.basename(decodedWavPath);
  const direct = expectedIndex.decodedByBasename.get(directBasename);
  if (direct) return direct;

  const suffix = `${profile.codec}_sr${profile.sampleRate}_ch${profile.channels}_br${profile.bitrateKbps}.decoded.wav`;
  return expectedIndex.decodedBySuffix.get(suffix) ?? null;
}

function computeSnrDbI16(expectedI16, actualI16) {
  const minLen = Math.min(expectedI16.length, actualI16.length);
  const scale = 1 / 32768;
  let signal = 0;
  let noise = 0;

  for (let i = 0; i < minLen; i += 1) {
    const ref = expectedI16[i] * scale;
    const diff = (expectedI16[i] - actualI16[i]) * scale;
    signal += ref * ref;
    noise += diff * diff;
  }

  if (expectedI16.length > minLen) {
    for (let i = minLen; i < expectedI16.length; i += 1) {
      const ref = expectedI16[i] * scale;
      const refSq = ref * ref;
      signal += refSq;
      noise += refSq;
    }
  } else if (actualI16.length > minLen) {
    for (let i = minLen; i < actualI16.length; i += 1) {
      const diff = -actualI16[i] * scale;
      noise += diff * diff;
    }
  }

  if (noise === 0) return Number.POSITIVE_INFINITY;
  if (signal === 0) return Number.NEGATIVE_INFINITY;
  return 10 * Math.log10(signal / noise);
}

function formatSnrTag(snrDb) {
  if (snrDb === Number.POSITIVE_INFINITY) return "Infdb";
  if (snrDb === Number.NEGATIVE_INFINITY) return "-Infdb";
  if (!Number.isFinite(snrDb)) return "NaNdb";
  return `${Math.round(snrDb)}db`;
}

function resolveJobs(jobs) {
  if (jobs == null) {
    const jobsRaw = process.env[JOBS_ENV];
    if (jobsRaw == null || jobsRaw === "") {
      return defaultJobs();
    }
    return parsePositiveInt(jobsRaw, `$${JOBS_ENV}`);
  }
  return parsePositiveInt(jobs, "jobs");
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? "",
    };
  }
  return {
    name: "Error",
    message: String(error),
    stack: "",
  };
}

function generateArtifact({ index, profile, source, outDir, expectedIndex, writeEncoded }) {
  const base = artifactBaseName(index, profile);
  const encodedPath = path.join(outDir, `${base}.encoded.at3.wav`);
  const decodedPath = path.join(outDir, `${base}.decoded.wav`);

  const pcm = createAnytimeInputPcm(profile, source);
  const encoded = encodeAtracWavBufferFromInterleavedPcm(pcm, {
    codec: profile.codec,
    bitrateKbps: profile.bitrateKbps,
    channels: profile.channels,
    sampleRate: profile.sampleRate,
  });

  const decoded = decodeAt3WavBuffer(encoded.buffer);
  if (
    (decoded.metadata.sampleRate | 0) !== (profile.sampleRate | 0) ||
    (decoded.metadata.channels | 0) !== (profile.channels | 0)
  ) {
    throw new Error(
      `decoded format mismatch for ${base} ` +
        `(got ${decoded.metadata.sampleRate}hz/${decoded.metadata.channels}ch)`
    );
  }
  if (decoded.pcm.length !== pcm.length) {
    throw new Error(
      `decoded PCM length mismatch for ${base} ` +
        `(input=${pcm.length} decoded=${decoded.pcm.length})`
    );
  }

  if (writeEncoded) {
    writeFileSync(encodedPath, encoded.buffer);
  }
  writeFileSync(decodedPath, decoded.toPcmWavBuffer());

  const encBytes = encoded.buffer.length | 0;
  const decSamples = decoded.pcm.length | 0;

  const expectedDecodedPath =
    expectedIndex != null
      ? expectedDecodedPathForArtifact(decodedPath, profile, expectedIndex)
      : null;
  const snrDb =
    expectedDecodedPath != null
      ? computeSnrDbI16(parsePcm16WavBuffer(readFileSync(expectedDecodedPath)).samples, decoded.pcm)
      : null;

  return {
    index: index | 0,
    codec: profile.codec,
    sampleRate: profile.sampleRate | 0,
    channels: profile.channels | 0,
    bitrateKbps: profile.bitrateKbps | 0,
    frameSamples: profile.frameSamples | 0,
    inputFrames: (pcm.length / profile.channels) | 0,
    encodedBytes: encBytes,
    decodedSamples: decSamples,
    encodedWavPath: writeEncoded ? encodedPath : null,
    decodedPcmWavPath: decodedPath,
    expectedDecodedPcmWavPath: expectedDecodedPath,
    snrDb,
  };
}

async function runArtifactsParallel({
  profiles,
  source,
  outDir,
  expectedDir,
  writeEncoded,
  quiet,
  jobs,
}) {
  const total = profiles.length | 0;
  if (total <= 0) {
    return [];
  }

  const workerCount = Math.min(jobs | 0, total) | 0;
  if (workerCount <= 1) {
    throw new Error("internal error: parallel runner called with workerCount <= 1");
  }

  const sourceSamplesShared = new SharedArrayBuffer(source.samples.byteLength);
  new Int16Array(sourceSamplesShared).set(source.samples);

  const artifactsByIndex = new Array(total);
  let completed = 0;
  let nextIndex = 0;
  let aborted = false;

  const workers = [];
  const workerExitPromises = [];

  function shutdownWorkers() {
    for (const worker of workers) {
      worker.postMessage({ type: "shutdown" });
    }
  }

  function terminateWorkers() {
    return Promise.allSettled(workers.map((w) => w.terminate()));
  }

  const baseWorkerData = {
    outDir,
    expectedDir,
    writeEncoded: !!writeEncoded,
    source: {
      sampleRate: source.sampleRate,
      channels: source.channels,
      samplesShared: sourceSamplesShared,
    },
  };

  await new Promise((resolve, reject) => {
    function abort(err) {
      if (aborted) return;
      aborted = true;
      terminateWorkers().finally(() => reject(err));
    }

    function dispatch(worker) {
      if (aborted) return;
      if (nextIndex >= total) return;
      const index = nextIndex | 0;
      nextIndex += 1;
      worker.postMessage({ type: "task", index, profile: profiles[index] });
    }

    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(new URL(import.meta.url), {
        type: "module",
        workerData: baseWorkerData,
      });
      workers.push(worker);
      workerExitPromises.push(new Promise((r) => worker.once("exit", r)));

      worker.on("error", (err) => {
        abort(err);
      });

      worker.on("message", (msg) => {
        if (aborted) return;
        if (msg == null || typeof msg !== "object") return;

        if (msg.type === "result") {
          artifactsByIndex[msg.index | 0] = msg.artifact;
          completed += 1;

          if (!quiet) {
            const rel = path.relative(ROOT, msg.artifact.decodedPcmWavPath);
            const snrTag =
              msg.artifact.snrDb == null ? "" : ` (${formatSnrTag(msg.artifact.snrDb)})`;
            console.log(`[${completed}/${total}] wrote ${rel}${snrTag}`);
          }

          if (completed >= total) {
            shutdownWorkers();
            resolve();
            return;
          }

          dispatch(worker);
          return;
        }

        if (msg.type === "error") {
          const label = msg.index == null ? "unknown" : String(msg.index | 0);
          const message = msg.error?.message ?? "unknown worker error";
          const err = new Error(`worker failed for profile ${label}: ${message}`);
          if (msg.error?.stack) {
            err.stack = msg.error.stack;
          }
          abort(err);
        }
      });

      dispatch(worker);
    }
  });

  await Promise.all(workerExitPromises);

  for (let i = 0; i < total; i += 1) {
    if (artifactsByIndex[i] == null) {
      throw new Error(`internal error: missing artifact result for index ${i}`);
    }
  }

  return artifactsByIndex;
}

export async function runMatrixEncdecArtifacts({
  inputWavPath = path.resolve(
    process.env[INPUT_WAV_ENV_PRIMARY] ??
      process.env[INPUT_WAV_ENV_FALLBACK] ??
      DEFAULT_INPUT_WAV_PATH
  ),
  outDir = path.resolve(process.env[OUTPUT_DIR_ENV] ?? DEFAULT_OUT_DIR),
  expectedDir = path.resolve(process.env[EXPECTED_DIR_ENV] ?? DEFAULT_EXPECTED_DIR),
  clean = true,
  writeEncoded = false,
  limit = null,
  jobs = null,
  quiet = false,
} = {}) {
  if (!isMainThread) {
    throw new Error("runMatrixEncdecArtifacts must be called from the main thread");
  }

  const normalizedInputWavPath = path.resolve(inputWavPath);
  const normalizedOutDir = path.resolve(outDir);
  const normalizedExpectedDir = expectedDir == null ? null : path.resolve(expectedDir);

  if (!existsSync(normalizedInputWavPath)) {
    return {
      ok: false,
      written: false,
      profileCount: 0,
      inputWavPath: normalizedInputWavPath,
      outDir: normalizedOutDir,
      message:
        `missing PCM16 WAV input: ${normalizedInputWavPath}\n` +
        `Provide it at that path or set $${INPUT_WAV_ENV_PRIMARY} (or $${INPUT_WAV_ENV_FALLBACK}).`,
    };
  }

  const bytes = readFileSync(normalizedInputWavPath);
  const inputSha256 = sha256Hex(bytes);
  const parsed = parsePcm16WavBuffer(bytes);
  const source = {
    name: path.basename(normalizedInputWavPath),
    sha256: inputSha256,
    sampleRate: parsed.sampleRate | 0,
    channels: parsed.channels | 0,
    frames: (parsed.samples.length / parsed.channels) | 0,
    samples: parsed.samples,
  };

  const resolvedJobs = resolveJobs(jobs);

  let profiles = listAtracEncodeProfiles().map((p) => ({
    codec: p.codec,
    bitrateKbps: p.bitrateKbps | 0,
    sampleRate: p.sampleRate | 0,
    channels: p.channels | 0,
    frameSamples: p.frameSamples | 0,
  }));

  if (Number.isInteger(limit) && (limit | 0) > 0) {
    profiles = profiles.slice(0, limit | 0);
  }

  if (clean) {
    rmSync(normalizedOutDir, { recursive: true, force: true });
  }
  mkdirSync(normalizedOutDir, { recursive: true });

  const workerCount = Math.min(resolvedJobs, profiles.length) | 0;

  let artifacts;
  if (workerCount <= 1) {
    const expectedIndex =
      normalizedExpectedDir && existsSync(normalizedExpectedDir)
        ? buildExpectedDecodedIndex(normalizedExpectedDir)
        : null;

    artifacts = [];
    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index];
      const artifact = generateArtifact({
        index,
        profile,
        source,
        outDir: normalizedOutDir,
        expectedIndex,
        writeEncoded,
      });
      artifacts.push(artifact);

      if (!quiet) {
        const rel = path.relative(ROOT, artifact.decodedPcmWavPath);
        const snrTag = artifact.snrDb == null ? "" : ` (${formatSnrTag(artifact.snrDb)})`;
        console.log(`[${index + 1}/${profiles.length}] wrote ${rel}${snrTag}`);
      }
    }
  } else {
    artifacts = await runArtifactsParallel({
      profiles,
      source,
      outDir: normalizedOutDir,
      expectedDir: normalizedExpectedDir,
      writeEncoded,
      quiet,
      jobs: workerCount,
    });
  }

  const manifestPath = path.join(normalizedOutDir, "manifest.json");
  const manifest = {
    kind: "carta3:encdec-matrix",
    generatedAt: new Date().toISOString(),
    input: {
      path: normalizedInputWavPath,
      name: source.name,
      sha256: source.sha256,
      sampleRate: source.sampleRate,
      channels: source.channels,
      frames: source.frames,
    },
    outDir: normalizedOutDir,
    writeEncoded: !!writeEncoded,
    profileCount: artifacts.length,
    artifacts,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    ok: true,
    written: true,
    profileCount: artifacts.length,
    inputWavPath: normalizedInputWavPath,
    outDir: normalizedOutDir,
    manifestPath,
    artifacts,
    message: `wrote ${artifacts.length} decoded WAV files to ${normalizedOutDir}`,
  };
}

function isCliMain() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return path.resolve(argv1) === fileURLToPath(import.meta.url);
}

function startWorkerThread() {
  if (!parentPort) {
    return;
  }

  const outDir = workerData?.outDir;
  const expectedDir = workerData?.expectedDir;
  const writeEncoded = !!workerData?.writeEncoded;
  const source = workerData?.source;
  if (!outDir || !source || !source.samplesShared) {
    parentPort.postMessage({
      type: "error",
      index: null,
      error: serializeError(new Error("missing workerData for encdec-matrix worker")),
    });
    parentPort.close();
    return;
  }

  const normalizedOutDir = path.resolve(outDir);
  const normalizedExpectedDir = expectedDir == null ? null : path.resolve(expectedDir);
  const expectedIndex =
    normalizedExpectedDir && existsSync(normalizedExpectedDir)
      ? buildExpectedDecodedIndex(normalizedExpectedDir)
      : null;

  const sharedSamples = new Int16Array(source.samplesShared);
  const sharedSource = {
    sampleRate: source.sampleRate | 0,
    channels: source.channels | 0,
    samples: sharedSamples,
  };

  parentPort.on("message", (msg) => {
    if (msg == null || typeof msg !== "object") return;
    if (msg.type === "shutdown") {
      parentPort.close();
      return;
    }
    if (msg.type !== "task") return;

    const index = msg.index | 0;
    try {
      const artifact = generateArtifact({
        index,
        profile: msg.profile,
        source: sharedSource,
        outDir: normalizedOutDir,
        expectedIndex,
        writeEncoded,
      });
      parentPort.postMessage({ type: "result", index, artifact });
    } catch (error) {
      parentPort.postMessage({ type: "error", index, error: serializeError(error) });
    }
  });
}

if (!isMainThread) {
  startWorkerThread();
}

if (isCliMain() && isMainThread) {
  const args = parseArgs(process.argv);
  runMatrixEncdecArtifacts({
    inputWavPath: args.inputWavPath,
    outDir: args.outDir,
    expectedDir: args.expectedDir,
    clean: args.clean,
    writeEncoded: args.writeEncoded,
    limit: args.limit,
    jobs: args.jobs,
    quiet: args.quiet,
  })
    .then((result) => {
      if (result.ok) {
        console.log(result.message);
      } else {
        console.error(result.message);
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exitCode = 1;
    });
}
