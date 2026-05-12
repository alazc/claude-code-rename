import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  atomicWrite,
  backupProjectFolder,
  walkJsonl,
  caseOnlyRename,
  isCaseInsensitiveFS,
} from "../src/fs.js";

const TEST_FAIL_ENV = "__ccr_test_fail_at";

async function mkTmp(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `ccr-fs-${prefix}-`));
}

async function listAll(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.sort();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("atomicWrite", () => {
  let root: string;

  before(async () => {
    root = await mkTmp("atomic");
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes content correctly to a fresh path", async () => {
    const target = path.join(root, "fresh.txt");
    await atomicWrite(target, "hello world");
    assert.equal(await fs.readFile(target, "utf8"), "hello world");
  });

  it("overwrites an existing file atomically", async () => {
    const target = path.join(root, "overwrite.txt");
    await atomicWrite(target, "first");
    await atomicWrite(target, "second");
    assert.equal(await fs.readFile(target, "utf8"), "second");
  });

  it("leaves no tmp file after success", async () => {
    const target = path.join(root, "no-tmp.txt");
    await atomicWrite(target, "clean");
    const siblings = await listAll(root);
    const orphans = siblings.filter(
      (n) => n.startsWith("no-tmp.txt.") && n.endsWith(".tmp"),
    );
    assert.deepEqual(orphans, []);
  });

  it("seam before-tmp-write: throws and leaves no orphan tmp; target unchanged", async () => {
    const target = path.join(root, "seam-before.txt");
    await atomicWrite(target, "original");
    process.env[TEST_FAIL_ENV] = `before-tmp-write:${target}`;
    try {
      await assert.rejects(
        () => atomicWrite(target, "WILL NOT WRITE"),
        /__ccr_test_fail/,
      );
      assert.equal(await fs.readFile(target, "utf8"), "original");
      const siblings = await listAll(root);
      const orphans = siblings.filter(
        (n) => n.startsWith("seam-before.txt.") && n.endsWith(".tmp"),
      );
      assert.deepEqual(orphans, []);
    } finally {
      delete process.env[TEST_FAIL_ENV];
    }
  });

  it("seam after-tmp-write: throws and cleans up tmp; target unchanged", async () => {
    const target = path.join(root, "seam-after.txt");
    await atomicWrite(target, "original");
    process.env[TEST_FAIL_ENV] = `after-tmp-write:${target}`;
    try {
      await assert.rejects(
        () => atomicWrite(target, "WILL NOT WRITE"),
        /__ccr_test_fail/,
      );
      assert.equal(await fs.readFile(target, "utf8"), "original");
      const siblings = await listAll(root);
      const orphans = siblings.filter(
        (n) => n.startsWith("seam-after.txt.") && n.endsWith(".tmp"),
      );
      assert.deepEqual(orphans, []);
    } finally {
      delete process.env[TEST_FAIL_ENV];
    }
  });

  it("seam before-rename: throws and cleans up tmp; target unchanged", async () => {
    const target = path.join(root, "seam-rename.txt");
    await atomicWrite(target, "original");
    process.env[TEST_FAIL_ENV] = `before-rename:${target}`;
    try {
      await assert.rejects(
        () => atomicWrite(target, "WILL NOT WRITE"),
        /__ccr_test_fail/,
      );
      assert.equal(await fs.readFile(target, "utf8"), "original");
      const siblings = await listAll(root);
      const orphans = siblings.filter(
        (n) => n.startsWith("seam-rename.txt.") && n.endsWith(".tmp"),
      );
      assert.deepEqual(orphans, []);
    } finally {
      delete process.env[TEST_FAIL_ENV];
    }
  });

  it("seam keyed by a different path is a no-op", async () => {
    const target = path.join(root, "seam-other.txt");
    process.env[TEST_FAIL_ENV] = `before-rename:/some/other/path`;
    try {
      await atomicWrite(target, "ok");
      assert.equal(await fs.readFile(target, "utf8"), "ok");
    } finally {
      delete process.env[TEST_FAIL_ENV];
    }
  });
});

describe("backupProjectFolder", () => {
  let root: string;

  before(async () => {
    root = await mkTmp("backup");
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("backs up a folder into <projects>/.ccrenamer-backups/<encoded>-<ts>/", async () => {
    const projectsDir = path.join(root, "projects-1");
    const folder = path.join(projectsDir, "C--Users-alazc-foo");
    await fs.mkdir(path.join(folder, "subagents"), { recursive: true });
    await fs.writeFile(path.join(folder, "a.jsonl"), '{"a":1}\n');
    await fs.writeFile(path.join(folder, "b.jsonl"), '{"b":2}\n');
    await fs.writeFile(path.join(folder, "subagents", "c.jsonl"), '{"c":3}\n');

    const dest = await backupProjectFolder(folder);

    assert.ok(await exists(dest), "backup dir should exist");
    assert.ok(
      dest.startsWith(path.join(projectsDir, ".ccrenamer-backups")),
      "backup should be inside .ccrenamer-backups",
    );
    assert.equal(await fs.readFile(path.join(dest, "a.jsonl"), "utf8"), '{"a":1}\n');
    assert.equal(
      await fs.readFile(path.join(dest, "subagents", "c.jsonl"), "utf8"),
      '{"c":3}\n',
    );
    const topLevel = (await fs.readdir(dest)).sort();
    assert.deepEqual(topLevel, ["a.jsonl", "b.jsonl", "subagents"]);
  });

  it("creates the .ccrenamer-backups parent if absent", async () => {
    const projectsDir = path.join(root, "projects-2");
    const folder = path.join(projectsDir, "encoded-name");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "x.jsonl"), "x");

    assert.ok(!(await exists(path.join(projectsDir, ".ccrenamer-backups"))));
    const dest = await backupProjectFolder(folder);
    assert.ok(await exists(path.join(projectsDir, ".ccrenamer-backups")));
    assert.ok(await exists(dest));
  });

  it("returns an absolute backup path with timestamp YYYYMMDD-HHMMSS", async () => {
    const projectsDir = path.join(root, "projects-3");
    const folder = path.join(projectsDir, "ts-folder");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "f.jsonl"), "f");

    const dest = await backupProjectFolder(folder);
    assert.ok(path.isAbsolute(dest), "backup path must be absolute");
    const base = path.basename(dest);
    // ts-folder-YYYYMMDD-HHMMSS
    assert.match(base, /^ts-folder-\d{8}-\d{6}$/);
  });
});

