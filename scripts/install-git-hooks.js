import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function tryExecGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim()
      .replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

const repoRoot = tryExecGit(["rev-parse", "--show-toplevel"]);
if (!repoRoot) {
  process.exit(0);
}

const gitDir = path.join(repoRoot, ".git");
if (!existsSync(gitDir)) {
  process.exit(0);
}

const hooksDir = path.join(repoRoot, ".githooks");
const preCommitHook = path.join(hooksDir, "pre-commit");
if (existsSync(preCommitHook)) {
  chmodSync(preCommitHook, 0o755);
}

tryExecGit(["config", "core.hooksPath", ".githooks"]);
