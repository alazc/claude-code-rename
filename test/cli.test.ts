import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { main, type CliIO } from "../src/cli.js";
import { encodePath } from "../src/encode.js";
import {
  FAKE_CWD,
  FAKE_NEW,
  FAKE_ENCODED,
  FAKE_NEW_ENCODED,
  HOST_OS_T,
  translateFixtureToHostPaths,
} from "./helpers/fake-paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(HERE, "fixtures", "fake-project");

class CaptureStream extends Writable {
  buf = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

function makeIO(opts?: {
  isTTY?: boolean;
  stdinChunks?: string[];
}): { io: CliIO; stdout: CaptureStream; stderr: CaptureStream } {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const stdinChunks = opts?.stdinChunks ?? [];
  const stdin = Readable.from(stdinChunks) as Readable & { isTTY?: boolean };
  if (opts?.isTTY) stdin.isTTY = true;
  const io: CliIO = {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    stdin: stdin as unknown as NodeJS.ReadableStream & { isTTY?: boolean },
    isStdoutTTY: opts?.isTTY ?? false,
    isStderrTTY: opts?.isTTY ?? false,
  };
  return { io, stdout, stderr };
}

async function mkTmp(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), `ccr-cli-${prefix}-`));
}

interface FakeRoot {
  root: string;
  projectsDir: string;
  oldFolder: string;
  newFolder: string;
}

