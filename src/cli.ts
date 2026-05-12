// CLI orchestration for ccRenamer.
//
// Wires encode/rewrite/scan/fs/claudeDir into the user-facing command. Public
// entry point is `main(argv, io?)`. The optional `io` seam lets tests inject
// stdio/TTY without monkey-patching `process` globals.
//
// Design source of truth:
//   .gstack/projects/ccRenamer/alazc-unknown-design-20260511-203523.md
// Amendments honored here: A1 (manifest), A2 (CC-running probe), A3 (backup
// location — already in fs.ts), A4 (auto-merge empty NEW), C1 (parseArgs),
// C2 (--apply UX, dry-run to stderr), C3 (sessions-index three-way switch —
// in rewrite.ts), C4 (exit code split), P1 (backup transparency), X1 (no
// realpath), X2 (--data-dir override), X3 (OLD⊂NEW gate is a confirmation
// not a refusal).

import { promises as fsp, statfsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { encodePath, type HostOS } from "./encode.js";
import {
  rewriteJsonl,
  rewriteSessionsIndex,
  OriginalPathMismatchError,
  type SessionsIndexWarning,
} from "./rewrite.js";
import { scanOrphans, type Orphan } from "./scan.js";
import {
  atomicWrite,
  backupProjectFolder,
  caseOnlyRename,
  isCaseInsensitiveFS,
  walkJsonl,
} from "./fs.js";
import { resolveProjectsDir } from "./claudeDir.js";

// ---------- types ----------

export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  isStdoutTTY: boolean;
  isStderrTTY: boolean;
}

interface ParsedFlags {
  old: string | undefined;
  new: string | undefined;
  apply: boolean;
  backup: boolean;
  scan: boolean;
  yes: boolean;
  dataDir: string | undefined;
  help: boolean;
  version: boolean;
}

interface Manifest {
  oldPath: string;
  newPath: string;
  intendedFiles: string[];
  completedFiles: string[];
  indexRewritten: boolean;
  folderRenamed: boolean;
}

const HOST_OS: HostOS = process.platform === "win32" ? "windows" : "posix";
const MANIFEST_NAME = ".ccrenamer-progress.json";
const SESSIONS_INDEX = "sessions-index.json";

const HELP_TEXT = `ccr — recover Claude Code /resume after a folder rename

Usage:
  ccr                                  scan + interactive repair (dry-run)
  ccr --old <path> --new <path>        explicit dry-run
  ccr --old <path> --new <path> --apply
                                       commit changes (prompts on TTY)
  ccr --scan                           list orphans only, never modify
  ccr --backup                         copy project folder before modifying
  ccr --yes                            confirm without TTY prompt
  ccr --data-dir <path>                override Claude data root
  ccr --help                           show this message
  ccr --version                        print version

Exit codes:
  0  success / dry-run / nothing to do
  1  user error (bad args, CC running)
  2  refuse to clobber non-empty NEW folder
  3  internal error
  4  filesystem precondition not met
`;

// ---------- public entry ----------

export async function main(argv: string[], io?: CliIO): Promise<number> {
  const stdio = io ?? defaultIO();
  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      stdio.stdout.write(HELP_TEXT);
      return 0;
    }
    if (flags.version) {
      stdio.stdout.write(`${await readVersion()}\n`);
      return 0;
    }

    const projectsDir = resolveProjectsDir(
      flags.dataDir !== undefined ? { dataDirOverride: flags.dataDir } : undefined,
    );

    if (flags.scan) {
      return await runScan(projectsDir, stdio);
    }

    if (flags.old === undefined && flags.new === undefined) {
      return await runZeroArg(projectsDir, flags, stdio);
    }

    return await runRename(projectsDir, flags, stdio);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stdio.stderr.write(`ccr: internal error: ${msg}\n`);
    return 3;
  }
}

function defaultIO(): CliIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    isStdoutTTY: Boolean((process.stdout as NodeJS.WriteStream).isTTY),
    isStderrTTY: Boolean((process.stderr as NodeJS.WriteStream).isTTY),
  };
}

// ---------- arg parsing ----------

