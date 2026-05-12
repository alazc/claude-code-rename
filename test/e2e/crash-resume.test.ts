// T1 fault-injection crash-resume suite.
//
// Iron rule: for each scenario, a crash-then-resume run produces a final state
// that is byte-identical to a single clean baseline run. Crashes are simulated
// via the atomicWrite seam in src/fs.ts (env var `__ccr_test_fail_at`).
//
// Scenario 4 cannot use the seam to crash directly (the folder rename is a bare
// fs.rename with no atomicWrite around it). Instead, we hand-stage the
// post-index-rewrite manifest state and verify the rename-only resume path.
// Documented in the report.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { main, type CliIO } from "../../src/cli.js";
import { rewriteJsonl, rewriteSessionsIndex } from "../../src/rewrite.js";
import { encodePath } from "../../src/encode.js";
import {
  FAKE_CWD,
  FAKE_ENCODED,
  HOST_OS_T,
  translateFixtureToHostPaths,
} from "../helpers/fake-paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.resolve(HERE, "..", "fixtures", "fake-project");

// Crash-resume uses a NEW path different from the cli-test FAKE_NEW so the two
// suites don't trip each other if a fixture leak happens. Same platform shape.
const OLD_PATH = FAKE_CWD;
const NEW_PATH = HOST_OS_T === "windows" ? "C:\\new\\fake\\path" : "/new/fake/path";
const OLD_ENCODED = FAKE_ENCODED;
const NEW_ENCODED = encodePath(NEW_PATH, HOST_OS_T);
const MANIFEST_NAME = ".ccrenamer-progress.json";
const SESSIONS_INDEX = "sessions-index.json";

// ---------- IO helpers ----------

