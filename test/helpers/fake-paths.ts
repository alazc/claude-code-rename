// Platform-aware fake paths used by test/cli.test.ts and
// test/e2e/crash-resume.test.ts.
//
// The committed fake-project fixture has Windows-shape paths baked into every
// jsonl and sessions-index.json (`C:\fake\project\path`). On POSIX, those
// strings aren't absolute, so `path.resolve` in cli.ts prepends the cwd, the
// encoded folder name becomes a long mess, and gate 3 (OLD folder exists)
// fires before any of the gates the tests actually want to exercise.
//
// The fix is two-piece:
//   1. Export `FAKE_CWD` / `FAKE_NEW` as platform-absolute strings —
//      Windows-shaped on Windows, POSIX-shaped on POSIX. Both forms survive
//      `path.resolve` untouched.
//   2. Export `translateFixtureToHostPaths(folder)` which rewrites the
//      committed Windows-shape paths inside a freshly-copied fixture to the
//      runtime `FAKE_CWD` form. No-op on Windows. Uses the project's own
//      rewriter on its own fixture — a tiny dogfood as a side effect.
import { promises as fsp } from "node:fs";
import * as path from "node:path";

import { encodePath, type HostOS } from "../../src/encode.js";
import { rewriteJsonl, rewriteSessionsIndex } from "../../src/rewrite.js";

export const HOST_OS_T: HostOS = process.platform === "win32" ? "windows" : "posix";

const FIXTURE_OLD_CWD_RAW = "C:\\fake\\project\\path";
const FIXTURE_OLD_ENCODED_RAW = "C--fake-project-path";

export const FAKE_CWD =
  HOST_OS_T === "windows" ? "C:\\fake\\project\\path" : "/fake/project/path";
export const FAKE_NEW =
  HOST_OS_T === "windows" ? "C:\\fake\\new-path" : "/fake/new-path";
export const FAKE_ENCODED = encodePath(FAKE_CWD, HOST_OS_T);
export const FAKE_NEW_ENCODED = encodePath(FAKE_NEW, HOST_OS_T);

/**
 * Translate the committed Windows-shape fixture inside `folder` to the
 * platform-appropriate FAKE_CWD form. No-op on Windows.
 */
export async function translateFixtureToHostPaths(folder: string): Promise<void> {
  if (FIXTURE_OLD_CWD_RAW === FAKE_CWD) return;

  await translateDir(folder);

  const idxPath = path.join(folder, "sessions-index.json");
  try {
    const content = await fsp.readFile(idxPath, "utf8");
    const result = rewriteSessionsIndex(
      content,
      FIXTURE_OLD_CWD_RAW,
      FAKE_CWD,
      FIXTURE_OLD_ENCODED_RAW,
      FAKE_ENCODED,
    );
    await fsp.writeFile(idxPath, result.content);
  } catch {
    // sessions-index absent or malformed; the rewriter would throw on a
    // schema mismatch but in test setup the fixture is well-formed by
    // construction. Swallow only the missing-file case in practice.
  }
}

async function translateDir(folder: string): Promise<void> {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(folder, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      const content = await fsp.readFile(full, "utf8");
      const { newContent } = rewriteJsonl(content, FIXTURE_OLD_CWD_RAW, FAKE_CWD);
      await fsp.writeFile(full, newContent);
    } else if (e.isDirectory()) {
      await translateDir(full);
    }
  }
}