function parseFlags(argv: string[]): ParsedFlags {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      old: { type: "string" },
      new: { type: "string" },
      apply: { type: "boolean", default: false },
      backup: { type: "boolean", default: false },
      scan: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });
  return {
    old: typeof values.old === "string" ? values.old : undefined,
    new: typeof values.new === "string" ? values.new : undefined,
    apply: values.apply === true,
    backup: values.backup === true,
    scan: values.scan === true,
    yes: values.yes === true,
    dataDir: typeof values["data-dir"] === "string" ? values["data-dir"] : undefined,
    help: values.help === true,
    version: values.version === true,
  };
}

async function readVersion(): Promise<string> {
  // package.json sits two levels up from dist/cli.js (and one up from src/cli.ts
  // when run via tsx). Try both.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const candidates = [
    path.resolve(here, "..", "package.json"),
    path.resolve(here, "..", "..", "package.json"),
  ];
  for (const c of candidates) {
    try {
      const raw = await fsp.readFile(c, "utf8");
      const obj = JSON.parse(raw) as { version?: unknown };
      if (typeof obj.version === "string") return obj.version;
    } catch {
      // try next
    }
  }
  return "0.0.0-unknown";
}

// ---------- path normalization ----------

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function normalizeUserPath(p: string): string {
  // X1: NO fs.realpathSync. Just expand ~ and resolve to absolute.
  return path.resolve(expandTilde(p));
}

