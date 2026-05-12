import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { scanOrphans, type Orphan, type Skipped } from "../src/scan.js";

let root: string;
let projectsDir: string;
let existingDir: string; // a real path used to test "resolved cwd not orphan"

const NONEXISTENT = process.platform === "win32"
  ? "Z:\\definitely-not-here\\nope-XYZ"
  : "/definitely-not-here/nope-XYZ";

// A path that (a) is its own dirname (i.e., a filesystem root in path.dirname's view)
// AND (b) does not resolve on disk. On posix, "/" always resolves, so this test
// only meaningfully runs on Windows with an unused drive letter.
let rootLikeMissingPath: string | null = null;

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeFile(p: string, content: string): Promise<void> {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, content, "utf8");
}

async function makeFolder(name: string): Promise<string> {
  const folder = path.join(projectsDir, name);
  await mkdirp(folder);
  return folder;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ccr-scan-test-"));
  projectsDir = path.join(root, "projects");
  await mkdirp(projectsDir);
  existingDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccr-scan-real-"));

  // 1. sessions-index fast-path orphan
  {
    const f = await makeFolder("fast-path-orphan");
    await writeFile(
      path.join(f, "sessions-index.json"),
      JSON.stringify({ version: 1, originalPath: NONEXISTENT, entries: [] }),
    );
    await writeFile(path.join(f, "a.jsonl"), '{"cwd":"' + jsonEsc(NONEXISTENT) + '"}\n');
    await writeFile(path.join(f, "b.jsonl"), '{"cwd":"' + jsonEsc(NONEXISTENT) + '"}\n');
  }

  // 2. jsonl-cwd fallback orphan (no sessions-index)
  {
    const f = await makeFolder("jsonl-fallback-orphan");
    await writeFile(
      path.join(f, "session.jsonl"),
      '{"event":"x","cwd":"' + jsonEsc(NONEXISTENT) + '"}\n',
    );
  }

  // 3. jsonl-cwd fallback in subagents/ (no top-level jsonl)
  {
    const f = await makeFolder("subagents-only-orphan");
    await writeFile(
      path.join(f, "00000000-0000-0000-0000-000000000000", "subagents", "agent-x.jsonl"),
      '{"cwd":"' + jsonEsc(NONEXISTENT) + '"}\n',
    );
  }

  // 4. First line lacks cwd; second line has it
  {
    const f = await makeFolder("first-line-no-cwd");
    const lines = [
      '{"type":"meta"}',
      '{"event":"x","cwd":"' + jsonEsc(NONEXISTENT) + '"}',
    ].join("\n") + "\n";
    await writeFile(path.join(f, "s.jsonl"), lines);
  }

  // 5. Resolved cwd -> not an orphan
  {
    const f = await makeFolder("resolved-not-orphan");
    await writeFile(
      path.join(f, "sessions-index.json"),
      JSON.stringify({ version: 1, originalPath: existingDir, entries: [] }),
    );
    await writeFile(path.join(f, "x.jsonl"), '{"cwd":"' + jsonEsc(existingDir) + '"}\n');
  }

  // 6. Skipped: no-cwd-found
  {
    const f = await makeFolder("no-cwd-anywhere");
    await writeFile(path.join(f, "noop.jsonl"), '{"type":"meta"}\n{"another":"thing"}\n');
  }

  // 7. Skipped: malformed-sessions-index
  {
    const f = await makeFolder("malformed-index");
    await writeFile(path.join(f, "sessions-index.json"), "{not json");
    // Even if jsonl exists, malformed index wins per design.
    await writeFile(path.join(f, "s.jsonl"), '{"cwd":"' + jsonEsc(NONEXISTENT) + '"}\n');
  }

  // 8. Dotfile folder (infrastructure) ignored
  {
    const f = await makeFolder(".ccrenamer-backups");
    await writeFile(
      path.join(f, "sessions-index.json"),
      JSON.stringify({ version: 1, originalPath: NONEXISTENT, entries: [] }),
    );
    await writeFile(path.join(f, "leftover.jsonl"), '{"cwd":"' + jsonEsc(NONEXISTENT) + '"}\n');
  }

  // 9. parentExists false for root: probe for an unused Windows drive letter
  //    so the path is root-like (path.dirname(p) === p) AND doesn't resolve.
  //    On posix, "/" always exists so the orphan branch can't be exercised; we
  //    leave rootLikeMissingPath null and the corresponding test asserts the
  //    skip path explicitly.
  if (process.platform === "win32") {
    for (const letter of "QRSTUVWXYZ") {
      const candidate = `${letter}:\\`;
      try {
        await fs.stat(candidate);
        // Drive exists, try next.
      } catch {
        rootLikeMissingPath = candidate;
        break;
      }
    }
    if (rootLikeMissingPath !== null) {
      const f = await makeFolder("root-cwd-orphan");
      await writeFile(
        path.join(f, "sessions-index.json"),
        JSON.stringify({ version: 1, originalPath: rootLikeMissingPath, entries: [] }),
      );
    }
  }

  // 10. Best-effort robustness: sessions-index is a directory, not a file
  {
    const f = await makeFolder("broken-folder");
    await mkdirp(path.join(f, "sessions-index.json")); // <- a directory
    await writeFile(path.join(f, "stub.jsonl"), '{"cwd":"' + jsonEsc(NONEXISTENT) + '"}\n');
  }
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(existingDir, { recursive: true, force: true });
});

