// Filesystem IO primitives for ccRenamer.
//
// All writes go through atomicWrite (tmp + rename in same dir) so a crash
// mid-write never leaves a half-written file. Backups land per amendment A3
// in <projectsDir>/.ccrenamer-backups/<encodedFolder>-<UTCTS>/. The walker
// is deliberately lenient — unreadable subtrees are skipped rather than
// surfaced — because the caller is doing a best-effort scan.

import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const TEST_FAIL_ENV = "__ccr_test_fail_at";
const TEST_FAIL_MSG = "__ccr_test_fail";

type FailStage = "before-tmp-write" | "after-tmp-write" | "before-rename";

function checkFailSeam(stage: FailStage, filePath: string): void {
  const trigger = process.env[TEST_FAIL_ENV];
  if (trigger && trigger === `${stage}:${filePath}`) {
    throw new Error(TEST_FAIL_MSG);
  }
}

/**
 * Atomically write `content` to `filePath`. Writes to a sibling
 * `${filePath}.${rand}.tmp`, then renames into place — same-directory rename
 * is the only flavor that's atomic on Windows (NTFS MoveFileEx without
 * MOVEFILE_COPY_ALLOWED). Any failure unlinks the tmp file before rethrowing.
 *
 * Test seam: set `process.env.__ccr_test_fail_at = "${stage}:${filePath}"` to
 * force a synthetic failure at one of `before-tmp-write`, `after-tmp-write`,
 * or `before-rename`. Used by lane F crash-resume tests.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const rand = randomBytes(8).toString("hex");
  const tmp = `${filePath}.${rand}.tmp`;
  try {
    checkFailSeam("before-tmp-write", filePath);
    await fs.writeFile(tmp, content);
    checkFailSeam("after-tmp-write", filePath);
    checkFailSeam("before-rename", filePath);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Recursively copy `folder` into a timestamped sibling backup directory per
 * amendment A3:
 *   <parent(folder)>/.ccrenamer-backups/<basename(folder)>-<UTC YYYYMMDD-HHMMSS>/
 * Returns the absolute backup path. Creates the `.ccrenamer-backups/` parent
 * if absent.
 */
export async function backupProjectFolder(folder: string): Promise<string> {
  const projectsDir = path.dirname(folder);
  const encodedFolder = path.basename(folder);
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ts =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const backupsParent = path.join(projectsDir, ".ccrenamer-backups");
  const dest = path.join(backupsParent, `${encodedFolder}-${ts}`);
  await fs.mkdir(backupsParent, { recursive: true });
  await fs.cp(folder, dest, { recursive: true });
  return dest;
}

const SKIP_FILE_NAMES = new Set([".ccrenamer-progress.json"]);

function qualifiesAsJsonl(name: string): boolean {
  if (SKIP_FILE_NAMES.has(name)) return false;
  if (name.endsWith(".tmp")) return false;
  if (!name.endsWith(".jsonl")) return false;
  return true;
}

async function* walkJsonlImpl(
  dir: string,
  visited: Set<string>,
): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      yield* walkJsonlImpl(full, visited);
      continue;
    }
    if (entry.isFile()) {
      if (!qualifiesAsJsonl(name)) continue;
      yield full;
      continue;
    }
    // Anything that isn't a plain file or directory (most commonly a
    // symlink) — resolve via stat and branch on the resolved type. stat
    // follows symlinks; broken links throw ENOENT and we treat them as
    // skip-silently, matching the rest of the walker's leniency.
    let resolved: Awaited<ReturnType<typeof fs.stat>>;
    try {
      resolved = await fs.stat(full);
    } catch {
      continue;
    }
    if (resolved.isDirectory()) {
      const key = `${resolved.dev}:${resolved.ino}`;
      if (visited.has(key)) continue;
      visited.add(key);
      yield* walkJsonlImpl(full, visited);
      continue;
    }
    if (resolved.isFile()) {
      if (!qualifiesAsJsonl(name)) continue;
      // Yield the symlink path (under the caller's root), not the resolved
      // target — callers operate on paths under ~/.claude/projects/.
      yield full;
      continue;
    }
    // Socket, FIFO, block/char device, etc. — skip silently.
  }
}

/**
 * Recursively yield every `*.jsonl` file under `folder` (top-level and under
 * `<uuid>/subagents/`). Skips dotfiles, dot-directories, `*.tmp`,
 * `.ccrenamer-progress.json`, and any non-`.jsonl` file. Best-effort:
 * unreadable subdirectories are silently skipped rather than thrown.
 *
 * Follows symlinks (both file and directory). A visited-inode set
 * (`${dev}:${ino}`) prevents infinite loops on cyclic directory symlinks;
 * each resolved directory is walked at most once. Yielded paths are the
 * link paths under `folder`, never the resolved targets.
 */
export async function* walkJsonl(folder: string): AsyncGenerator<string> {
  yield* walkJsonlImpl(folder, new Set<string>());
}

/**
 * Rename `from` to `to` via a sibling temp name. Required on case-insensitive
 * filesystems (Windows always; default APFS) when `from` and `to` differ only
 * in case — a direct rename is a no-op there. Both renames are intra-directory
 * so each step stays atomic. Safe (just slightly redundant) on case-sensitive
 * filesystems.
 */
export async function caseOnlyRename(from: string, to: string): Promise<void> {
  const rand = randomBytes(8).toString("hex");
  const tmp = `${to}.ccr-case-tmp-${rand}`;
  await fs.rename(from, tmp);
  try {
    await fs.rename(tmp, to);
  } catch (err) {
    // Best effort: try to put it back so we don't leave the user with a
    // missing source AND no destination.
    await fs.rename(tmp, from).catch(() => {});
    throw err;
  }
}

const caseSensitivityCache = new Map<string, boolean>();

/**
 * Probe whether the filesystem at `path` (an existing directory) is
 * case-insensitive. Writes a short-lived probe file with a lowercase name
 * and stats it under an uppercase variant; if the stat resolves, the FS is
 * case-insensitive. Result is cached per-`path` for the process lifetime.
 */
export async function isCaseInsensitiveFS(probeDir: string): Promise<boolean> {
  const cached = caseSensitivityCache.get(probeDir);
  if (cached !== undefined) return cached;

  const rand = randomBytes(8).toString("hex");
  const lowerName = `__ccr_case_probe_${rand}.txt`;
  const upperName = lowerName.toUpperCase();
  const lowerPath = path.join(probeDir, lowerName);
  const upperPath = path.join(probeDir, upperName);

  let result = false;
  try {
    await fs.writeFile(lowerPath, "");
    try {
      await fs.stat(upperPath);
      result = true;
    } catch {
      result = false;
    }
  } finally {
    await fs.unlink(lowerPath).catch(() => {});
  }
  caseSensitivityCache.set(probeDir, result);
  return result;
}