function pathsEqualForOS(a: string, b: string): boolean {
  if (HOST_OS === "windows") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// ---------- scan flow (--scan or zero-arg) ----------

async function runScan(projectsDir: string, io: CliIO): Promise<number> {
  const result = await scanOrphans(path.dirname(projectsDir));
  if (result.orphans.length === 0 && result.skipped.length === 0) {
    io.stdout.write("No orphaned projects found.\n");
    return 0;
  }
  if (result.orphans.length > 0) {
    io.stdout.write(`Found ${result.orphans.length} orphaned project(s):\n`);
    for (const o of result.orphans) {
      io.stdout.write(formatOrphan(o));
    }
  } else {
    io.stdout.write("No orphaned projects found.\n");
  }
  if (result.skipped.length > 0) {
    io.stdout.write(`\nSkipped ${result.skipped.length} folder(s):\n`);
    for (const s of result.skipped) {
      io.stdout.write(`  - ${s.encodedFolder}: ${s.reason}\n`);
    }
  }
  return 0;
}

function formatOrphan(o: Orphan): string {
  const mb = (o.sizeBytes / (1024 * 1024)).toFixed(1);
  const parent = o.parentExists ? "(parent dir present)" : "(parent dir missing)";
  return (
    `  - ${o.encodedFolder}\n` +
    `      original: ${path.normalize(o.originalPath)} ${parent}\n` +
    `      sessions: ${o.sessionCount}, size: ${mb} MB, source: ${o.source}\n`
  );
}

async function runZeroArg(
  projectsDir: string,
  flags: ParsedFlags,
  io: CliIO,
): Promise<number> {
  const result = await scanOrphans(path.dirname(projectsDir));
  if (result.skipped.length > 0) {
    io.stderr.write(`Note: ${result.skipped.length} folder(s) skipped during scan:\n`);
    for (const s of result.skipped) {
      io.stderr.write(`  - ${s.encodedFolder}: ${s.reason}\n`);
    }
  }
  if (result.orphans.length === 0) {
    io.stdout.write("No orphaned projects found.\n");
    return 0;
  }
  if (result.orphans.length === 1 && result.orphans[0]!.parentExists) {
    const orphan = result.orphans[0]!;
    io.stdout.write(`Found 1 orphaned project:\n${formatOrphan(orphan)}\n`);
    if (!io.isStdoutTTY) {
      io.stderr.write(
        "Non-interactive mode: re-run with --old/--new to specify the new path.\n",
      );
      return 0;
    }
    const rl = createInterface({ input: io.stdin, output: io.stdout });
    let answer: string;
    try {
      answer = await rl.question(`Where did you move ${path.normalize(orphan.originalPath)}? > `);
    } finally {
      rl.close();
    }
    const trimmed = answer.trim();
    if (trimmed === "") {
      io.stderr.write("ccr: no path supplied; aborting.\n");
      return 1;
    }
    const merged: ParsedFlags = { ...flags, old: orphan.originalPath, new: trimmed };
    return await runRename(projectsDir, merged, io);
  }
  io.stdout.write(`Found ${result.orphans.length} orphaned project(s):\n`);
  for (const o of result.orphans) io.stdout.write(formatOrphan(o));
  io.stdout.write(
    "\nMultiple orphans (or parent missing). Re-run with --old <path> --new <path>.\n",
  );
  return 0;
}

// ---------- rename flow ----------

async function runRename(
  projectsDir: string,
  flags: ParsedFlags,
  io: CliIO,
): Promise<number> {
  // Gate 1: empty old/new
  const rawOld = flags.old ?? "";
  const rawNew = flags.new ?? "";
  if (rawOld.trim() === "" || rawNew.trim() === "") {
    io.stderr.write("ccr: OLD_PATH and NEW_PATH must be non-empty.\n");
    return 1;
  }

  const oldPath = normalizeUserPath(rawOld);
  const newPath = normalizeUserPath(rawNew);

  // Gate 2: identical
  if (pathsEqualForOS(oldPath, newPath)) {
    io.stderr.write("ccr: OLD_PATH and NEW_PATH are identical.\n");
    return 1;
  }

  const oldEncoded = encodePath(oldPath, HOST_OS);
  const newEncoded = encodePath(newPath, HOST_OS);
  const oldFolder = path.join(projectsDir, oldEncoded);
  const newFolder = path.join(projectsDir, newEncoded);

  // Gate 3: OLD folder exists
  if (!(await pathExists(oldFolder))) {
    io.stderr.write(`ccr: OLD project not found at ${oldFolder}\n`);
    return 4;
  }

  // Gate 6: CC running probe (do it early so we don't preflight-spam if CC is up)
  const ccRunningCheck = await detectRunningCC(oldFolder);
  if (ccRunningCheck.running) {
    io.stderr.write(
      `ccr: Claude Code appears to be running (${ccRunningCheck.evidence}). Close all CC instances and re-run.\n`,
    );
    return 1;
  }

  // Walk jsonl files now to support gates 4/5 and the manifest's intendedFiles.
  const intendedFiles = await collectIntendedFiles(oldFolder);

  // Pre-read manifest so resume-aware gates can be lenient about partially-
  // rewritten files. We re-validate / write the manifest later in apply.
  const earlyManifest = await readManifest(path.join(oldFolder, MANIFEST_NAME));
  const isResumeMatching =
    earlyManifest !== null &&
    earlyManifest.oldPath === oldPath &&
    earlyManifest.newPath === newPath;

  // Gate 4: encoder sanity. If we're mid-resume, accept either OLD or NEW
  // encoding (some files may already carry NEW cwd from the prior partial run).
  const sanity = await verifyEncoderSanity(
    intendedFiles,
    oldEncoded,
    isResumeMatching ? newEncoded : null,
  );
  if (!sanity.ok) {
    io.stderr.write(`ccr: ${sanity.message}\n`);
    return 4;
  }

  // Gate 5: OLD literal verification. Skip on resume (the literal may have
  // been rewritten in already-completed files, and re-checking would fail
  // when no file still contains OLD).
  if (!isResumeMatching) {
    const literalCheck = await verifyOldPathLiteral(intendedFiles, oldPath);
    if (!literalCheck.ok) {
      io.stderr.write(`ccr: ${literalCheck.message}\n`);
      return 4;
    }
  }

  // Gate 7: refuse-to-clobber with auto-merge (A4)
  let autoMergeNote: string | null = null;
  const newExists = await pathExists(newFolder);
  // Special case: if oldFolder and newFolder resolve to the same path on a
  // case-insensitive FS (case-only rename), don't classify NEW as colliding.
  const sameAsOld = pathsEqualForOS(path.resolve(oldFolder), path.resolve(newFolder));
  if (newExists && !sameAsOld) {
    const classification = await classifyNewFolder(newFolder);
    if (classification.kind === "fresh-cc-restart") {
      autoMergeNote = `Auto-merging empty NEW folder ${newFolder}${classification.detail ? ` (${classification.detail})` : ""}`;
    } else {
      io.stderr.write(
        `ccr: NEW folder already has transcripts: ${newFolder}. Manual merge required.\n`,
      );
      return 2;
    }
  }

  // Gate 8: OLD⊂NEW substring detection (X3)
  const oldSubstringOfNew = checkOldSubstringOfNew(oldPath, newPath, intendedFiles);

  // Backup transparency / free-space (P1)
  let backupInfo: BackupInfo | null = null;
  if (flags.backup) {
    backupInfo = await computeBackupInfo(oldFolder, intendedFiles);
    if (backupInfo.insufficientSpace) {
      io.stderr.write(
        `ccr: Insufficient free space: need ~${formatMB(backupInfo.requiredBytes * 1.2)}, have ${formatMB(backupInfo.freeBytes)}.\n`,
      );
      return 4;
    }
  }

  // Manifest resume check
  const manifestPath = path.join(oldFolder, MANIFEST_NAME);
  const existingManifest = await readManifest(manifestPath);
  if (existingManifest) {
    if (
      existingManifest.oldPath !== oldPath ||
      existingManifest.newPath !== newPath
    ) {
      io.stderr.write(
        `ccr: stale manifest detected at ${manifestPath}. Delete it or re-run with --old/--new matching it (was: old="${existingManifest.oldPath}", new="${existingManifest.newPath}").\n`,
      );
      return 4;
    }
  }

  // Build dry-run preview by walking files
  const preview = await buildPreview(intendedFiles, oldPath, newPath);

  // Always emit dry-run preview to stderr (C2)
  emitPreview(io.stderr, {
    oldPath,
    newPath,
    oldFolder,
    newFolder,
    preview,
    autoMergeNote,
    oldSubstringOfNew,
    backupInfo,
    isApply: flags.apply,
    hasSessionsIndex: await pathExists(path.join(oldFolder, SESSIONS_INDEX)),
  });

  if (!flags.apply) {
    io.stdout.write(
      `Dry-run complete. Re-run with --apply to commit ${preview.totalOccurrences} substitution(s) across ${preview.files.length} file(s).\n`,
    );
    return 0;
  }

  // OLD⊂NEW confirmation gate (X3): on apply path only.
  if (oldSubstringOfNew.applies) {
    if (!io.isStdoutTTY && !flags.yes) {
      io.stderr.write(
        "ccr: OLD is a substring of NEW. Re-run with --yes to confirm or use a TTY.\n",
      );
      return 1;
    }
    if (io.isStdoutTTY && !flags.yes) {
      const ok = await confirmYN(io, "OLD is a substring of NEW — proceed? (y/N) ");
      if (!ok) {
        io.stderr.write("ccr: aborted.\n");
        return 1;
      }
    }
  }

  // C2: TTY confirmation gate
  if (!io.isStdoutTTY) {
    if (!flags.yes) {
      io.stderr.write("ccr: non-interactive mode requires --yes.\n");
      return 1;
    }
  } else if (!flags.yes) {
    const ok = await confirmYN(io, "Proceed with apply? (y/N) ");
    if (!ok) {
      io.stderr.write("ccr: aborted.\n");
      return 0;
    }
  }

  // Apply sequence
  return await applySequence({
    io,
    projectsDir,
    oldPath,
    newPath,
    oldFolder,
    newFolder,
    oldEncoded,
    newEncoded,
    intendedFiles,
    manifestPath,
    existingManifest,
    autoMergeNote,
    backup: flags.backup,
    backupInfo,
  });
}

interface ApplyParams {
  io: CliIO;
  projectsDir: string;
  oldPath: string;
  newPath: string;
  oldFolder: string;
  newFolder: string;
  oldEncoded: string;
  newEncoded: string;
  intendedFiles: string[];
  manifestPath: string;
  existingManifest: Manifest | null;
  autoMergeNote: string | null;
  backup: boolean;
  backupInfo: BackupInfo | null;
}

async function applySequence(p: ApplyParams): Promise<number> {
  const { io } = p;

  // Initialize / load manifest
  let manifest: Manifest;
  if (p.existingManifest) {
    manifest = p.existingManifest;
  } else {
    manifest = {
      oldPath: p.oldPath,
      newPath: p.newPath,
      intendedFiles: p.intendedFiles,
      completedFiles: [],
      indexRewritten: false,
      folderRenamed: false,
    };
    await atomicWrite(p.manifestPath, JSON.stringify(manifest, null, 2));
  }

  // Backup
  if (p.backup) {
    const dest = await backupProjectFolder(p.oldFolder);
    io.stderr.write(`ccr: backed up to ${dest}\n`);
  }

  // Auto-merge: delete the empty NEW folder before rename
  if (p.autoMergeNote) {
    await fsp.rm(p.newFolder, { recursive: true, force: true });
  }

  // Rewrite jsonl files
  const completed = new Set(manifest.completedFiles);
  let totalOccurrences = 0;
  let rewrittenCount = 0;
  for (const file of manifest.intendedFiles) {
    if (completed.has(file)) continue;
    const content = await fsp.readFile(file, "utf8");
    const { newContent, occurrences } = rewriteJsonl(content, p.oldPath, p.newPath);
    if (newContent !== content) {
      await atomicWrite(file, newContent);
      rewrittenCount += 1;
    }
    totalOccurrences += occurrences;
    completed.add(file);
    manifest.completedFiles = [...completed];
    await atomicWrite(p.manifestPath, JSON.stringify(manifest, null, 2));
  }

  // sessions-index.json
  const indexPath = path.join(p.oldFolder, SESSIONS_INDEX);
  if (await pathExists(indexPath)) {
    if (!manifest.indexRewritten) {
      const raw = await fsp.readFile(indexPath, "utf8");
      let result: { content: string; warnings: SessionsIndexWarning[] };
      try {
        result = rewriteSessionsIndex(
          raw,
          p.oldPath,
          p.newPath,
          p.oldEncoded,
          p.newEncoded,
        );
      } catch (err) {
        if (err instanceof OriginalPathMismatchError) {
          io.stderr.write(`ccr: sessions-index.json mismatch: ${err.message}\n`);
          return 4;
        }
        throw err;
      }
      for (const w of result.warnings) {
        io.stderr.write(
          `ccr: warning — sessions-index entry[${w.entryIndex}].${w.field} = "${w.observed}" did not match OLD or NEW (left as-is).\n`,
        );
      }
      await atomicWrite(indexPath, result.content);
      manifest.indexRewritten = true;
      await atomicWrite(p.manifestPath, JSON.stringify(manifest, null, 2));
    }
  }

  // Folder rename. Delete manifest BEFORE rename so the manifest never moves
  // with the folder (the manifest path is rooted at oldFolder; if rename
  // succeeds, we're done, and if it fails, the next dry-run will see no
  // manifest and a not-yet-renamed folder — harmless rerun.)
  await fsp.unlink(p.manifestPath).catch(() => {});

  const caseInsensitive = await isCaseInsensitiveFS(p.projectsDir).catch(() => false);
  const isCaseOnly =
    p.oldFolder.toLowerCase() === p.newFolder.toLowerCase() && p.oldFolder !== p.newFolder;
  try {
    if (caseInsensitive && isCaseOnly) {
      await caseOnlyRename(p.oldFolder, p.newFolder);
    } else {
      await fsp.rename(p.oldFolder, p.newFolder);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr.write(`ccr: folder rename failed: ${msg}\n`);
    return 3;
  }

  io.stdout.write(
    `Rewrote ${rewrittenCount} file(s) (${totalOccurrences} total occurrences). ` +
      `Renamed ${p.oldEncoded} -> ${p.newEncoded}.\n`,
  );
  return 0;
}

// ---------- gates / helpers ----------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function collectIntendedFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkJsonl(folder)) out.push(f);
  out.sort();
  return out;
}

interface CcRunningProbe {
  running: boolean;
  evidence: string;
}

async function detectRunningCC(oldFolder: string): Promise<CcRunningProbe> {
  // (a) Lock/pid file probe — known v1 limitation: CC 2.1.139 does not appear
  // to write a stable, well-known pid file on Windows. The user's data dir
  // contains no .pid/.lock files in practice. We document this gap and rely on
  // probe (b). If a future CC release adds one, add the path here.
  // (b) Try to open a jsonl with read+write (advisory on Windows: EBUSY/EPERM
  // when CC has the file open; on POSIX, plain r+ doesn't detect concurrent
  // writers without flock — accepted as a v1 best-effort limitation).
  let firstJsonl: string | null = null;
  for await (const f of walkJsonl(oldFolder)) {
    firstJsonl = f;
    break;
  }
  if (firstJsonl === null) return { running: false, evidence: "no jsonl found" };
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await fsp.open(firstJsonl, "r+");
    return { running: false, evidence: "no lock detected" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      return { running: true, evidence: `${code} on ${path.basename(firstJsonl)}` };
    }
    return { running: false, evidence: `unrelated: ${code ?? "unknown"}` };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function verifyEncoderSanity(
  intendedFiles: string[],
  expectedEncoded: string,
  altAcceptedEncoded: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const file of intendedFiles) {
    const cwd = await readFirstCwd(file);
    if (cwd === null) continue;
    const encoded = encodePath(cwd, HOST_OS);
    if (encoded === expectedEncoded) return { ok: true };
    if (altAcceptedEncoded !== null && encoded === altAcceptedEncoded) {
      // Resume case: this file already carries the rewritten cwd from a prior partial run.
      return { ok: true };
    }
    return {
      ok: false,
      message: `encoder mismatch: jsonl cwd '${cwd}' encodes to '${encoded}' but folder is '${expectedEncoded}'. Possible CC schema drift.`,
    };
  }
  // No cwd-bearing line found anywhere — treat as ok (encoder can't be
  // checked). The OLD-literal gate below will likely fail as a backstop.
  return { ok: true };
}

async function verifyOldPathLiteral(
  intendedFiles: string[],
  oldPath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Look for the literal as it appears inside JSON-string bodies on disk. Use
  // the same JSON-encoding the rewriter uses.
  const needle = JSON.stringify(oldPath).slice(1, -1);
  for (const file of intendedFiles) {
    let content: string;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes(needle)) return { ok: true };
  }
  return {
    ok: false,
    message: `OLD_PATH literal not found in transcript: '${oldPath}'. Did you mean a different path?`,
  };
}