async function setupFakeRoot(prefix: string): Promise<FakeRoot> {
  const root = await mkTmp(prefix);
  const projectsDir = path.join(root, "projects");
  const oldFolder = path.join(projectsDir, FAKE_ENCODED);
  const newFolder = path.join(projectsDir, FAKE_NEW_ENCODED);
  await fsp.mkdir(projectsDir, { recursive: true });
  await fsp.cp(FIXTURE_SRC, oldFolder, { recursive: true });
  await translateFixtureToHostPaths(oldFolder);
  return { root, projectsDir, oldFolder, newFolder };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("cli: argument parsing & help", () => {
  it("--help prints usage and exits 0", async () => {
    const { io, stdout } = makeIO();
    const code = await main(["--help"], io);
    assert.equal(code, 0);
    assert.match(stdout.buf, /Usage:/);
    assert.match(stdout.buf, /--apply/);
  });

  it("--version prints version and exits 0", async () => {
    const { io, stdout } = makeIO();
    const code = await main(["--version"], io);
    assert.equal(code, 0);
    assert.match(stdout.buf.trim(), /^\d+\.\d+\.\d+/);
  });
});

describe("cli: pre-flight gates", () => {
  let fake: FakeRoot;
  beforeEach(async () => {
    fake = await setupFakeRoot("preflight");
  });

  it("empty --old → exit 1", async () => {
    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", "  ", "--new", FAKE_NEW, "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 1);
    assert.match(stderr.buf, /must be non-empty/);
  });

  it("empty --new → exit 1", async () => {
    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", "", "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 1);
    assert.match(stderr.buf, /must be non-empty/);
  });

  it("--old equal to --new → exit 1", async () => {
    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_CWD, "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 1);
    assert.match(stderr.buf, /identical/);
  });

  it("OLD encoded folder missing → exit 4", async () => {
    const empty = await mkTmp("empty");
    await fsp.mkdir(path.join(empty, "projects"), { recursive: true });
    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_NEW, "--data-dir", empty],
      io,
    );
    assert.equal(code, 4);
    assert.match(stderr.buf, /OLD project not found/);
  });

  it("encoder sanity mismatch → exit 4", async () => {
    // Set up: folder name encodes from oldPath, but the jsonl cwd inside
    // encodes to something different — simulating CC schema drift.
    // Use platform-absolute paths so path.resolve in cli.ts leaves them alone.
    const root = await mkTmp("encmis");
    const projectsDir = path.join(root, "projects");
    const oldPath = HOST_OS_T === "windows" ? "C:\\foo" : "/foo";
    const wrongCwd = HOST_OS_T === "windows" ? "C:\\bar" : "/bar";
    const newPath = HOST_OS_T === "windows" ? "C:\\baz" : "/baz";
    const folderName = encodePath(oldPath, HOST_OS_T);
    const wrongFolder = path.join(projectsDir, folderName);
    await fsp.mkdir(wrongFolder, { recursive: true });
    // jsonl cwd encodes to a different name → encoder-sanity gate fires.
    await fsp.writeFile(
      path.join(wrongFolder, "a.jsonl"),
      JSON.stringify({ event: "session-start", cwd: wrongCwd }) + "\n",
    );
    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", oldPath, "--new", newPath, "--data-dir", root],
      io,
    );
    assert.equal(code, 4);
    assert.match(stderr.buf, /encoder mismatch/);
  });

  it("OLD literal not in jsonl → exit 4", async () => {
    // Choose an OLD path that encodes to the same folder name as the fixture
    // but does NOT appear as a literal anywhere in the transcripts.
    // encodePath collapses every `:_/\ ` to `-`, so a path with dashes
    // separating tokens encodes identically to the corresponding path with
    // path-separators. Neither appears in the translated fixture content.
    const oldPathAlt =
      HOST_OS_T === "windows" ? "C:\\fake-project-path" : "/fake-project-path";
    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", oldPathAlt, "--new", FAKE_NEW, "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 4);
    assert.match(stderr.buf, /OLD_PATH literal not found/);
  });

  it("merge mode: NEW folder with existing non-empty content → fork (no refusal, no deletion)", async () => {
    // Destination has a real jsonl with an event line bearing the NEW cwd —
    // mirrors the post-copy-paste case where CC fresh-started in NEW.
    await fsp.mkdir(fake.newFolder, { recursive: true });
    const occupant = path.join(fake.newFolder, "existing.jsonl");
    await fsp.writeFile(
      occupant,
      `{"type":"meta"}\n${JSON.stringify({ event: "fresh", cwd: FAKE_NEW })}\n`,
    );

    const { io, stderr, stdout } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_NEW, "--apply", "--yes", "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr.buf}`);
    // Source kept intact
    assert.ok(await pathExists(fake.oldFolder), "source folder must survive merge");
    // Destination still has its original file
    assert.ok(await pathExists(occupant), "destination's pre-existing jsonl must survive merge");
    // Source jsonls now copied to destination
    const migrated = path.join(
      fake.newFolder,
      "00000000-0000-0000-0000-000000000001.jsonl",
    );
    assert.ok(await pathExists(migrated), "source jsonl must be copied to destination");
    // Success summary reports merge semantics
    assert.match(stdout.buf, /Merged \d+ file\(s\) from .* into /);
    assert.match(stdout.buf, /Source folder .* left intact/);
  });

  it("merge mode: NEW folder is empty dir → dry-run shows MERGE mode, --apply succeeds without deletion", async () => {
    await fsp.mkdir(fake.newFolder, { recursive: true });
    // Dry-run first
    {
      const { io, stderr } = makeIO();
      const code = await main(
        ["--old", FAKE_CWD, "--new", FAKE_NEW, "--data-dir", fake.root],
        io,
      );
      assert.equal(code, 0);
      assert.match(stderr.buf, /MERGE mode: destination .* already exists/);
      assert.match(stderr.buf, /Source folder .* will be kept intact/);
    }
    // Apply
    {
      const { io } = makeIO();
      const code = await main(
        ["--old", FAKE_CWD, "--new", FAKE_NEW, "--apply", "--yes", "--data-dir", fake.root],
        io,
      );
      assert.equal(code, 0);
      assert.ok(await pathExists(fake.newFolder), "destination folder should exist");
      assert.ok(await pathExists(fake.oldFolder), "source folder should be kept intact");
    }
  });

  it("merge mode: sessions-index entries are concatenated (destination's + source's)", async () => {
    // Both folders have sessions-index.json. Concatenation produces M+N entries.
    await fsp.mkdir(fake.newFolder, { recursive: true });
    const destIndex = {
      version: 1,
      originalPath: FAKE_NEW,
      entries: [
        {
          sessionId: "DEST-A",
          fullPath: `C:\\\\fake\\\\encoded-projects\\\\C--fake-new-path\\\\DEST-A.jsonl`,
          projectPath: FAKE_NEW,
        },
      ],
    };
    await fsp.writeFile(
      path.join(fake.newFolder, "sessions-index.json"),
      JSON.stringify(destIndex, null, 2),
    );

    const { io } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_NEW, "--apply", "--yes", "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 0);
    const mergedRaw = await fsp.readFile(
      path.join(fake.newFolder, "sessions-index.json"),
      "utf8",
    );
    const merged = JSON.parse(mergedRaw) as {
      originalPath: string;
      entries: Array<{ sessionId?: string; projectPath?: string }>;
    };
    assert.equal(merged.originalPath, FAKE_NEW);
    // Fixture's sessions-index has 3 entries; destination contributed 1; total 4.
    assert.equal(merged.entries.length, 4);
    // First entry preserves destination's pre-existing session
    assert.equal(merged.entries[0]!.sessionId, "DEST-A");
    // Subsequent entries are the migrated ones, with paths rewritten to NEW
    assert.equal(merged.entries[1]!.projectPath, FAKE_NEW);
  });

  it("merge mode: UUID collision in destination → exit 4", async () => {
    // Plant a file at the same destination path one of source's jsonls would land at.
    await fsp.mkdir(fake.newFolder, { recursive: true });
    const collision = path.join(
      fake.newFolder,
      "00000000-0000-0000-0000-000000000001.jsonl",
    );
    await fsp.writeFile(collision, '{"event":"colliding"}\n');

    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_NEW, "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 4);
    assert.match(stderr.buf, /destination already has file with same relative path/);
  });
});

