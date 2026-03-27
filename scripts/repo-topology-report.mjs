/* global console */

import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

import esbuild from "esbuild";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SRC_DIR = path.join(ROOT_DIR, "src");

function toPosixPath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function relativePath(filePath) {
  return toPosixPath(path.relative(ROOT_DIR, filePath));
}

function walkJsFiles(dirPath, files = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }

  return files;
}

function classifyFile(filePath) {
  const relPath = relativePath(filePath);
  const parts = relPath.split("/");

  if (parts.length === 2) {
    return {
      domain: "root",
      family: `root/${parts[1].replace(/\.js$/, "")}`,
    };
  }

  const [, domain, maybeSubdir, fileName] = parts;
  const moduleName = parts.at(-1).replace(/\.js$/, "");

  if (domain === "common") {
    if (moduleName.startsWith("pcm-planar")) {
      return { domain, family: "common/pcm" };
    }
    return { domain, family: `common/${moduleName}` };
  }

  if (domain === "container") {
    if (["index", "node", "internal"].includes(moduleName)) {
      return { domain, family: `container/${moduleName}` };
    }
    if (moduleName.startsWith("wav-")) {
      return { domain, family: "container/wav" };
    }
    if (moduleName === "decode") {
      return { domain, family: "container/decode" };
    }
    if (moduleName === "pcm-writer") {
      return { domain, family: "container/pcm-writer" };
    }
    return { domain, family: `container/${moduleName}` };
  }

  if (domain === "encoders") {
    if (moduleName === "index") {
      return { domain, family: "encoders/index" };
    }
    if (moduleName.startsWith("atrac3-scx")) {
      return { domain, family: "encoders/atrac3-scx" };
    }
    if (moduleName.startsWith("atrac3plus")) {
      return { domain, family: "encoders/atrac3plus" };
    }
    if (moduleName.startsWith("atrac3")) {
      return { domain, family: "encoders/atrac3" };
    }
    if (moduleName.startsWith("atrac")) {
      return { domain, family: "encoders/atrac" };
    }
    if (moduleName.startsWith("profiles")) {
      return { domain, family: "encoders/profiles" };
    }
    return { domain, family: `encoders/${moduleName}` };
  }

  if (domain === "atrac3") {
    if (maybeSubdir === "scx" && fileName) {
      return { domain, family: "atrac3/scx" };
    }
    if (
      [
        "index",
        "internal",
        "constants",
        "decode",
        "decode-output",
        "decoder",
        "decoder-state",
        "wav-format",
      ].includes(moduleName)
    ) {
      return { domain, family: `atrac3/${moduleName}` };
    }
    if (moduleName.startsWith("decode-")) {
      return { domain, family: "atrac3/decode-stage" };
    }
    if (moduleName.startsWith("frame-") || moduleName === "frame") {
      return { domain, family: "atrac3/frame" };
    }
    if (moduleName.startsWith("proc-")) {
      return { domain, family: "atrac3/proc" };
    }
    if (moduleName.startsWith("profile")) {
      return { domain, family: "atrac3/profiles" };
    }
    if (moduleName.startsWith("transform") || moduleName === "qmf") {
      return { domain, family: "atrac3/transform" };
    }
    if (moduleName.startsWith("channel-conversion") || moduleName === "channel-rebalance") {
      return { domain, family: "atrac3/channel-conversion" };
    }
    if (moduleName.endsWith("tables") || moduleName === "float32") {
      return { domain, family: "atrac3/tables" };
    }
    if (moduleName.startsWith("encode-runtime")) {
      return { domain, family: "atrac3/encode-runtime" };
    }
    return { domain, family: `atrac3/${moduleName}` };
  }

  if (domain === "atrac3plus") {
    if (fileName) {
      return { domain, family: `atrac3plus/${maybeSubdir}` };
    }
    if (
      [
        "index",
        "internal",
        "codec",
        "codec-internal",
        "decode",
        "decode-output",
        "decode-spectrum",
        "decoder",
        "encode",
        "encode-handle",
        "handle",
        "runtime",
        "state",
        "subsystems",
        "topology",
        "profiles",
        "profile-table",
        "wav-format",
      ].includes(moduleName)
    ) {
      return { domain, family: `atrac3plus/${moduleName}` };
    }
    if (moduleName.includes("stereo")) {
      return { domain, family: "atrac3plus/stereo" };
    }
    if (moduleName.includes("shared")) {
      return { domain, family: "atrac3plus/shared" };
    }
    if (moduleName.includes("math")) {
      return { domain, family: "atrac3plus/math" };
    }
    if (
      moduleName.includes("dsp") ||
      moduleName.includes("dft") ||
      moduleName.includes("synthesis")
    ) {
      return { domain, family: "atrac3plus/dsp" };
    }
    if (moduleName.includes("rebitalloc")) {
      return { domain, family: "atrac3plus/rebitalloc" };
    }
    return { domain, family: `atrac3plus/${moduleName}` };
  }

  return { domain, family: `${domain}/${moduleName}` };
}