describe("walkJsonl", () => {
  let root: string;

  before(async () => {
    root = await mkTmp("walk");
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("yields top-level *.jsonl files", async () => {
    const folder = path.join(root, "topl");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "a.jsonl"), "");
    await fs.writeFile(path.join(folder, "b.jsonl"), "");

    const found = (await collect(walkJsonl(folder))).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["a.jsonl", "b.jsonl"]);
  });

  it("yields jsonls under <uuid>/subagents/", async () => {
    const folder = path.join(root, "subs");
    const uuidDir = path.join(folder, "11111111-1111-1111-1111-111111111111", "subagents");
    await fs.mkdir(uuidDir, { recursive: true });
    await fs.writeFile(path.join(folder, "top.jsonl"), "");
    await fs.writeFile(path.join(uuidDir, "child.jsonl"), "");

    const found = (await collect(walkJsonl(folder))).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["child.jsonl", "top.jsonl"]);
  });

  it("skips dotfiles and dot-directories", async () => {
    const folder = path.join(root, "dots");
    await fs.mkdir(path.join(folder, ".git"), { recursive: true });
    await fs.writeFile(path.join(folder, ".git", "foo.jsonl"), "");
    await fs.writeFile(path.join(folder, ".hidden.jsonl"), "");
    await fs.writeFile(path.join(folder, "visible.jsonl"), "");

    const found = (await collect(walkJsonl(folder))).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["visible.jsonl"]);
  });

  it("skips *.tmp files", async () => {
    const folder = path.join(root, "tmps");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "real.jsonl"), "");
    await fs.writeFile(path.join(folder, "real.jsonl.tmp"), "");
    await fs.writeFile(path.join(folder, "stray.tmp"), "");

    const found = (await collect(walkJsonl(folder))).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["real.jsonl"]);
  });

  it("skips .ccrenamer-progress.json", async () => {
    const folder = path.join(root, "progress");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "x.jsonl"), "");
    await fs.writeFile(path.join(folder, ".ccrenamer-progress.json"), "{}");

    const found = (await collect(walkJsonl(folder))).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["x.jsonl"]);
  });

  it("skips non-jsonl files", async () => {
    const folder = path.join(root, "nonj");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "keep.jsonl"), "");
    await fs.writeFile(path.join(folder, "bar.meta.json"), "{}");
    await fs.writeFile(path.join(folder, "baz.log"), "");

    const found = (await collect(walkJsonl(folder))).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["keep.jsonl"]);
  });

  it("yields nothing for a nonexistent root without throwing", async () => {
    const folder = path.join(root, "does-not-exist-xyz");
    const found = await collect(walkJsonl(folder));
    assert.deepEqual(found, []);
  });

  it("follows a symlinked subdirectory and yields jsonls under it", async (t) => {
    const folder = path.join(root, "symlink-dir");
    const realDir = path.join(root, "symlink-target");
    await fs.mkdir(folder, { recursive: true });
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "linked.jsonl"), "");
    await fs.writeFile(path.join(folder, "plain.jsonl"), "");

    try {
      await fs.symlink(realDir, path.join(folder, "linkdir"), "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOSYS") {
        t.skip(
          `skipping: directory symlinks require admin / developer mode on Windows (${code})`,
        );
        return;
      }
      throw err;
    }

    const found = (await collect(walkJsonl(folder))).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["linked.jsonl", "plain.jsonl"]);

    // The yielded path for the linked file should live under the caller's
    // root (via the link), not under the real target directory.
    const linked = (await collect(walkJsonl(folder))).find(
      (p) => path.basename(p) === "linked.jsonl",
    );
    assert.ok(linked && linked.startsWith(folder), "yielded path should be under the input folder");
  });

  it("terminates on a symlink cycle and yields each file at most once", async (t) => {
    const folder = path.join(root, "symlink-cycle");
    const dirA = path.join(folder, "A");
    const dirB = path.join(folder, "B");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirA, "a.jsonl"), "");
    await fs.writeFile(path.join(dirB, "b.jsonl"), "");

    // A/toB -> B, B/toA -> A. Walking either side cycles.
    try {
      await fs.symlink(dirB, path.join(dirA, "toB"), "dir");
      await fs.symlink(dirA, path.join(dirB, "toA"), "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOSYS") {
        t.skip(
          `skipping: directory symlinks require admin / developer mode on Windows (${code})`,
        );
        return;
      }
      throw err;
    }

    const found = await collect(walkJsonl(folder));
    const basenames = found.map((p) => path.basename(p)).sort();
    // Each file appears at most once — visited-inode dedup kicks in once
    // the walk re-enters a directory via the cycle.
    const counts = new Map<string, number>();
    for (const n of basenames) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const [name, c] of counts) {
      assert.ok(c <= 1, `${name} yielded ${c} times, expected <= 1`);
    }
    // Both files should be reachable at least once.
    assert.ok(basenames.includes("a.jsonl"));
    assert.ok(basenames.includes("b.jsonl"));
  });
});