describe("cli: OLD substring of NEW", () => {
  let fake: FakeRoot;
  beforeEach(async () => {
    fake = await setupFakeRoot("substr");
  });

  it("dry-run preview includes the warning text", async () => {
    // Make NEW contain OLD as substring: NEW = OLD + "-extra"
    const newPath = FAKE_CWD + "-extra";
    const { io, stderr } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", newPath, "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 0);
    assert.match(stderr.buf, /OLD is a substring of NEW/);
  });

  it("--apply on non-TTY without --yes → exit 1", async () => {
    const newPath = FAKE_CWD + "-extra";
    const { io, stderr } = makeIO({ isTTY: false });
    const code = await main(
      ["--old", FAKE_CWD, "--new", newPath, "--apply", "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 1);
    // Could be substring-of-NEW message OR non-interactive msg — both are exit 1.
    assert.match(stderr.buf, /substring|non-interactive/);
  });
});

describe("cli: TTY confirmation", () => {
  let fake: FakeRoot;
  beforeEach(async () => {
    fake = await setupFakeRoot("tty");
  });

  it("--apply non-TTY without --yes → exit 1", async () => {
    const { io, stderr } = makeIO({ isTTY: false });
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_NEW, "--apply", "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 1);
    assert.match(stderr.buf, /requires --yes/);
    // Old folder still present (no rename happened).
    assert.ok(await pathExists(fake.oldFolder));
  });
});

describe("cli: stream separation", () => {
  let fake: FakeRoot;
  beforeEach(async () => {
    fake = await setupFakeRoot("streams");
  });

  it("dry-run preview goes to stderr, summary goes to stdout", async () => {
    const { io, stdout, stderr } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_NEW, "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 0);
    assert.match(stderr.buf, /\[dry-run\]/);
    assert.match(stdout.buf, /Dry-run complete/);
    assert.doesNotMatch(stdout.buf, /\[dry-run\]/);
  });
});

describe("cli: --scan", () => {
  it("--scan never writes (no folder rename, no jsonl mutation)", async () => {
    const fake = await setupFakeRoot("scanflag");
    // Snapshot the file contents
    const beforeSnap = await snapshot(fake.oldFolder);
    const { io, stdout } = makeIO();
    const code = await main(["--scan", "--data-dir", fake.root], io);
    assert.equal(code, 0);
    // We don't assert orphan presence here (depends on whether C:\fake\project\path
    // exists on the test machine — it shouldn't, but be lenient). What we
    // assert: no writes happened.
    const afterSnap = await snapshot(fake.oldFolder);
    assert.deepEqual(afterSnap, beforeSnap, "scan must not modify files");
    // Folder still has its original name.
    assert.ok(await pathExists(fake.oldFolder));
    // Smoke-check stdout has either orphan info or "No orphaned" message.
    assert.ok(stdout.buf.length > 0);
  });
});

async function snapshot(folder: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(d: string): Promise<void> {
    const entries = await fsp.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.set(path.relative(folder, full), await fsp.readFile(full, "utf8"));
    }
  }
  await walk(folder);
  return out;
}