class CaptureStream extends Writable {
  buf = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

function makeNonTtyIO(): { io: CliIO; stdout: CaptureStream; stderr: CaptureStream } {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const stdin = Readable.from([]) as Readable & { isTTY?: boolean };
  const io: CliIO = {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    stdin: stdin as unknown as NodeJS.ReadableStream & { isTTY?: boolean },
    isStdoutTTY: false,
    isStderrTTY: false,
  };
  return { io, stdout, stderr };
}

// ---------- temp / fixture setup ----------

interface TmpProjects {
  root: string;
  dataDir: string; // == root in the current --data-dir contract (parent of projects/)
  projectsDir: string;
  oldFolder: string;
  newFolder: string;
}

async function setupTempProjectsDir(prefix: string): Promise<TmpProjects> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ccr-crashresume-${prefix}-`));
  const projectsDir = path.join(root, "projects");
  const oldFolder = path.join(projectsDir, OLD_ENCODED);
  const newFolder = path.join(projectsDir, NEW_ENCODED);
  await fsp.mkdir(projectsDir, { recursive: true });
  await fsp.cp(FIXTURE_SRC, oldFolder, { recursive: true });
  await translateFixtureToHostPaths(oldFolder);
  return { root, dataDir: root, projectsDir, oldFolder, newFolder };
}

// ---------- final-state listing & comparison ----------

interface FinalState {
  // Sorted relative paths under the projects dir.
  files: string[];
  // Map from relative path → raw bytes.
  bytes: Map<string, Buffer>;
}

async function listFinalState(projectsDir: string): Promise<FinalState> {
  const bytes = new Map<string, Buffer>();
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const rel = path.relative(projectsDir, full);
        bytes.set(rel, await fsp.readFile(full));
      }
    }
  }
  await walk(projectsDir);
  const files = [...bytes.keys()].sort();
  return { files, bytes };
}

function assertByteIdenticalToBaseline(actual: FinalState, baseline: FinalState, label: string): void {
  // 1. Same set of relative file paths (sorted).
  assert.deepStrictEqual(
    actual.files,
    baseline.files,
    `${label}: file set differs.\n actual: ${JSON.stringify(actual.files)}\n baseline: ${JSON.stringify(baseline.files)}`,
  );
  // 2. For each path, same byte content.
  for (const rel of baseline.files) {
    const a = actual.bytes.get(rel)!;
    const b = baseline.bytes.get(rel)!;
    assert.ok(a.equals(b), `${label}: bytes differ at ${rel} (actual ${a.length}B vs baseline ${b.length}B)`);
  }
}

// ---------- seam helper ----------

async function runWithInjection(args: string[], failAt: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const prev = process.env["__ccr_test_fail_at"];
  process.env["__ccr_test_fail_at"] = failAt;
  const { io, stdout, stderr } = makeNonTtyIO();
  try {
    const code = await main(args, io);
    return { code, stdout: stdout.buf, stderr: stderr.buf };
  } finally {
    if (prev === undefined) delete process.env["__ccr_test_fail_at"];
    else process.env["__ccr_test_fail_at"] = prev;
  }
}

async function runClean(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = makeNonTtyIO();
  const code = await main(args, io);
  return { code, stdout: stdout.buf, stderr: stderr.buf };
}

function applyArgs(dataDir: string): string[] {
  return ["--old", OLD_PATH, "--new", NEW_PATH, "--apply", "--yes", "--data-dir", dataDir];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- suite ----------

describe("T1 crash-resume", () => {
  let baselineState: FinalState;
  let baselineRoot: string;

  before(async () => {
    const tmp = await setupTempProjectsDir("baseline");
    baselineRoot = tmp.root;
    const { code, stderr } = await runClean(applyArgs(tmp.dataDir));
    assert.strictEqual(code, 0, `baseline must succeed (stderr=${stderr})`);
    baselineState = await listFinalState(tmp.projectsDir);
    // Baseline sanity: NEW folder exists, OLD does not, no manifest.
    assert.ok(baselineState.files.length > 0, "baseline must have files");
    assert.ok(
      baselineState.files.every((f) => f.startsWith(NEW_ENCODED + path.sep) || f.startsWith(NEW_ENCODED + "/")),
      "all baseline files should live under the NEW-encoded folder",
    );
    assert.ok(
      !baselineState.files.some((f) => f.endsWith(MANIFEST_NAME)),
      "baseline should not leave a manifest behind",
    );
  });

  after(async () => {
    if (baselineRoot) await fsp.rm(baselineRoot, { recursive: true, force: true });
  });

  it("scenario 1: crash before manifest write (clean re-run)", async () => {
    const tmp = await setupTempProjectsDir("s1");
    try {
      const manifestPath = path.join(tmp.oldFolder, MANIFEST_NAME);
      // The very first atomicWrite of the apply sequence is the initial
      // manifest creation. before-tmp-write fires before any bytes hit disk.
      const failAt = `before-tmp-write:${manifestPath}`;
      const crash = await runWithInjection(applyArgs(tmp.dataDir), failAt);
      assert.notStrictEqual(crash.code, 0, "expected crash (non-zero exit)");
      // No manifest written, no jsonl mutated, no rename happened.
      assert.ok(!(await pathExists(manifestPath)), "manifest should not exist after crash before its first write");
      assert.ok(await pathExists(tmp.oldFolder), "OLD folder should still exist after crash");
      assert.ok(!(await pathExists(tmp.newFolder)), "NEW folder should not exist after crash");

      // Resume: clean re-run from scratch.
      const resume = await runClean(applyArgs(tmp.dataDir));
      assert.strictEqual(resume.code, 0, `resume must succeed (stderr=${resume.stderr})`);

      const actual = await listFinalState(tmp.projectsDir);
      assertByteIdenticalToBaseline(actual, baselineState, "scenario 1");
    } finally {
      await fsp.rm(tmp.root, { recursive: true, force: true });
    }
  });

  it("scenario 2: crash between file rewrites (resume skips completed)", async () => {
    const tmp = await setupTempProjectsDir("s2");
    try {
      // intendedFiles are sorted alphabetically. The fixture's top-level files
      // are ...001.jsonl and ...002.jsonl, with the subagent file deeper. The
      // SECOND in sort order is ...002.jsonl.
      const secondJsonl = path.join(
        tmp.oldFolder,
        "00000000-0000-0000-0000-000000000002.jsonl",
      );
      const failAt = `before-rename:${secondJsonl}`;
      const crash = await runWithInjection(applyArgs(tmp.dataDir), failAt);
      assert.strictEqual(crash.code, 3, "expected internal-error exit on injected failure");

      // Manifest should still exist (rename never reached) with the first file
      // recorded as completed.
      const manifestPath = path.join(tmp.oldFolder, MANIFEST_NAME);
      assert.ok(await pathExists(manifestPath), "manifest survives crash");
      const m = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as {
        completedFiles: string[];
        indexRewritten: boolean;
      };
      assert.ok(
        m.completedFiles.length >= 1,
        `expected at least 1 completed file in manifest, got ${m.completedFiles.length}`,
      );
      assert.strictEqual(m.indexRewritten, false, "index should not yet be rewritten");

      // Resume.
      const resume = await runClean(applyArgs(tmp.dataDir));
      assert.strictEqual(resume.code, 0, `resume must succeed (stderr=${resume.stderr})`);

      const actual = await listFinalState(tmp.projectsDir);
      assertByteIdenticalToBaseline(actual, baselineState, "scenario 2");
    } finally {
      await fsp.rm(tmp.root, { recursive: true, force: true });
    }
  });

  it("scenario 3: crash mid index-rewrite (resume re-rewrites index)", async () => {
    const tmp = await setupTempProjectsDir("s3");
    try {
      const indexPath = path.join(tmp.oldFolder, SESSIONS_INDEX);
      const failAt = `before-rename:${indexPath}`;
      const crash = await runWithInjection(applyArgs(tmp.dataDir), failAt);
      assert.strictEqual(crash.code, 3, "expected internal-error exit on injected failure");

      // All jsonls done, manifest says indexRewritten=false (we crashed before
      // the manifest update that would set it to true).
      const manifestPath = path.join(tmp.oldFolder, MANIFEST_NAME);
      assert.ok(await pathExists(manifestPath), "manifest survives crash");
      const m = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as {
        intendedFiles: string[];
        completedFiles: string[];
        indexRewritten: boolean;
      };
      assert.strictEqual(
        m.completedFiles.length,
        m.intendedFiles.length,
        "all jsonls should be completed before the index step",
      );
      assert.strictEqual(m.indexRewritten, false, "index rewrite not yet recorded");
      // Index file on disk should still be the original (rename never happened).
      const indexBytes = await fsp.readFile(indexPath, "utf8");
      assert.ok(indexBytes.includes(OLD_PATH.replace(/\\/g, "\\\\")), "index still contains OLD path");

      const resume = await runClean(applyArgs(tmp.dataDir));
      assert.strictEqual(resume.code, 0, `resume must succeed (stderr=${resume.stderr})`);

      const actual = await listFinalState(tmp.projectsDir);
      assertByteIdenticalToBaseline(actual, baselineState, "scenario 3");
    } finally {
      await fsp.rm(tmp.root, { recursive: true, force: true });
    }
  });

  it("scenario 4: rename-pending-only resume (seam can't reach the bare fs.rename)", async () => {
    // SUBSTITUTION NOTE: the folder rename is a bare fs.rename with no
    // atomicWrite around it, so the __ccr_test_fail_at seam cannot fire
    // between "index rewritten + manifest updated" and "rename". Instead, we
    // hand-stage the post-index manifest state (all jsonls + index already
    // rewritten on disk, manifest says indexRewritten=true,
    // folderRenamed=false) and assert the resume run executes the
    // rename-only path and ends byte-identical to baseline.
    const tmp = await setupTempProjectsDir("s4");
    try {
      // Pre-rewrite every jsonl in place using the production rewriter.
      async function walk(d: string, out: string[]): Promise<void> {
        const entries = await fsp.readdir(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) await walk(full, out);
          else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
        }
      }
      const jsonls: string[] = [];
      await walk(tmp.oldFolder, jsonls);
      jsonls.sort();
      for (const f of jsonls) {
        const raw = await fsp.readFile(f, "utf8");
        const { newContent } = rewriteJsonl(raw, OLD_PATH, NEW_PATH);
        await fsp.writeFile(f, newContent);
      }
      // Pre-rewrite sessions-index.json.
      const indexPath = path.join(tmp.oldFolder, SESSIONS_INDEX);
      const idxRaw = await fsp.readFile(indexPath, "utf8");
      const idxResult = rewriteSessionsIndex(idxRaw, OLD_PATH, NEW_PATH, OLD_ENCODED, NEW_ENCODED);
      await fsp.writeFile(indexPath, idxResult.content);

      // Stage the manifest as if everything except the rename completed.
      const manifestPath = path.join(tmp.oldFolder, MANIFEST_NAME);
      const stagedManifest = {
        oldPath: OLD_PATH,
        newPath: NEW_PATH,
        intendedFiles: jsonls,
        completedFiles: jsonls,
        indexRewritten: true,
        folderRenamed: false,
      };
      await fsp.writeFile(manifestPath, JSON.stringify(stagedManifest, null, 2));

      // Resume — should skip jsonls + index, just unlink manifest and rename.
      const resume = await runClean(applyArgs(tmp.dataDir));
      assert.strictEqual(resume.code, 0, `resume must succeed (stderr=${resume.stderr})`);

      // OLD gone, NEW present, manifest gone.
      assert.ok(!(await pathExists(tmp.oldFolder)), "OLD folder should be renamed away");
      assert.ok(await pathExists(tmp.newFolder), "NEW folder should exist");
      assert.ok(
        !(await pathExists(path.join(tmp.newFolder, MANIFEST_NAME))),
        "manifest should be deleted before rename",
      );

      const actual = await listFinalState(tmp.projectsDir);
      assertByteIdenticalToBaseline(actual, baselineState, "scenario 4");
    } finally {
      await fsp.rm(tmp.root, { recursive: true, force: true });
    }
  });

  it("bonus: stale-manifest is refused with exit 4", async () => {
    const tmp = await setupTempProjectsDir("stale");
    try {
      // Plant a manifest with a different oldPath/newPath than the args.
      const manifestPath = path.join(tmp.oldFolder, MANIFEST_NAME);
      const stale = {
        oldPath: "C:\\some\\other\\old",
        newPath: "C:\\some\\other\\new",
        intendedFiles: [],
        completedFiles: [],
        indexRewritten: false,
        folderRenamed: false,
      };
      await fsp.writeFile(manifestPath, JSON.stringify(stale, null, 2));

      const { code, stderr } = await runClean(applyArgs(tmp.dataDir));
      assert.strictEqual(code, 4, "stale manifest should yield exit 4");
      assert.match(stderr, /stale manifest/i, "stderr should mention stale manifest");
    } finally {
      await fsp.rm(tmp.root, { recursive: true, force: true });
    }
  });
});