describe("caseOnlyRename", () => {
  let root: string;

  before(async () => {
    root = await mkTmp("case");
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("renames Foo to foo (case-only) preserving content", async () => {
    const dir = await fs.mkdtemp(path.join(root, "case-only-"));
    const from = path.join(dir, "Foo");
    const to = path.join(dir, "foo");
    await fs.writeFile(from, "payload");

    await caseOnlyRename(from, to);
    assert.equal(await fs.readFile(to, "utf8"), "payload");
  });

  it("works for distinct names too (case-sensitive FS friendly)", async () => {
    const dir = await fs.mkdtemp(path.join(root, "distinct-"));
    const from = path.join(dir, "Foo");
    const to = path.join(dir, "Bar");
    await fs.writeFile(from, "data");

    await caseOnlyRename(from, to);
    assert.equal(await fs.readFile(to, "utf8"), "data");
    assert.ok(!(await exists(from)) || from.toLowerCase() === to.toLowerCase());
  });
});

describe("isCaseInsensitiveFS", () => {
  let root: string;

  before(async () => {
    root = await mkTmp("caseprobe");
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns a boolean and caches the result for the same path", async () => {
    const first = await isCaseInsensitiveFS(root);
    const second = await isCaseInsensitiveFS(root);
    assert.equal(typeof first, "boolean");
    assert.equal(first, second);
  });

  it("cleans up the probe file", async () => {
    await isCaseInsensitiveFS(root);
    const entries = await fs.readdir(root);
    const probes = entries.filter((n) => n.startsWith("__ccr_case_probe_"));
    assert.deepEqual(probes, []);
  });
});