describe("cli: end-to-end --apply on fixture", () => {
  it("rewrites jsonl + sessions-index, renames folder, deletes manifest", async () => {
    const fake = await setupFakeRoot("e2e");
    const { io } = makeIO();
    const code = await main(
      ["--old", FAKE_CWD, "--new", FAKE_NEW, "--apply", "--yes", "--data-dir", fake.root],
      io,
    );
    assert.equal(code, 0);
    assert.ok(!(await pathExists(fake.oldFolder)), "old folder removed");
    assert.ok(await pathExists(fake.newFolder), "new folder present");

    // Top-level jsonl rewritten
    const j1 = await fsp.readFile(
      path.join(fake.newFolder, "00000000-0000-0000-0000-000000000001.jsonl"),
      "utf8",
    );
    assert.ok(j1.includes(JSON.stringify(FAKE_NEW).slice(1, -1)));
    assert.ok(!j1.includes(JSON.stringify(FAKE_CWD).slice(1, -1)));

    // Subagent jsonl rewritten
    const sub = await fsp.readFile(
      path.join(
        fake.newFolder,
        "00000000-0000-0000-0000-000000000003",
        "subagents",
        "agent-deadbeef.jsonl",
      ),
      "utf8",
    );
    assert.ok(sub.includes(JSON.stringify(FAKE_NEW).slice(1, -1)));

    // sessions-index rewritten
    const idxRaw = await fsp.readFile(
      path.join(fake.newFolder, "sessions-index.json"),
      "utf8",
    );
    const idx = JSON.parse(idxRaw) as {
      originalPath: string;
      entries: Array<{ projectPath: string; fullPath: string }>;
    };
    assert.equal(idx.originalPath, FAKE_NEW);
    for (const e of idx.entries) {
      assert.equal(e.projectPath, FAKE_NEW);
      assert.ok(e.fullPath.includes(FAKE_NEW_ENCODED));
      assert.ok(!e.fullPath.includes(FAKE_ENCODED));
    }

    // Manifest deleted
    assert.ok(!(await pathExists(path.join(fake.newFolder, ".ccrenamer-progress.json"))));
  });
});

describe("cli: manifest resume after crash", () => {
  it("crash mid-flight then resume produces same final state", async () => {
    // Run 1: full success → capture target snapshot
    const target = await setupFakeRoot("resume-target");
    {
      const { io } = makeIO();
      const code = await main(
        [
          "--old",
          FAKE_CWD,
          "--new",
          FAKE_NEW,
          "--apply",
          "--yes",
          "--data-dir",
          target.root,
        ],
        io,
      );
      assert.equal(code, 0);
    }
    const goldSnap = await snapshot(target.newFolder);

    // Run 2: crash mid-flight at one of the jsonl files via __ccr_test_fail_at
    const work = await setupFakeRoot("resume-work");
    const failTarget = path.join(
      work.oldFolder,
      "00000000-0000-0000-0000-000000000002.jsonl",
    );
    process.env["__ccr_test_fail_at"] = `before-rename:${failTarget}`;
    let firstCode = 0;
    try {
      const { io } = makeIO();
      firstCode = await main(
        [
          "--old",
          FAKE_CWD,
          "--new",
          FAKE_NEW,
          "--apply",
          "--yes",
          "--data-dir",
          work.root,
        ],
        io,
      );
    } finally {
      delete process.env["__ccr_test_fail_at"];
    }
    assert.equal(firstCode, 3, "expected internal error on injected failure");
    // Manifest should still exist (rename never happened).
    assert.ok(await pathExists(path.join(work.oldFolder, ".ccrenamer-progress.json")));

    // Run 3: re-run --apply, should resume and complete.
    {
      const { io } = makeIO();
      const code = await main(
        [
          "--old",
          FAKE_CWD,
          "--new",
          FAKE_NEW,
          "--apply",
          "--yes",
          "--data-dir",
          work.root,
        ],
        io,
      );
      assert.equal(code, 0);
    }
    const resumedSnap = await snapshot(work.newFolder);
    // Both runs should leave the same content.
    assert.deepEqual(
      [...resumedSnap.keys()].sort(),
      [...goldSnap.keys()].sort(),
      "same set of files",
    );
    for (const [k, v] of goldSnap) {
      assert.equal(resumedSnap.get(k), v, `content mismatch for ${k}`);
    }
  });
});
