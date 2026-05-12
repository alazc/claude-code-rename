import { promises as fs } from "node:fs";
import * as path from "node:path";

export type Orphan = {
  encodedFolder: string;
  originalPath: string;
  source: "sessions-index" | "jsonl-cwd";
  parentExists: boolean;
  sessionCount: number;
  sizeBytes: number;
};

export type Skipped = { encodedFolder: string; reason: string };

export type ScanResult = {
  orphans: Orphan[];
  skipped: Skipped[];
};

type CwdResult =
  | { ok: true; cwd: string; source: "sessions-index" | "jsonl-cwd" }
  | { ok: false; reason: string }
  | { ok: "not-found" };

const SESSIONS_INDEX = "sessions-index.json";

export async function scanOrphans(claudeDataRoot: string): Promise<ScanResult> {
  const orphans: Orphan[] = [];
  const skipped: Skipped[] = [];
  const projectsDir = path.join(claudeDataRoot, "projects");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { orphans, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith(".")) continue; // skip dotfile/infrastructure folders

    const folderPath = path.join(projectsDir, name);
    try {
      const cwdResult = await resolveClaimedCwd(folderPath);
      if (cwdResult.ok === "not-found") {
        skipped.push({ encodedFolder: name, reason: "no-cwd-found" });
        continue;
      }
      if (cwdResult.ok === false) {
        skipped.push({ encodedFolder: name, reason: cwdResult.reason });
        continue;
      }

      const claimedCwd = cwdResult.cwd;
      if (await pathExists(claimedCwd)) {
        // Resolved -> not an orphan, skip silently.
        continue;
      }

      const parentExists = await computeParentExists(claimedCwd);
      const sessionCount = await countTopLevelJsonl(folderPath);
      const sizeBytes = await sumJsonlBytes(folderPath);

      orphans.push({
        encodedFolder: name,
        originalPath: claimedCwd,
        source: cwdResult.source,
        parentExists,
        sessionCount,
        sizeBytes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ encodedFolder: name, reason: `error: ${msg}` });
    }
  }

  return { orphans, skipped };
}

async function resolveClaimedCwd(folderPath: string): Promise<CwdResult> {
  const indexPath = path.join(folderPath, SESSIONS_INDEX);
  let indexStat: import("node:fs").Stats | null = null;
  try {
    indexStat = await fs.stat(indexPath);
  } catch {
    indexStat = null;
  }

  if (indexStat && indexStat.isFile()) {
    const raw = await fs.readFile(indexPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "malformed-sessions-index" };
    }
    const original = readOriginalPath(parsed);
    if (typeof original === "string" && original.length > 0) {
      return { ok: true, cwd: original, source: "sessions-index" };
    }
    // Fall through to jsonl scan if index is well-formed but lacks originalPath.
  } else if (indexStat && !indexStat.isFile()) {
    // Index path exists but isn't a regular file (e.g. directory) — surface as error.
    throw new Error(`${SESSIONS_INDEX} is not a regular file`);
  }

  const jsonlFiles = await collectJsonlFiles(folderPath);
  for (const jsonlPath of jsonlFiles) {
    const cwd = await firstCwdFromJsonl(jsonlPath);
    if (cwd !== null) {
      return { ok: true, cwd, source: "jsonl-cwd" };
    }
  }
  return { ok: "not-found" };
}

function readOriginalPath(value: unknown): string | undefined {
  if (value && typeof value === "object" && "originalPath" in value) {
    const v = (value as { originalPath: unknown }).originalPath;
    if (typeof v === "string") return v;
  }
  return undefined;
}

async function collectJsonlFiles(folderPath: string): Promise<string[]> {
  const out: string[] = [];
  const top = await fs.readdir(folderPath, { withFileTypes: true });
  for (const e of top) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(path.join(folderPath, e.name));
    }
  }
  // Then look for <uuid>/subagents/*.jsonl
  for (const e of top) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    const subagentsDir = path.join(folderPath, e.name, "subagents");
    let subEntries: import("node:fs").Dirent[];
    try {
      subEntries = await fs.readdir(subagentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const se of subEntries) {
      if (se.isFile() && se.name.endsWith(".jsonl")) {
        out.push(path.join(subagentsDir, se.name));
      }
    }
  }
  return out;
}

async function firstCwdFromJsonl(jsonlPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function computeParentExists(p: string): Promise<boolean> {
  const parent = path.dirname(p);
  // Treat root paths as having no parent (per design edge case for "/" and "C:\").
  if (parent === p) return false;
  return pathExists(parent);
}

async function countTopLevelJsonl(folderPath: string): Promise<number> {
  let n = 0;
  const top = await fs.readdir(folderPath, { withFileTypes: true });
  for (const e of top) {
    if (e.isFile() && e.name.endsWith(".jsonl")) n++;
  }
  return n;
}

async function sumJsonlBytes(folderPath: string): Promise<number> {
  const files = await collectJsonlFiles(folderPath);
  let total = 0;
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      total += st.size;
    } catch {
      // Best-effort: skip files we can't stat.
    }
  }
  return total;
}