async function readFirstCwd(jsonlPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fsp.readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && "cwd" in obj) {
      const cwd = (obj as { cwd: unknown }).cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    }
  }
  return null;
}

interface NewFolderClassification {
  kind: "fresh-cc-restart" | "non-empty";
  detail?: string;
}

async function classifyNewFolder(folder: string): Promise<NewFolderClassification> {
  const jsonls: string[] = [];
  for await (const f of walkJsonl(folder)) jsonls.push(f);
  if (jsonls.length === 0) {
    return { kind: "fresh-cc-restart", detail: "no jsonl files" };
  }
  if (jsonls.length === 1) {
    try {
      const st = await fsp.stat(jsonls[0]!);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs < 24 * 60 * 60 * 1000) {
        return {
          kind: "fresh-cc-restart",
          detail: `single jsonl created ${new Date(st.mtimeMs).toISOString()}`,
        };
      }
    } catch {
      // fall through
    }
  }
  return { kind: "non-empty" };
}

interface OldSubstringOfNewInfo {
  applies: boolean;
  occurrences: number;
  files: number;
}

function checkOldSubstringOfNew(
  oldPath: string,
  newPath: string,
  _intendedFiles: string[],
): OldSubstringOfNewInfo {
  // We don't actually scan files here; we surface intent. Rewrite is safe under
  // cursor advancement (see rewrite.ts). The preview will use this as a flag
  // and the dry-run "files affected" count is a separate scan.
  if (!newPath.includes(oldPath) || newPath === oldPath) {
    return { applies: false, occurrences: 0, files: 0 };
  }
  return { applies: true, occurrences: 0, files: 0 };
}