async function collectGraph(files) {
  const graph = new Map(files.map((filePath) => [filePath, []]));
  const entryContents = files.map((filePath) => `import "./${relativePath(filePath)}";`).join("\n");

  const result = await esbuild.build({
    stdin: {
      contents: entryContents,
      resolveDir: ROOT_DIR,
      sourcefile: "topology-entry.js",
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    treeShaking: false,
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  for (const [inputPath, meta] of Object.entries(result.metafile.inputs)) {
    const absPath = path.join(ROOT_DIR, inputPath);
    if (!graph.has(absPath)) {
      continue;
    }

    const dependencies = new Set();
    for (const entry of meta.imports ?? []) {
      const depPath = entry.path;
      if (typeof depPath !== "string" || !depPath.startsWith("src/")) {
        continue;
      }

      const absDependency = path.join(ROOT_DIR, depPath);
      if (graph.has(absDependency)) {
        dependencies.add(absDependency);
      }
    }

    graph.set(absPath, [...dependencies]);
  }

  return graph;
}

function collectStronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const stack = [];
  const stackSet = new Set();
  const indexByNode = new Map();
  const lowByNode = new Map();
  const components = [];

  function visit(node) {
    indexByNode.set(node, nextIndex);
    lowByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    stackSet.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!graph.has(dependency)) {
        continue;
      }

      if (!indexByNode.has(dependency)) {
        visit(dependency);
        lowByNode.set(node, Math.min(lowByNode.get(node), lowByNode.get(dependency)));
      } else if (stackSet.has(dependency)) {
        lowByNode.set(node, Math.min(lowByNode.get(node), indexByNode.get(dependency)));
      }
    }

    if (lowByNode.get(node) !== indexByNode.get(node)) {
      return;
    }

    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      stackSet.delete(member);
      component.push(member);
      if (member === node) {
        break;
      }
    }

    if (component.length > 1) {
      components.push(component);
    }
  }

  for (const node of graph.keys()) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components;
}

function increment(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function topEntries(map, limit) {
  return [...map.entries()]
    .sort((left, right) => {
      return right[1] - left[1] || String(left[0]).localeCompare(String(right[0]));
    })
    .slice(0, limit);
}

function printSection(title) {
  console.log(`\n${title}`);
}

const files = walkJsFiles(SRC_DIR).sort();
const graph = await collectGraph(files);
const components = collectStronglyConnectedComponents(graph);

const domainCounts = new Map();
const familyCounts = new Map();
const domainEdges = new Map();
const familyEdges = new Map();
const indegreeCounts = new Map(files.map((filePath) => [filePath, 0]));
const outdegreeCounts = new Map(files.map((filePath) => [filePath, 0]));

for (const filePath of files) {
  const { domain, family } = classifyFile(filePath);
  increment(domainCounts, domain);
  increment(familyCounts, family);

  const seenDependencies = new Set();
  for (const dependency of graph.get(filePath) ?? []) {
    if (seenDependencies.has(dependency)) {
      continue;
    }
    seenDependencies.add(dependency);

    const dependencyInfo = classifyFile(dependency);
    increment(indegreeCounts, dependency);
    increment(outdegreeCounts, filePath);

    if (domain !== dependencyInfo.domain) {
      increment(domainEdges, `${domain} -> ${dependencyInfo.domain}`);
    }
    if (family !== dependencyInfo.family) {
      increment(familyEdges, `${family} -> ${dependencyInfo.family}`);
    }
  }
}

console.log("# Repo Topology Report");
console.log(`Source modules: ${files.length}`);
console.log(`Non-trivial import SCCs: ${components.length}`);

printSection("Domains");
for (const [domain, count] of topEntries(domainCounts, domainCounts.size)) {
  console.log(`- ${domain}: ${count}`);
}

printSection("Cross-domain edges");
for (const [edge, count] of topEntries(domainEdges, domainEdges.size)) {
  console.log(`- ${edge}: ${count}`);
}

printSection("Largest families");
for (const [family, count] of topEntries(familyCounts, 20)) {
  console.log(`- ${family}: ${count}`);
}

printSection("Highest indegree files");
for (const [filePath, count] of topEntries(indegreeCounts, 20)) {
  console.log(`- ${relativePath(filePath)}: ${count}`);
}

printSection("Highest outdegree files");
for (const [filePath, count] of topEntries(outdegreeCounts, 20)) {
  console.log(`- ${relativePath(filePath)}: ${count}`);
}

printSection("Key family edges");
for (const [edge, count] of topEntries(familyEdges, 40)) {
  console.log(`- ${edge}: ${count}`);
}

if (components.length > 0) {
  printSection("Import SCCs");
  for (const component of components) {
    const members = component.map(relativePath).sort().join(", ");
    console.log(`- (${component.length}) ${members}`);
  }
}
