// CLI orchestration for ccRenamer.
//
// Wires encode/rewrite/scan/fs/claudeDir into the user-facing command. Public
// entry point is `main(argv, io?)`. The optional `io` seam lets tests inject
// stdio/TTY without monkey-patching `process` globals.
//
// Design amendments honored here (see DESIGN.md and PROBLEM.md):
//   A1 manifest, A2 CC-running probe, A3 backup location (in fs.ts), C1
//   parseArgs, C2 --apply UX with dry-run to stderr, C3 sessions-index
//   three-way switch (in rewrite.ts), C4 exit-code split, P1 backup
//   transparency, X1 no realpath, X2 --data-dir override, X3 OLD⊂NEW
//   confirmation gate, and the merge-mode supersession of the original
//   A4 auto-merge-empty-NEW heuristic (see "Two modes" in README).

import { promises as fsp, statfsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { encodePath, type HostOS } from "./encode.js";
import {
  rewriteJsonl,
  rewriteSessionsIndex,
  rewriteSessionsIndexEntries,
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

type ApplyMode = "rename" | "merge";

interface Manifest {
  oldPath: string;
  newPath: string;
  // Added 2026-05-12: "rename" preserves the original v1 behavior (rename
  // OLD encoded folder to NEW, in-place jsonl rewrites). "merge" is the
  // fork semantic used when NEW encoded folder already exists on disk —
  // source folder is kept intact, source jsonls are COPIED (rewritten)
  // into NEW, sessions-index entries are concatenated. Legacy manifests
  // without this field are treated as "rename" for backward compat.
  mode?: ApplyMode;
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
  2  (reserved — was refuse-to-clobber pre-merge-mode; no longer emitted)
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

  // Determine apply mode BEFORE the CC-running probe so we can probe both
  // folders in merge mode (CC could be active in either project).
  const newExistsForMode = await pathExists(newFolder);
  const sameAsOldForMode = pathsEqualForOS(path.resolve(oldFolder), path.resolve(newFolder));
  const mode: ApplyMode = newExistsForMode && !sameAsOldForMode ? "merge" : "rename";

  // Gate 6: CC running probe (do it early so we don't preflight-spam if CC is up)
  const ccRunningCheck = await detectRunningCC(oldFolder);
  if (ccRunningCheck.running) {
    io.stderr.write(
      `ccr: Claude Code appears to be running (${ccRunningCheck.evidence}). Close all CC instances and re-run.\n`,
    );
    return 1;
  }
  if (mode === "merge") {
    const ccProbeNew = await detectRunningCC(newFolder);
    if (ccProbeNew.running) {
      io.stderr.write(
        `ccr: Claude Code appears to be running in NEW project (${ccProbeNew.evidence}). Close all CC instances and re-run.\n`,
      );
      return 1;
    }
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

  // Merge-mode preflight: when NEW encoded folder already exists, we MERGE
  // (copy + rewrite source jsonls INTO destination; keep source intact;
  // concatenate sessions-index entries). This supersedes amendment A4's
  // delete-then-rename heuristic; no fresh-cc-restart 24h check is performed.
  let mergeInfo: MergeInfo | null = null;
  if (mode === "merge") {
    mergeInfo = await prepareMergeInfo(oldFolder, newFolder, intendedFiles);
    if (mergeInfo.collisions.length > 0) {
      const sample = mergeInfo.collisions[0]!;
      io.stderr.write(
        `ccr: destination already has file with same relative path: ${sample}. Manual resolution required (rename or remove the destination file).\n`,
      );
      return 4;
    }
    // Encoder-sanity on destination's existing jsonls: if NEW's own jsonls
    // claim a cwd that doesn't encode to NEW_ENCODED, something is off with
    // the destination folder itself (e.g. CC schema drift).
    if (mergeInfo.destJsonls.length > 0) {
      const destSanity = await verifyEncoderSanity(mergeInfo.destJsonls, newEncoded, null);
      if (!destSanity.ok) {
        io.stderr.write(`ccr: destination ${destSanity.message}\n`);
        return 4;
      }
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

  // Manifest resume check. In merge mode the manifest lives in the
  // DESTINATION folder so the source is touched by zero writes for the
  // entire operation. In rename mode it stays in source per amendment A1
  // (source folder is the canonical target until the rename succeeds).
  const manifestPath = path.join(
    mode === "merge" ? newFolder : oldFolder,
    MANIFEST_NAME,
  );
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
    // Mode mismatch: manifest was created in one mode but destination state
    // now suggests the other. Protects against destination being created
    // (or deleted) between the crash and the resume.
    const manifestMode: ApplyMode = existingManifest.mode ?? "rename";
    if (manifestMode !== mode) {
      io.stderr.write(
        `ccr: stale manifest detected at ${manifestPath}: was created in "${manifestMode}" mode but destination state suggests "${mode}" mode now. Delete the manifest or restore the destination folder.\n`,
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
    mode,
    mergeInfo,
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
    mode,
    mergeInfo,
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
  mode: ApplyMode;
  mergeInfo: MergeInfo | null;
  backup: boolean;
  backupInfo: BackupInfo | null;
}

async function applySequence(p: ApplyParams): Promise<number> {
  // Initialize / load manifest. New manifests record the current mode so
  // future resumes can detect destination-state drift via the mode-mismatch
  // gate in runRename.
  let manifest: Manifest;
  if (p.existingManifest) {
    manifest = p.existingManifest;
    // Backfill mode if a legacy manifest is missing it.
    if (!manifest.mode) manifest.mode = p.mode;
  } else {
    manifest = {
      oldPath: p.oldPath,
      newPath: p.newPath,
      mode: p.mode,
      intendedFiles: p.intendedFiles,
      completedFiles: [],
      indexRewritten: false,
      folderRenamed: false,
    };
    await atomicWrite(p.manifestPath, JSON.stringify(manifest, null, 2));
  }

  if (p.mode === "merge") {
    return await applyMergeSequence(p, manifest);
  }
  return await applyRenameSequence(p, manifest);
}

async function applyRenameSequence(p: ApplyParams, manifest: Manifest): Promise<number> {
  const { io } = p;

  // Backup
  if (p.backup) {
    const dest = await backupProjectFolder(p.oldFolder);
    io.stderr.write(`ccr: backed up to ${dest}\n`);
  }

  // Rewrite jsonl files in place
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

  // sessions-index.json in place
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

  // Folder rename. Delete manifest BEFORE rename so it never moves with the
  // folder. If rename fails, next run sees no manifest + not-yet-renamed
  // folder — harmless rerun.
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

async function applyMergeSequence(p: ApplyParams, manifest: Manifest): Promise<number> {
  const { io } = p;
  if (!p.mergeInfo) {
    io.stderr.write("ccr: internal error: merge mode invoked without mergeInfo.\n");
    return 3;
  }
  const merge = p.mergeInfo;

  // Backup BOTH folders — both will change in merge mode.
  if (p.backup) {
    const destOld = await backupProjectFolder(p.oldFolder);
    io.stderr.write(`ccr: backed up source to ${destOld}\n`);
    const destNew = await backupProjectFolder(p.newFolder);
    io.stderr.write(`ccr: backed up destination to ${destNew}\n`);
  }

  // Copy + rewrite each source jsonl into its destPath. Track completion by
  // destPath (the file we actually wrote). Source jsonls are never modified.
  const completed = new Set(manifest.completedFiles);
  let totalOccurrences = 0;
  let copiedCount = 0;
  for (const sourcePath of manifest.intendedFiles) {
    const destPath = sourceToDestPath(sourcePath, p.oldFolder, p.newFolder);
    if (completed.has(destPath)) continue;

    // Ensure parent dir exists (subagents/ subdirs may not be in destination yet).
    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    const content = await fsp.readFile(sourcePath, "utf8");
    const { newContent, occurrences } = rewriteJsonl(content, p.oldPath, p.newPath);
    await atomicWrite(destPath, newContent);
    totalOccurrences += occurrences;
    copiedCount += 1;
    completed.add(destPath);
    manifest.completedFiles = [...completed];
    await atomicWrite(p.manifestPath, JSON.stringify(manifest, null, 2));
  }

  // Merge sessions-index.json: take destination's existing entries (already
  // correctly point at NEW) and concatenate the source's rewritten entries.
  // The merged index's originalPath is NEW_PATH.
  const sourceIndexPath = path.join(p.oldFolder, SESSIONS_INDEX);
  const destIndexPath = path.join(p.newFolder, SESSIONS_INDEX);
  let mergedExisting = 0;
  let mergedMigrated = 0;
  if (!manifest.indexRewritten) {
    const haveSource = await pathExists(sourceIndexPath);
    const haveDest = await pathExists(destIndexPath);
    if (haveSource || haveDest) {
      // Read each (if present).
      let destEntries: unknown[] = [];
      let destVersion: number | undefined;
      if (haveDest) {
        try {
          const rawDest = await fsp.readFile(destIndexPath, "utf8");
          const parsed = JSON.parse(rawDest) as { version?: unknown; entries?: unknown };
          if (Array.isArray(parsed.entries)) destEntries = parsed.entries;
          if (typeof parsed.version === "number") destVersion = parsed.version;
        } catch {
          // Malformed destination index — treat as no entries.
        }
      }
      mergedExisting = destEntries.length;

      let migratedEntries: unknown[] = [];
      let sourceVersion: number | undefined;
      if (haveSource) {
        try {
          const rawSource = await fsp.readFile(sourceIndexPath, "utf8");
          const rewritten = rewriteSessionsIndexEntries(
            rawSource,
            p.oldPath,
            p.newPath,
            p.oldEncoded,
            p.newEncoded,
          );
          migratedEntries = rewritten.entries as unknown[];
          sourceVersion = rewritten.version;
          for (const w of rewritten.warnings) {
            io.stderr.write(
              `ccr: warning — sessions-index entry[${w.entryIndex}].${w.field} = "${w.observed}" did not match OLD or NEW (left as-is).\n`,
            );
          }
        } catch {
          // Malformed source index — skip; the merge still proceeds.
        }
      }
      mergedMigrated = migratedEntries.length;

      const version =
        typeof destVersion === "number" && typeof sourceVersion === "number"
          ? Math.max(destVersion, sourceVersion)
          : (destVersion ?? sourceVersion ?? 1);

      const mergedIndex = {
        version,
        originalPath: p.newPath,
        entries: [...destEntries, ...migratedEntries],
      };
      await atomicWrite(destIndexPath, JSON.stringify(mergedIndex, null, 2));
    }
    manifest.indexRewritten = true;
    await atomicWrite(p.manifestPath, JSON.stringify(manifest, null, 2));
  }

  // Clean up the source manifest. Source folder itself is kept intact.
  await fsp.unlink(p.manifestPath).catch(() => {});

  io.stdout.write(
    `Merged ${copiedCount} file(s) from ${p.oldEncoded} into ${p.newEncoded} ` +
      `(${totalOccurrences} total substitutions).\n`,
  );
  if (mergedExisting > 0 || mergedMigrated > 0) {
    io.stdout.write(
      `Sessions-index merged: ${mergedExisting} existing + ${mergedMigrated} migrated = ${mergedExisting + mergedMigrated} entries.\n`,
    );
  }
  io.stdout.write(
    `Source folder ${p.oldEncoded} left intact. ` +
      `Run \`claude\` in ${path.normalize(p.oldPath)} to continue using its history independently.\n`,
  );
  // Note: mergeInfo's count of destination jsonls preserved is reported in the
  // dry-run preview, not the success summary, since the destination's files
  // are unchanged by the merge.
  void merge;
  return 0;
}

function sourceToDestPath(sourcePath: string, oldFolder: string, newFolder: string): string {
  const rel = path.relative(oldFolder, sourcePath);
  return path.join(newFolder, rel);
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

interface MergeInfo {
  // jsonl files already in the destination, untouched by the merge but
  // counted in the preview so the user knows what's preserved.
  destJsonls: string[];
  // Destination jsonls that would collide with the source's destPaths
  // (same relative basename + subpath). Astronomically unlikely for UUID-
  // named files but failing loudly is the right move.
  collisions: string[];
}

async function prepareMergeInfo(
  oldFolder: string,
  newFolder: string,
  sourceIntendedFiles: string[],
): Promise<MergeInfo> {
  const destJsonls: string[] = [];
  for await (const f of walkJsonl(newFolder)) destJsonls.push(f);
  destJsonls.sort();

  const collisions: string[] = [];
  for (const src of sourceIntendedFiles) {
    const dest = sourceToDestPath(src, oldFolder, newFolder);
    try {
      await fsp.stat(dest);
      collisions.push(dest);
    } catch {
      // No collision; expected case.
    }
  }
  return { destJsonls, collisions };
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
  mode: ApplyMode;
  mergeInfo: MergeInfo | null;
  oldSubstringOfNew: OldSubstringOfNewInfo;
  backupInfo: BackupInfo | null;
  isApply: boolean;
  hasSessionsIndex: boolean;
}

function emitPreview(stream: NodeJS.WritableStream, args: PreviewArgs): void {
  const tag = args.isApply ? "[apply preview]" : "[dry-run]";
  stream.write(`${tag} OLD: ${path.normalize(args.oldPath)}\n`);
  stream.write(`${tag} NEW: ${path.normalize(args.newPath)}\n`);
  if (args.mode === "merge") {
    stream.write(
      `${tag} MERGE mode: destination ${args.newFolder} already exists.\n`,
    );
    stream.write(
      `${tag} Source folder ${args.oldFolder} will be kept intact.\n`,
    );
    if (args.mergeInfo) {
      stream.write(
        `${tag} Destination has ${args.mergeInfo.destJsonls.length} existing file(s); migration will add ${args.preview.files.length} file(s) from source.\n`,
      );
    }
  } else {
    stream.write(`${tag} RENAME mode: ${args.oldFolder} -> ${args.newFolder}\n`);
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
    if (args.mode === "merge") {
      const dest = sourceToDestPath(f.path, args.oldFolder, args.newFolder);
      stream.write(`${tag}   ${f.path} -> ${dest}: ${f.occurrences} occurrence(s)\n`);
    } else {
      stream.write(`${tag}   ${f.path}: ${f.occurrences} occurrence(s)\n`);
    }
  }
  if (args.hasSessionsIndex) {
    if (args.mode === "merge") {
      stream.write(
        `${tag} sessions-index.json: source's entries will be concatenated into destination's index.\n`,
      );
    } else {
      stream.write(
        `${tag} sessions-index.json: will rewrite originalPath / projectPath / fullPath\n`,
      );
    }
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
      typeof obj.folderRenamed === "boolean" &&
      // mode is optional for backward compat — legacy manifests are "rename"
      (obj.mode === undefined || obj.mode === "rename" || obj.mode === "merge")
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