interface BackupInfo {
  requiredBytes: number;
  freeBytes: number;
  insufficientSpace: boolean;
  freeUnknown: boolean;
}

async function computeBackupInfo(
  oldFolder: string,
  intendedFiles: string[],
): Promise<BackupInfo> {
  let requiredBytes = 0;
  for (const f of intendedFiles) {
    try {
      const st = await fsp.stat(f);
      requiredBytes += st.size;
    } catch {
      // skip
    }
  }
  try {
    const idx = await fsp.stat(path.join(oldFolder, SESSIONS_INDEX));
    requiredBytes += idx.size;
  } catch {
    // optional file
  }
  let freeBytes = Number.POSITIVE_INFINITY;
  let freeUnknown = false;
  try {
    const sf = statfsSync(oldFolder);
    freeBytes = Number(sf.bavail) * Number(sf.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < 1024 * 1024) {
      freeUnknown = true;
    }
  } catch {
    freeUnknown = true;
  }
  const insufficientSpace = !freeUnknown && freeBytes < requiredBytes * 1.2;
  return { requiredBytes, freeBytes, insufficientSpace, freeUnknown };
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PreviewData {
  files: Array<{ path: string; occurrences: number }>;
  totalOccurrences: number;
}

async function buildPreview(
  files: string[],
  oldPath: string,
  newPath: string,
): Promise<PreviewData> {
  const out: PreviewData = { files: [], totalOccurrences: 0 };
  for (const file of files) {
    let content: string;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const { occurrences } = rewriteJsonl(content, oldPath, newPath);
    out.files.push({ path: file, occurrences });
    out.totalOccurrences += occurrences;
  }
  return out;
}

interface PreviewArgs {
  oldPath: string;
  newPath: string;
  oldFolder: string;
  newFolder: string;
  preview: PreviewData;
  autoMergeNote: string | null;
  oldSubstringOfNew: OldSubstringOfNewInfo;
  backupInfo: BackupInfo | null;
  isApply: boolean;
  hasSessionsIndex: boolean;
}

function emitPreview(stream: NodeJS.WritableStream, args: PreviewArgs): void {
  const tag = args.isApply ? "[apply preview]" : "[dry-run]";
  stream.write(`${tag} OLD: ${path.normalize(args.oldPath)}\n`);
  stream.write(`${tag} NEW: ${path.normalize(args.newPath)}\n`);
  stream.write(`${tag} folder: ${args.oldFolder} -> ${args.newFolder}\n`);
  if (args.autoMergeNote) {
    stream.write(`${tag} ${args.autoMergeNote}\n`);
  }
  if (args.oldSubstringOfNew.applies) {
    stream.write(
      `${tag} WARNING: OLD is a substring of NEW. Substitutions will rewrite all occurrences.\n`,
    );
  }
  if (args.backupInfo) {
    const eta = (args.backupInfo.requiredBytes / (100 * 1024 * 1024)).toFixed(1);
    const freeStr = args.backupInfo.freeUnknown
      ? "free space: unknown"
      : `free: ${formatMB(args.backupInfo.freeBytes)}`;
    stream.write(
      `${tag} backup: ~${formatMB(args.backupInfo.requiredBytes)}, ${freeStr}, ETA ~${eta}s @100 MB/s\n`,
    );
  }
  stream.write(`${tag} ${args.preview.files.length} jsonl file(s):\n`);
  for (const f of args.preview.files) {
    stream.write(`${tag}   ${f.path}: ${f.occurrences} occurrence(s)\n`);
  }
  if (args.hasSessionsIndex) {
    stream.write(`${tag} sessions-index.json: will rewrite originalPath / projectPath / fullPath\n`);
  }
  stream.write(
    `${tag} total: ${args.preview.totalOccurrences} occurrence(s) across ${args.preview.files.length} file(s)\n`,
  );
}

async function readManifest(p: string): Promise<Manifest | null> {
  try {
    const raw = await fsp.readFile(p, "utf8");
    const obj = JSON.parse(raw) as Partial<Manifest>;
    if (
      typeof obj.oldPath === "string" &&
      typeof obj.newPath === "string" &&
      Array.isArray(obj.intendedFiles) &&
      Array.isArray(obj.completedFiles) &&
      typeof obj.indexRewritten === "boolean" &&
      typeof obj.folderRenamed === "boolean"
    ) {
      return obj as Manifest;
    }
    return null;
  } catch {
    return null;
  }
}

async function confirmYN(io: CliIO, prompt: string): Promise<boolean> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const ans = await rl.question(prompt);
    return ans.trim().toLowerCase() === "y" || ans.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