function jsonEsc(s: string): string {
  // Inline the value as it would appear inside JSON string body.
  // JSON.stringify wraps in quotes; strip them.
  return JSON.stringify(s).slice(1, -1);
}

function findOrphan(orphans: Orphan[], encodedFolder: string): Orphan {
  const o = orphans.find((x) => x.encodedFolder === encodedFolder);
  assert.ok(o, `expected orphan for ${encodedFolder}`);
  return o;
}

function findSkipped(skipped: Skipped[], encodedFolder: string): Skipped {
  const s = skipped.find((x) => x.encodedFolder === encodedFolder);
  assert.ok(s, `expected skipped entry for ${encodedFolder}`);
  return s;
}

describe("scanOrphans", () => {
  it("detects orphan via sessions-index fast path", async () => {
    const result = await scanOrphans(root);
    const o = findOrphan(result.orphans, "fast-path-orphan");
    assert.equal(o.source, "sessions-index");
    assert.equal(o.originalPath, NONEXISTENT);
    assert.equal(o.parentExists, false);
    assert.equal(o.sessionCount, 2);
    assert.ok(o.sizeBytes > 0);
  });

  it("detects orphan via jsonl-cwd fallback when sessions-index absent", async () => {
    const result = await scanOrphans(root);
    const o = findOrphan(result.orphans, "jsonl-fallback-orphan");
    assert.equal(o.source, "jsonl-cwd");
    assert.equal(o.originalPath, NONEXISTENT);
    assert.equal(o.sessionCount, 1);
  });

  it("finds cwd inside <uuid>/subagents/*.jsonl when no top-level jsonl exists", async () => {
    const result = await scanOrphans(root);
    const o = findOrphan(result.orphans, "subagents-only-orphan");
    assert.equal(o.source, "jsonl-cwd");
    assert.equal(o.originalPath, NONEXISTENT);
    assert.equal(o.sessionCount, 0); // top-level only count
    assert.ok(o.sizeBytes > 0); // recursive size includes subagents
  });

  it("skips first line that lacks cwd and reads cwd from second line", async () => {
    const result = await scanOrphans(root);
    const o = findOrphan(result.orphans, "first-line-no-cwd");
    assert.equal(o.source, "jsonl-cwd");
    assert.equal(o.originalPath, NONEXISTENT);
  });

  it("does NOT classify a folder as orphan when its claimed cwd resolves", async () => {
    const result = await scanOrphans(root);
    assert.equal(
      result.orphans.find((o) => o.encodedFolder === "resolved-not-orphan"),
      undefined,
    );
    assert.equal(
      result.skipped.find((s) => s.encodedFolder === "resolved-not-orphan"),
      undefined,
    );
  });

  it("marks folders with no cwd-bearing jsonl as skipped: no-cwd-found", async () => {
    const result = await scanOrphans(root);
    const s = findSkipped(result.skipped, "no-cwd-anywhere");
    assert.equal(s.reason, "no-cwd-found");
  });

  it("marks malformed sessions-index.json as skipped without falling back", async () => {
    const result = await scanOrphans(root);
    const s = findSkipped(result.skipped, "malformed-index");
    assert.equal(s.reason, "malformed-sessions-index");
    // And not in orphans
    assert.equal(
      result.orphans.find((o) => o.encodedFolder === "malformed-index"),
      undefined,
    );
  });

  it("ignores dotfile folders (infrastructure)", async () => {
    const result = await scanOrphans(root);
    assert.equal(
      result.orphans.find((o) => o.encodedFolder === ".ccrenamer-backups"),
      undefined,
    );
    assert.equal(
      result.skipped.find((s) => s.encodedFolder === ".ccrenamer-backups"),
      undefined,
    );
  });

  it("reports parentExists=false for root-level cwd", async (t) => {
    if (rootLikeMissingPath === null) {
      t.skip("no unused root-like path available on this platform");
      return;
    }
    const result = await scanOrphans(root);
    const o = findOrphan(result.orphans, "root-cwd-orphan");
    assert.equal(o.parentExists, false);
    assert.equal(o.originalPath, rootLikeMissingPath);
  });

  it("recovers from per-folder errors and continues scanning others", async () => {
    const result = await scanOrphans(root);
    const s = findSkipped(result.skipped, "broken-folder");
    assert.ok(s.reason.startsWith("error:"), `got: ${s.reason}`);
    // Other valid orphans still present
    assert.ok(result.orphans.find((o) => o.encodedFolder === "fast-path-orphan"));
  });
});
